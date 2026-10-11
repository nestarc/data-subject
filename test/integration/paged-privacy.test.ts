import { Decimal } from '@prisma/client/runtime/library';
import { DataSubjectErrorCode } from '../../src/errors';
import { sha256Hex } from '../../src/artifacts';
import { stableStringify } from '../../src/stable-json';
import { createPagedPrivacyHandler, createPagedPrivacyPayload, PAGED_PRIVACY_JOB_KIND, type PagedEntityExecutor, type PagedId } from '../../src/jobs/paged-privacy';
import type { JobJson, JobRecord } from '../../src/jobs/types';
import type { EntityDefinition } from '../../src/policy-definition';
import { Registry } from '../../src/registry';
import type { EntityExecutor, PolicyEntry } from '../../src/types';

const schema = `model Item {
  id Int @id
  tenantId String
  subjectId String
  email String?
  total Int
  passwordHash String
}`;
type Row = Record<string, unknown>;
function fixture(options: { type?: 'erase' | 'export'; size?: number; batchSize?: number; rowDelete?: boolean; subjectRule?: PolicyEntry; maxChunkBytes?: number; exportFields?: string[] } = {}) {
  const rows: Row[] = Array.from({ length: options.size ?? 5 }, (_, index) => ({
    id: index + 1, tenantId: 't1', subjectId: 's1', email: `person${index}@example.com`, total: index, passwordHash: `secret-${index}`,
  }));
  rows.push({ id: 100, tenantId: 't2', subjectId: 's1', email: 'other@example.com', total: 100, passwordHash: 'other-secret' });
  const state = { rows, noOp: false, corruptRetain: false };
  const selectFields = (row: Row, fields?: string[]): Row => fields ? Object.fromEntries(fields.map(field => [field, row[field]])) : { ...row };
  const paged: PagedEntityExecutor = {
    identityField: 'id', scope: { mode: 'multi-tenant', tenantField: 'tenantId' },
    highWatermark: jest.fn(async ({ subjectId, tenantId }) => {
      const selected = state.rows.filter(row => row.subjectId === subjectId && row.tenantId === tenantId);
      return selected.length ? Math.max(...selected.map(row => row.id as number)) : null;
    }),
    readPage: jest.fn(async ({ subjectId, tenantId, after, through, limit, fields }) => state.rows
      .filter(row => row.subjectId === subjectId && row.tenantId === tenantId && (after === undefined || (row.id as number) > (after as number)) && (row.id as number) <= (through as number))
      .sort((left, right) => (left.id as number) - (right.id as number)).slice(0, limit).map(row => selectFields(row, fields))),
    selectByIds: jest.fn(async (ids, tenantId, fields) => state.rows.filter(row => row.tenantId === tenantId && ids.includes(row.id as PagedId)).map(row => selectFields(row, fields))),
    eraseByIds: jest.fn(async (ids, tenantId) => {
      if (state.noOp) return 0;
      const selected = state.rows.filter(row => row.tenantId === tenantId && ids.includes(row.id as PagedId));
      state.rows = state.rows.filter(row => !selected.includes(row));
      return selected.length;
    }),
    updateByIds: jest.fn(async (ids, tenantId, replacements) => {
      if (state.noOp) return 0;
      const selected = state.rows.filter(row => row.tenantId === tenantId && ids.includes(row.id as PagedId));
      for (const row of selected) {
        Object.assign(row, replacements);
        if (state.corruptRetain) row.total = -1;
      }
      return selected.length;
    }),
  };
  const full: EntityExecutor = {
    identityField: 'id', scope: paged.scope,
    select: jest.fn(async () => { throw new Error('unbounded select forbidden'); }),
    selectByIds: jest.fn(async () => { throw new Error('unbounded verification forbidden'); }),
    erase: jest.fn(async () => { throw new Error('whole subject erase forbidden'); }),
    anonymize: jest.fn(async () => { throw new Error('whole subject update forbidden'); }),
  };
  const definition: EntityDefinition = {
    entityName: 'Item', subjectField: 'subjectId', stableIdField: 'id', scope: paged.scope,
    rowLevel: options.rowDelete ? 'delete-row' : 'delete-fields',
    fields: {
      email: 'delete',
      ...(options.rowDelete ? {} : { total: { strategy: 'retain', legalBasis: 'tax:KR-basic-law-sec85' } as const }),
      ...(options.subjectRule ? { subjectId: options.subjectRule } : {}),
    },
    ignoredFields: { id: 'Stable row identity', tenantId: 'Tenant boundary', passwordHash: 'Test secret excluded from export',
      ...(options.subjectRule ? {} : { subjectId: 'Request scope key' }),
      ...(options.rowDelete ? { total: 'Removed with the whole row' } : {}),
    },
    exportFields: options.exportFields ?? ['id', 'email', 'total'],
  };
  const registry = new Registry();
  registry.registerDefinition(definition, full);
  const handlerOptions = { registry, schemaSource: schema, executors: { Item: paged }, batchSize: options.batchSize ?? 2, maxChunkBytes: options.maxChunkBytes };
  const handler = createPagedPrivacyHandler(handlerOptions);
  const payload = createPagedPrivacyPayload({ type: options.type ?? 'erase', subjectId: 's1', registry });
  const job: JobRecord = {
    id: 'job', tenantId: 't1', kind: PAGED_PRIVACY_JOB_KIND, idempotencyKey: 'key',
    payload, payloadHash: sha256Hex(stableStringify(payload)),
    state: 'queued', checkpoint: null, result: null, processedRows: 0, pagesCommitted: 0, chunksWritten: 0,
    attempts: 0, revision: 0, hasCommittedChanges: false, partial: false, lastError: null,
    createdAt: new Date(), updatedAt: new Date(), availableAt: new Date(), completedAt: null, chunksDeletedAt: null,
    expiresAt: new Date(Date.now() + 60_000), purgedAt: null,
  };
  const chunks: Buffer[] = [];
  async function step() {
    const beforeRows = structuredClone(state.rows);
    const beforeChunks = chunks.length;
    try {
      const result = await handler({ job, appendChunk: async chunk => { chunks.push(Buffer.from(chunk)); } });
      job.checkpoint = result.checkpoint;
      job.processedRows += result.processedRows;
      job.pagesCommitted += 1;
      job.chunksWritten = chunks.length;
      job.hasCommittedChanges ||= result.hasCommittedChanges ?? false;
      if (result.done) { job.state = 'completed'; job.result = result.result ?? null; }
      return result;
    } catch (error) {
      state.rows = beforeRows;
      chunks.splice(beforeChunks);
      throw error;
    }
  }
  return { state, rows, paged, full, registry, definition, handlerOptions, handler, job, chunks, step };
}

const decode = (chunks: Buffer[]) => chunks.flatMap(chunk => chunk.toString('utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>));

describe('paged privacy handler', () => {
  describe('Prisma scalar replacement verification', () => {
    function scalarFixture(type: string, initial: unknown, stored: unknown, policy: PolicyEntry) {
      const base = fixture({ size: 1 });
      base.state.rows[0].value = initial;
      base.paged.updateByIds = jest.fn(async (ids, tenantId, replacements) => {
        const selected = base.state.rows.filter(row => row.tenantId === tenantId && ids.includes(row.id as PagedId));
        for (const row of selected) Object.assign(row, replacements, { value: stored });
        return selected.length;
      });
      const registry = new Registry();
      registry.registerDefinition({ ...base.definition, fields: { ...base.definition.fields, value: policy } }, base.full);
      const handler = createPagedPrivacyHandler({
        ...base.handlerOptions, registry,
        schemaSource: schema.replace('total Int', `total Int\n  value ${type}?`),
      });
      const payload = createPagedPrivacyPayload({ type: 'erase', subjectId: 's1', registry });
      const job = { ...base.job, payload, payloadHash: sha256Hex(stableStringify(payload)) };
      const chunks: Buffer[] = [];
      return {
        chunks,
        run: () => handler({ job, appendChunk: async chunk => { chunks.push(Buffer.from(chunk)); } }),
      };
    }

    const conversions = [
      { label: 'ISO DateTime', type: 'DateTime', replacement: '2000-01-01T00:00:00.000Z', original: new Date('1999-01-01T00:00:00Z'), stored: new Date('2000-01-01T00:00:00Z') },
      { label: 'DateTime with timezone offset', type: 'DateTime', replacement: '2000-01-01T09:00:00+09:00', original: new Date('1999-01-01T00:00:00Z'), stored: new Date('2000-01-01T00:00:00Z') },
      { label: 'BigInt integer string', type: 'BigInt', replacement: '9007199254740993', original: 1n, stored: 9007199254740993n },
      { label: 'BigInt safe integer number', type: 'BigInt', replacement: 42, original: 1n, stored: 42n },
      { label: 'Decimal numeric string', type: 'Decimal', replacement: '123.4500', original: new Decimal('1'), stored: new Decimal('123.45') },
      { label: 'Decimal number', type: 'Decimal', replacement: 0.1, original: new Decimal('1'), stored: new Decimal('0.1') },
      { label: 'Decimal beyond Number precision', type: 'Decimal', replacement: '9007199254740993.0100', original: new Decimal('1'), stored: new Decimal('9007199254740993.01') },
    ];
    describe.each([false, true])('initially null: %s', initiallyNull => {
      it.each(conversions)('verifies converted $label', async ({ type, replacement, original, stored }) => {
        const { run, chunks } = scalarFixture(type, initiallyNull ? null : original, stored, { strategy: 'anonymize', replacement });
        await expect(run()).resolves.toMatchObject({ done: true, processedRows: 1 });
        expect(decode(chunks)).toEqual([expect.objectContaining({
          verification: expect.objectContaining({
            status: 'verified', checkedRows: 1,
            fields: expect.arrayContaining([{ field: 'value', strategy: 'anonymize', checked: 1, status: 'verified' }]),
          }),
        })]);
      });
    });

    it.each([
      { label: 'wrong DateTime instant', type: 'DateTime', replacement: '2000-01-01T00:00:00Z', stored: new Date('2000-01-01T00:00:01Z') },
      { label: 'non-ISO date coercion', type: 'DateTime', replacement: 'January 1, 2000', stored: new Date('2000-01-01T00:00:00Z') },
      { label: 'wrong BigInt', type: 'BigInt', replacement: '9007199254740993', stored: 9007199254740992n },
      { label: 'unsafe BigInt number', type: 'BigInt', replacement: Number.MAX_SAFE_INTEGER + 1, stored: BigInt(Number.MAX_SAFE_INTEGER + 1) },
      { label: 'rounded Decimal string', type: 'Decimal', replacement: '9007199254740993.01', stored: new Decimal('9007199254740993') },
      { label: 'imprecise Decimal number', type: 'Decimal', replacement: 0.1, stored: new Decimal('0.10000000000000000001') },
      { label: 'unconverted numeric string', type: 'Int', replacement: 42, stored: '42' },
    ])('rejects $label before writing evidence', async ({ type, replacement, stored }) => {
      const { run, chunks } = scalarFixture(type, null, stored, { strategy: 'anonymize', replacement });
      await expect(run()).rejects.toMatchObject({ code: DataSubjectErrorCode.VerificationFailed });
      expect(chunks).toEqual([]);
    });

    it.each([
      { type: 'DateTime', original: new Date('2000-01-01T00:00:00Z'), stored: '2000-01-01T00:00:00.000Z' },
      { type: 'BigInt', original: 42n, stored: '42' },
      { type: 'Decimal', original: new Decimal('123.45'), stored: '123.45' },
    ])('keeps retained $type comparisons type-sensitive', async ({ type, original, stored }) => {
      const { run, chunks } = scalarFixture(type, original, stored, { strategy: 'retain', legalBasis: 'tax:law' });
      await expect(run()).rejects.toMatchObject({ code: DataSubjectErrorCode.VerificationFailed });
      expect(chunks).toEqual([]);
    });
  });

  it('commits bounded verified pages, resumes the keyset cursor and never uses whole-subject operations', async () => {
    const { step, state, job, chunks, paged, full } = fixture();
    expect((await step()).done).toBe(false);
    expect(job.processedRows).toBe(2);
    expect(state.rows.filter(row => row.email === null)).toHaveLength(2);
    await step();
    expect((await step()).done).toBe(true);
    expect(job.processedRows).toBe(5);
    expect(job.hasCommittedChanges).toBe(true);
    expect(chunks).toHaveLength(3);
    expect(state.rows.find(row => row.tenantId === 't2')?.email).toBe('other@example.com');
    expect(paged.highWatermark).toHaveBeenCalledTimes(1);
    expect(paged.readPage).toHaveBeenNthCalledWith(2, expect.objectContaining({ after: 2, through: 5, limit: 2 }));
    for (const operation of [full.select, full.selectByIds, full.erase, full.anonymize]) expect(operation).not.toHaveBeenCalled();
    for (const evidence of decode(chunks)) expect(evidence).toMatchObject({ policyHash: expect.any(String), effectiveRowStrategy: 'update-fields', verification: { status: 'verified' } });
    expect(Buffer.concat(chunks).toString()).not.toContain('person');
    expect(Buffer.concat(chunks).toString()).not.toContain('secret');
  });

  it('uses original page IDs when the subject field is anonymized', async () => {
    const { step, state, job, paged } = fixture({ subjectRule: { strategy: 'anonymize', replacement: '[REDACTED]' } });
    while (job.state === 'queued') await step();
    expect(state.rows.filter(row => row.tenantId === 't1').every(row => row.subjectId === '[REDACTED]')).toBe(true);
    expect(job.processedRows).toBe(5);
    expect(paged.selectByIds).toHaveBeenLastCalledWith([5], 't1', expect.any(Array));
  });

  it('deletes rows by bounded identity batches', async () => {
    const { step, state, job, paged } = fixture({ rowDelete: true });
    while (job.state === 'queued') await step();
    expect(state.rows).toHaveLength(1);
    expect(paged.eraseByIds).toHaveBeenNthCalledWith(1, [1, 2], 't1');
    expect(paged.eraseByIds).toHaveBeenNthCalledWith(3, [5], 't1');
  });

  it.each(['noOp', 'corruptRetain'] as const)('rolls back a failed %s page without advancing its checkpoint or chunks', async flag => {
    const { step, state, job, chunks } = fixture();
    await step();
    const checkpoint = structuredClone(job.checkpoint);
    const rowSnapshot = structuredClone(state.rows);
    state[flag] = true;
    await expect(step()).rejects.toMatchObject({ code: DataSubjectErrorCode.VerificationFailed });
    expect(job.checkpoint).toEqual(checkpoint);
    expect(state.rows).toEqual(rowSnapshot);
    expect(chunks).toHaveLength(1);
    state[flag] = false;
    while (job.state === 'queued') await step();
    expect(job.processedRows).toBe(5);
    expect(chunks).toHaveLength(3);
  });

  it('exports only allowlisted fields as bounded NDJSON chunks', async () => {
    const { step, job, chunks, paged, state } = fixture({ type: 'export' });
    while (job.state === 'queued') await step();
    const records = decode(chunks);
    expect(records).toHaveLength(5);
    expect(records[0]).toEqual({ entityName: 'Item', data: { id: 1, email: 'person0@example.com', total: 0 } });
    expect(paged.readPage).toHaveBeenCalledWith(expect.objectContaining({ fields: ['id', 'subjectId', 'tenantId', 'email', 'total'] }));
    expect(Buffer.concat(chunks).toString()).not.toContain('secret');
    expect(job.hasCommittedChanges).toBe(false);
    expect(state.rows[0].email).toBe('person0@example.com');
    expect(paged.updateByIds).not.toHaveBeenCalled();
  });

  it('rejects oversize export chunks without persisting progress', async () => {
    const { step, job, chunks } = fixture({ type: 'export', maxChunkBytes: 10 });
    await expect(step()).rejects.toMatchObject({ code: DataSubjectErrorCode.InvalidInput });
    expect(job.checkpoint).toBeNull();
    expect(chunks).toHaveLength(0);
  });

  it('skips erase-only entities completely during export', async () => {
    const { step, paged, chunks, job } = fixture({ type: 'export', exportFields: [] });
    expect((await step()).done).toBe(true);
    expect(job.processedRows).toBe(0);
    expect(chunks).toHaveLength(0);
    expect(paged.highWatermark).not.toHaveBeenCalled();
    expect(paged.readPage).not.toHaveBeenCalled();
  });

  it('freezes upper bounds for later entities in the first transaction', async () => {
    const { registry, definition, full, paged, handlerOptions, job } = fixture({ type: 'export' });
    registry.registerDefinition({ ...definition, entityName: 'Second' }, full);
    const handler = createPagedPrivacyHandler({ ...handlerOptions, schemaSource: schema + '\n' + schema.replace('model Item', 'model Second'), executors: { Item: paged, Second: paged } });
    const payload = createPagedPrivacyPayload({ type: 'export', subjectId: 's1', registry });
    const result = await handler({ job: { ...job, payload, payloadHash: sha256Hex(stableStringify(payload)) }, appendChunk: async () => {} });
    expect(paged.highWatermark).toHaveBeenCalledTimes(2);
    expect(result.checkpoint).toMatchObject({ scopes: [
      { entityName: 'Item', through: 5 }, { entityName: 'Second', through: 5 },
    ] });
  });

  it('rejects checkpoints copied from another job or an uncommitted forged completion', async () => {
    const first = fixture({ type: 'export' });
    await first.step();
    const copied = structuredClone(first.job.checkpoint);
    const second = fixture({ type: 'export' });
    second.job.id = 'different-job';
    second.job.checkpoint = copied;
    second.job.pagesCommitted = 1;
    second.job.processedRows = 2;
    await expect(second.step()).rejects.toMatchObject({ code: DataSubjectErrorCode.InvalidInput });
    second.job.id = 'job';
    second.job.pagesCommitted = 0;
    (second.job.checkpoint as Record<string, JobJson>).entityIndex = 1;
    await expect(second.step()).rejects.toMatchObject({ code: DataSubjectErrorCode.InvalidInput });
    expect(second.paged.readPage).not.toHaveBeenCalled();
  });

  it.each(['tenantId', 'payloadHash', 'pagesCommitted', 'processedRows'] as const)('rejects checkpoint %s binding drift', async key => {
    const { job, step } = fixture();
    await step();
    const checkpoint = job.checkpoint as Record<string, JobJson>;
    if (key === 'processedRows') job.processedRows += 1;
    else if (key === 'pagesCommitted') checkpoint.pagesCommitted = 42;
    else checkpoint[key] = 'wrong';
    await expect(step()).rejects.toMatchObject({ code: DataSubjectErrorCode.InvalidInput });
  });

  it('rejects an export resume after its chunks were deleted', async () => {
    const { job, step } = fixture({ type: 'export' });
    await step();
    job.chunksDeletedAt = new Date();
    await expect(step()).rejects.toMatchObject({ code: DataSubjectErrorCode.InvalidInput });
  });

  it.each(['subjectId', 'type'] as const)('rejects changed payload %s with an unchanged checkpoint hash', async field => {
    const { job, step, paged } = fixture();
    await step();
    (job.payload as Record<string, JobJson>)[field] = field === 'subjectId' ? 'another-subject' : 'export';
    await expect(step()).rejects.toMatchObject({ code: DataSubjectErrorCode.InvalidInput });
    expect(paged.readPage).toHaveBeenCalledTimes(1);
  });

  it('excludes IDs beyond the first-transaction high water mark after restart', async () => {
    const { step, state, job, chunks } = fixture({ type: 'export' });
    await step();
    state.rows.push({ id: 6, tenantId: 't1', subjectId: 's1', email: 'new@example.com', total: 6, passwordHash: 'new-secret' });
    while (job.state === 'queued') await step();
    expect(job.processedRows).toBe(5);
    expect(Buffer.concat(chunks).toString()).not.toContain('new@example.com');
  });

  it('rejects policy drift between pages before further business writes', async () => {
    const { step, registry, full, state } = fixture();
    await step();
    const original = structuredClone(state.rows);
    registry.register({ policy: { entityName: 'Added', subjectField: 'subjectId', fields: {} }, executor: full });
    await expect(step()).rejects.toMatchObject({ code: DataSubjectErrorCode.PlanMismatch });
    expect(state.rows).toEqual(original);
  });

  it('rejects P1 preview or unsupported payload additions', async () => {
    const { job, step } = fixture();
    job.payload = { ...(job.payload as Record<string, JobJson>), preview: {} };
    await expect(step()).rejects.toMatchObject({ code: DataSubjectErrorCode.InvalidInput });
  });

  it('rejects inbound relations from an unregistered model', () => {
    const { handlerOptions } = fixture();
    const relatedSchema = schema + `\nmodel Child {
  id Int @id
  parentId Int
  parent Item @relation(fields: [parentId], references: [id], onDelete: Cascade)
}`;
    expect(() => createPagedPrivacyHandler({ ...handlerOptions, schemaSource: relatedSchema })).toThrow(DataSubjectErrorCode.InvalidPolicy);
    expect(() => createPagedPrivacyHandler({ ...handlerOptions, schemaSource: relatedSchema,
      excludedModels: { Child: 'Outside subject scope' } })).toThrow(DataSubjectErrorCode.InvalidPolicy);
  });

  it('allows explicitly excluded infrastructure models in the complete schema', () => {
    const { handlerOptions } = fixture();
    const fullSchema = schema + `\nmodel DataSubjectJob {
  id String @id
  payload Json
}`;
    expect(() => createPagedPrivacyHandler({ ...handlerOptions, schemaSource: fullSchema })).toThrow(DataSubjectErrorCode.InvalidPolicy);
    expect(() => createPagedPrivacyHandler({ ...handlerOptions, schemaSource: fullSchema,
      excludedModels: { DataSubjectJob: 'Queue payload has separate expiry and purge controls' } })).not.toThrow();
    const invalidExclusions: Record<string, string>[] = [{ Item: 'Cannot skip registered rows' }, { Missing: 'Unknown model' }, { DataSubjectJob: ' ' }];
    for (const excludedModels of invalidExclusions) {
      expect(() => createPagedPrivacyHandler({ ...handlerOptions, schemaSource: fullSchema, excludedModels })).toThrow(DataSubjectErrorCode.InvalidPolicy);
    }
  });

  it('rejects unsafe configuration and malformed checkpoints', async () => {
    const { handlerOptions, job, step } = fixture();
    for (const batchSize of [0, -1, 1001, 1.5, NaN]) expect(() => createPagedPrivacyHandler({ ...handlerOptions, batchSize })).toThrow();
    job.checkpoint = { schemaVersion: 'data-subject.paged-checkpoint.v1', entityIndex: -1 };
    await expect(step()).rejects.toMatchObject({ code: DataSubjectErrorCode.InvalidInput });
  });

  it('finishes an empty entity without write or chunk calls', async () => {
    const { step, job, chunks, paged } = fixture({ size: 0 });
    expect((await step()).done).toBe(true);
    expect(job.processedRows).toBe(0);
    expect(chunks).toHaveLength(0);
    expect(paged.readPage).not.toHaveBeenCalled();
    expect(paged.updateByIds).not.toHaveBeenCalled();
  });
});
