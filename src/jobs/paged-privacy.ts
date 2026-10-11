import { DataSubjectError, DataSubjectErrorCode } from '../errors';
import { sha256Hex } from '../artifacts';
import { classifyPolicy, fingerprint, hashRegistryPolicy } from '../erasure-plan';
import { parsePrismaSchema } from '../lint/prisma-schema';
import type { Registry } from '../registry';
import { validateRegistry } from '../registry-validation';
import { stableStringify } from '../stable-json';
import { matchesReplacement } from '../value-verification';
import type { EntityVerification, RegisteredEntity, TenantScope } from '../types';
import type { JobHandler, JobJson, JobRecord } from './types';

export type PagedId = string | number;
export interface PagedReadInput {
  subjectId: string;
  tenantId: string;
  after?: PagedId;
  through: PagedId;
  limit: number;
  fields?: string[];
}
/** Every method must use the same transaction connection as its JobTransaction. */
export interface PagedEntityExecutor {
  identityField: string;
  scope: TenantScope;
  highWatermark(input: { subjectId: string; tenantId: string }): Promise<PagedId | null>;
  readPage(input: PagedReadInput): Promise<Record<string, unknown>[]>;
  selectByIds(ids: PagedId[], tenantId: string, fields?: string[]): Promise<Record<string, unknown>[]>;
  eraseByIds(ids: PagedId[], tenantId: string): Promise<number>;
  updateByIds(ids: PagedId[], tenantId: string, replacements: Record<string, unknown>): Promise<number>;
}

export const PAGED_PRIVACY_JOB_KIND = 'data-subject.privacy';
export interface PagedPrivacyPayload {
  schemaVersion: 'data-subject.paged-privacy.v1';
  type: 'erase' | 'export';
  subjectId: string;
  policyHash: string;
}

export interface PagedPrivacyOptions {
  registry: Registry;
  schemaSource: string;
  /** Unregistered models reviewed as out of scope; relation checks still inspect them. */
  excludedModels?: Record<string, string>;
  executors: Record<string, PagedEntityExecutor>;
  batchSize?: number;
  maxChunkBytes?: number;
}

interface Checkpoint {
  schemaVersion: 'data-subject.paged-checkpoint.v1';
  jobId: string;
  tenantId: string;
  payloadHash: string;
  pagesCommitted: number;
  policyHash: string;
  entityIndex: number;
  cursor: PagedId | null;
  scopes: Array<{ entityName: string; through: PagedId | null; processedRows: number }>;
}

export function createPagedPrivacyPayload(input: {
  type: 'erase' | 'export'; subjectId: string; registry: Registry;
}): PagedPrivacyPayload & { [key: string]: JobJson } {
  if (!['erase', 'export'].includes(input.type) || !isIdentifier(input.subjectId)) invalidInput();
  return { schemaVersion: 'data-subject.paged-privacy.v1', type: input.type, subjectId: input.subjectId, policyHash: hashRegistryPolicy(input.registry) };
}

/**
 * Bounded privacy processing for independent, relation-free models only.
 * Upper bounds are fixed for every entity in the first transaction; this is not a
 * cross-page DB snapshot. Inserts below a bound and updates after a page commits
 * can change the scope. Cancellation never undoes an already committed page.
 */
export function createPagedPrivacyHandler(options: PagedPrivacyOptions): JobHandler {
  const batchSize = options.batchSize ?? 500;
  const maxChunkBytes = options.maxChunkBytes ?? 1_048_576;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000 ||
    !Number.isSafeInteger(maxChunkBytes) || maxChunkBytes < 1 || maxChunkBytes > 16_777_216) invalidInput();
  const entries = options.registry.list();
  const policyHash = hashRegistryPolicy(options.registry);
  validateIndependentModels(options, entries);
  const executors = entries.map(entry => freezeExecutor(options.executors[entry.policy.entityName], entry));

  return async ({ job, appendChunk }) => {
    const payload = parsePayload(job.payload);
    // Payload has an exact scalar-only shape, matching the store's canonical JSON.
    if (sha256Hex(stableStringify(payload)) !== job.payloadHash) invalidInput();
    if (job.kind !== PAGED_PRIVACY_JOB_KIND || !isIdentifier(job.tenantId) || job.chunksDeletedAt || job.purgedAt) invalidInput();
    if (payload.policyHash !== policyHash || hashRegistryPolicy(options.registry) !== policyHash) {
      throw new DataSubjectError(DataSubjectErrorCode.PlanMismatch, 'Paged job policy changed');
    }
    for (const executor of executors) {
      if (executor.scope.mode === 'single-tenant' && executor.scope.tenantId !== job.tenantId) {
        throw new DataSubjectError(DataSubjectErrorCode.InvalidScope);
      }
    }
    if (job.checkpoint === null && (job.pagesCommitted !== 0 || job.processedRows !== 0)) invalidInput();
    const checkpoint = job.checkpoint === null
      ? await initialCheckpoint(entries, executors, payload, job)
      : parseCheckpoint(job.checkpoint, entries, policyHash, job);
    if (checkpoint.entityIndex === entries.length) {
      checkpoint.pagesCommitted += 1;
      return { done: true, checkpoint: asJson(checkpoint), processedRows: 0, result: resultSummary(payload, checkpoint) };
    }
    const index = checkpoint.entityIndex;
    const entry = entries[index];
    const executor = executors[index];
    const scope = checkpoint.scopes[index];
    const fields = requiredFields(entry, executor, payload.type);
    const rows = scope.through === null ? [] : await executor.readPage({
      subjectId: payload.subjectId,
      tenantId: job.tenantId,
      through: scope.through,
      ...(checkpoint.cursor === null ? {} : { after: checkpoint.cursor }),
      limit: batchSize,
      fields,
    });
    const ids = validatePage(rows, batchSize, entry, executor, payload, job.tenantId, checkpoint.cursor, scope.through, fields);
    let hasCommittedChanges = false;
    let chunk: Buffer | undefined;
    if (rows.length > 0) {
      if (payload.type === 'export') {
        chunk = encodeNdjson(rows.map(row => ({
          entityName: entry.policy.entityName,
          data: Object.fromEntries(entry.policy.exportFields.map(field => [field, row[field]])),
        })), maxChunkBytes);
      } else {
        const outcome = classifyPolicy(entry.policy);
        if (outcome.effectiveRowStrategy === 'update-fields' && (
          Object.hasOwn(outcome.updateMap, executor.identityField) ||
          (executor.scope.mode === 'multi-tenant' && Object.hasOwn(outcome.updateMap, executor.scope.tenantField))
        )) throw new DataSubjectError(DataSubjectErrorCode.InvalidPolicy, 'Paged writes must preserve identity and tenant scope');
        const before = rows.map(row => ({
          identity: fingerprint(row[executor.identityField]),
          values: Object.fromEntries(Object.keys(entry.policy.fields).map(field => [field, fingerprint(row[field])])),
        }));
        // Confirm the ID lookup is functional before a row deletion can hide that defect.
        const lookup = await executor.selectByIds(ids, job.tenantId, fields);
        assertLookup(before, lookup, entry, executor, job.tenantId);
        if (outcome.effectiveRowStrategy === 'delete-row') {
          await executor.eraseByIds(ids, job.tenantId);
          hasCommittedChanges = true;
        } else if (outcome.effectiveRowStrategy === 'update-fields') {
          await executor.updateByIds(ids, job.tenantId, outcome.updateMap);
          hasCommittedChanges = true;
        }
        const after = await executor.selectByIds(ids, job.tenantId, fields);
        const verification = verifyPage(before, after, entry, executor, job.tenantId);
        chunk = encodeNdjson([{
          schemaVersion: 'data-subject.paged-evidence.v1',
          entityName: entry.policy.entityName,
          policyHash,
          scope: 'original-page-identities',
          effectiveRowStrategy: outcome.effectiveRowStrategy,
          processedRows: rows.length,
          verification,
        }], maxChunkBytes);
      }
      await appendChunk(chunk);
      scope.processedRows += rows.length;
      checkpoint.cursor = ids[ids.length - 1];
    }
    if (rows.length < batchSize || scope.through === null || checkpoint.cursor === scope.through) {
      checkpoint.entityIndex += 1;
      checkpoint.cursor = null;
    }
    const done = checkpoint.entityIndex === entries.length;
    checkpoint.pagesCommitted += 1;
    return {
      done,
      checkpoint: asJson(checkpoint),
      processedRows: rows.length,
      hasCommittedChanges,
      ...(done ? { result: resultSummary(payload, checkpoint) } : {}),
    };
  };
}

function validateIndependentModels(options: PagedPrivacyOptions, entries: RegisteredEntity[]): void {
  let models: ReturnType<typeof parsePrismaSchema>;
  try { models = parsePrismaSchema(options.schemaSource); }
  catch { throw new DataSubjectError(DataSubjectErrorCode.InvalidPolicy, 'Paged execution requires a supported Prisma schema'); }
  const names = new Set(entries.map(entry => entry.policy.entityName));
  if (options.excludedModels !== undefined && (!options.excludedModels || typeof options.excludedModels !== 'object' || Array.isArray(options.excludedModels))) {
    throw new DataSubjectError(DataSubjectErrorCode.InvalidPolicy, 'excludedModels requires model names and nonblank reasons');
  }
  const suppressions = Object.entries(options.excludedModels ?? {}).map(([model, reason]) => {
    if (!models.some(item => item.name === model) || names.has(model) || !isIdentifier(reason)) {
      throw new DataSubjectError(DataSubjectErrorCode.InvalidPolicy, 'Only known unregistered models can be excluded with a nonblank reason');
    }
    return { model, reason };
  });
  const report = validateRegistry(options.registry, { schemaSource: options.schemaSource, strictCoverage: true, suppressions });
  if (!report.ok) throw new DataSubjectError(DataSubjectErrorCode.InvalidPolicy, 'Paged execution requires valid shared schema policies');
  for (const model of models) {
    for (const field of model.fields) {
      if (field.kind === 'relation' && (names.has(model.name) || names.has(field.baseType))) {
        throw new DataSubjectError(DataSubjectErrorCode.InvalidPolicy, 'Paged execution does not support relations involving registered entities');
      }
    }
  }
  for (const entry of entries) {
    const executor = options.executors[entry.policy.entityName];
    const model = models.find(item => item.name === entry.policy.entityName);
    const identities = model?.fields.filter(field => field.isId) ?? [];
    if (!executor || identities.length !== 1 || identities[0].name !== executor.identityField ||
      !['String', 'Int'].includes(identities[0].baseType) || identities[0].optional || identities[0].list ||
      entry.policy.dependsOn?.length) {
      throw new DataSubjectError(DataSubjectErrorCode.InvalidPolicy, 'Paged execution requires an independent model with one String or Int primary key');
    }
  }
}

function freezeExecutor(executor: PagedEntityExecutor, entry: RegisteredEntity): PagedEntityExecutor {
  if (!executor || !isIdentifier(executor.identityField) || executor.identityField !== entry.executor.identityField ||
    fingerprint(executor.scope) !== fingerprint(entry.executor.scope) ||
    (entry.policy.stableIdField !== undefined && executor.identityField !== entry.policy.stableIdField)) {
    throw new DataSubjectError(DataSubjectErrorCode.InvalidPolicy, 'Paged executor identity and tenant scope must match the registry');
  }
  for (const method of ['highWatermark', 'readPage', 'selectByIds', 'eraseByIds', 'updateByIds'] as const) {
    if (typeof executor[method] !== 'function') throw new DataSubjectError(DataSubjectErrorCode.InvalidPolicy, 'Incomplete paged executor');
  }
  return Object.freeze({
    identityField: executor.identityField,
    scope: Object.freeze({ ...executor.scope }),
    highWatermark: executor.highWatermark.bind(executor),
    readPage: executor.readPage.bind(executor),
    selectByIds: executor.selectByIds.bind(executor),
    eraseByIds: executor.eraseByIds.bind(executor),
    updateByIds: executor.updateByIds.bind(executor),
  });
}

async function initialCheckpoint(entries: RegisteredEntity[], executors: PagedEntityExecutor[], payload: PagedPrivacyPayload, job: JobRecord): Promise<Checkpoint> {
  const scopes: Checkpoint['scopes'] = [];
  for (const [index, entry] of entries.entries()) {
    const through = payload.type === 'export' && entry.policy.exportFields.length === 0
      ? null : await executors[index].highWatermark({ subjectId: payload.subjectId, tenantId: job.tenantId });
    if (through !== null && !isPagedId(through)) invalidInput();
    scopes.push({ entityName: entry.policy.entityName, through, processedRows: 0 });
  }
  return { schemaVersion: 'data-subject.paged-checkpoint.v1', jobId: job.id, tenantId: job.tenantId, payloadHash: job.payloadHash,
    pagesCommitted: 0, policyHash: payload.policyHash, entityIndex: 0, cursor: null, scopes };
}

function requiredFields(entry: RegisteredEntity, executor: PagedEntityExecutor, type: 'erase' | 'export'): string[] {
  return [...new Set([
    executor.identityField, entry.policy.subjectField,
    ...(executor.scope.mode === 'multi-tenant' ? [executor.scope.tenantField] : []),
    ...(type === 'export' ? entry.policy.exportFields : Object.keys(entry.policy.fields)),
  ])];
}

function validatePage(rows: Record<string, unknown>[], limit: number, entry: RegisteredEntity, executor: PagedEntityExecutor,
  payload: PagedPrivacyPayload, tenantId: string, after: PagedId | null, through: PagedId | null, fields: string[]): PagedId[] {
  if (!Array.isArray(rows) || rows.length > limit) invalidInput();
  const ids: PagedId[] = [];
  for (const row of rows) {
    const id = row[executor.identityField];
    if (!isPagedId(id) || typeof id !== typeof through || id === after || fields.some(field => !Object.hasOwn(row, field)) ||
      row[entry.policy.subjectField] !== payload.subjectId ||
      (executor.scope.mode === 'multi-tenant' && row[executor.scope.tenantField] !== tenantId)) {
      throw new DataSubjectError(DataSubjectErrorCode.VerificationUnavailable, 'Paged executor returned an invalid or out-of-scope row');
    }
    const previous = ids.length ? ids[ids.length - 1] : after;
    if (typeof id === 'number' && ((typeof previous === 'number' && id <= previous) || (typeof through === 'number' && id > through))) invalidInput();
    ids.push(id);
  }
  if (new Set(ids).size !== ids.length) invalidInput();
  return ids;
}

type BeforeRow = { identity: string; values: Record<string, string> };
function lookupRows(rows: Record<string, unknown>[], executor: PagedEntityExecutor, tenantId: string): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    if (!isPagedId(row[executor.identityField]) || (executor.scope.mode === 'multi-tenant' && row[executor.scope.tenantField] !== tenantId)) verificationFailed();
    const identity = fingerprint(row[executor.identityField]);
    if (map.has(identity)) verificationFailed();
    map.set(identity, row);
  }
  return map;
}
function assertLookup(before: BeforeRow[], rows: Record<string, unknown>[], entry: RegisteredEntity, executor: PagedEntityExecutor, tenantId: string): void {
  const map = lookupRows(rows, executor, tenantId);
  if (map.size !== before.length) throw new DataSubjectError(DataSubjectErrorCode.VerificationUnavailable);
  for (const original of before) {
    const row = map.get(original.identity);
    if (!row || Object.keys(entry.policy.fields).some(field => !Object.hasOwn(row, field) || fingerprint(row[field]) !== original.values[field])) {
      throw new DataSubjectError(DataSubjectErrorCode.VerificationUnavailable);
    }
  }
}
function verifyPage(before: BeforeRow[], rows: Record<string, unknown>[], entry: RegisteredEntity, executor: PagedEntityExecutor, tenantId: string): EntityVerification {
  const outcome = classifyPolicy(entry.policy);
  const map = lookupRows(rows, executor, tenantId);
  if (outcome.effectiveRowStrategy === 'delete-row') {
    if (map.size > 0) verificationFailed();
  } else {
    if (map.size !== before.length) verificationFailed();
    for (const original of before) {
      const row = map.get(original.identity);
      if (!row) verificationFailed();
      for (const [field, raw] of Object.entries(entry.policy.fields)) {
        const rule = raw === 'delete' ? { strategy: 'delete' } : raw;
        const matches = rule.strategy === 'retain'
          ? fingerprint(row[field]) === original.values[field]
          : matchesReplacement(row[field], outcome.updateMap[field]);
        if (!Object.hasOwn(row, field) || !matches) verificationFailed();
      }
    }
  }
  return {
    status: 'verified', checkedRows: before.length,
    fields: Object.entries(entry.policy.fields).map(([field, raw]) => ({ field, strategy: raw === 'delete' ? 'delete' : raw.strategy, checked: before.length, status: 'verified' })),
  };
}

function parsePayload(value: JobJson): PagedPrivacyPayload {
  if (!isObject(value) || value.schemaVersion !== 'data-subject.paged-privacy.v1' || !['erase', 'export'].includes(String(value.type)) ||
    !isIdentifier(value.subjectId) || typeof value.policyHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.policyHash) ||
    Object.keys(value).some(key => !['schemaVersion', 'type', 'subjectId', 'policyHash'].includes(key))) invalidInput();
  return value as unknown as PagedPrivacyPayload;
}
function parseCheckpoint(value: JobJson, entries: RegisteredEntity[], policyHash: string, job: JobRecord): Checkpoint {
  if (!isObject(value) || value.schemaVersion !== 'data-subject.paged-checkpoint.v1' || value.policyHash !== policyHash ||
    !Number.isSafeInteger(value.entityIndex) || typeof value.entityIndex !== 'number' || value.entityIndex < 0 || value.entityIndex > entries.length ||
    (value.cursor !== null && !isPagedId(value.cursor)) || !Array.isArray(value.scopes) || value.scopes.length !== entries.length) invalidInput();
  if (job.pagesCommitted < 1 || value.jobId !== job.id || value.tenantId !== job.tenantId || value.payloadHash !== job.payloadHash ||
    value.pagesCommitted !== job.pagesCommitted) invalidInput();
  let processedRows = 0;
  for (const [index, scope] of value.scopes.entries()) {
    if (!isObject(scope) || scope.entityName !== entries[index].policy.entityName || (scope.through !== null && !isPagedId(scope.through)) ||
      typeof scope.processedRows !== 'number' || !Number.isSafeInteger(scope.processedRows) || scope.processedRows < 0) invalidInput();
    processedRows += scope.processedRows;
  }
  if (!Number.isSafeInteger(processedRows) || processedRows !== job.processedRows) invalidInput();
  const active = value.scopes[value.entityIndex];
  if (value.entityIndex === entries.length && value.cursor !== null) invalidInput();
  if (value.cursor !== null && isObject(active) && (typeof value.cursor !== typeof active.through ||
    (typeof value.cursor === 'number' && typeof active.through === 'number' && value.cursor > active.through))) invalidInput();
  return JSON.parse(JSON.stringify(value)) as Checkpoint;
}
function resultSummary(payload: PagedPrivacyPayload, checkpoint: Checkpoint): JobJson {
  return { schemaVersion: 'data-subject.paged-result.v1', type: payload.type, policyHash: payload.policyHash,
    scope: 'per-entity-high-watermark', snapshot: false,
    verification: payload.type === 'erase' ? 'verified-per-batch' : 'export-allowlist',
    entities: checkpoint.scopes.map(scope => ({ entityName: scope.entityName, processedRows: scope.processedRows })) };
}
function encodeNdjson(records: unknown[], maxBytes: number): Buffer {
  const parts: Buffer[] = [];
  let bytes = 0;
  for (const record of records) {
    const encoded = Buffer.from(JSON.stringify(record, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value) + '\n', 'utf8');
    bytes += encoded.length;
    if (bytes > maxBytes) throw new DataSubjectError(DataSubjectErrorCode.InvalidInput, 'Privacy chunk exceeds maxChunkBytes');
    parts.push(encoded);
  }
  return Buffer.concat(parts, bytes);
}
function isObject(value: unknown): value is Record<string, JobJson> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function isIdentifier(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function isPagedId(value: unknown): value is PagedId { return isIdentifier(value) || (typeof value === 'number' && Number.isSafeInteger(value)); }
function asJson(value: Checkpoint): JobJson { return JSON.parse(JSON.stringify(value)) as JobJson; }
function invalidInput(): never { throw new DataSubjectError(DataSubjectErrorCode.InvalidInput, 'Invalid paged privacy input or checkpoint'); }
function verificationFailed(): never { throw new DataSubjectError(DataSubjectErrorCode.VerificationFailed, 'Paged verification failed'); }
