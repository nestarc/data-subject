import assert from 'node:assert/strict';
import {
  createPagedPrivacyHandler,
  createPagedPrivacyPayload,
  definePolicy,
  PAGED_PRIVACY_JOB_KIND,
  Registry,
  sha256Hex,
  type EntityExecutor,
  type JobRecord,
  type PagedEntityExecutor,
  type PagedId,
  type PagedReadInput,
} from '../src/index';
import type { Scenario } from './harness';

const tenantId = 'paged-tenant';
const subjectId = 'paged-subject';
const maxChunkBytes = 1_048_576;
const schemaSource = `model LedgerEntry {
  id Int @id
  tenantId String
  subjectId String
  email String?
  displayName String
  accessToken String?
  total BigInt
}`;

type Row = Record<string, unknown> & {
  id: number;
  tenantId: string;
  subjectId: string;
  email: string | null;
  displayName: string;
  accessToken: string | null;
  total: bigint;
};
type Options = { rows: number; batchSize: number };
type PageCall = PagedReadInput & { ids: number[] };
type IdCall = { operation: 'select' | 'update'; ids: PagedId[]; tenantId: string };

/** In-memory handler microbenchmarks, excluding PostgresJobStore persistence, locks and transactions. */
export function pagedScenarios(options: Options): Scenario[] {
  return (['export', 'erase'] as const).map(type => ({
    label: type === 'export'
      ? 'P2 paged allowlisted NDJSON export (in-memory handler)'
      : 'P2 paged verified mixed erase (in-memory handler)',
    rows: options.rows,
    prepare: () => prepare(options, type),
  }));
}

function prepare({ rows: rowCount, batchSize }: Options, type: 'export' | 'erase') {
  const makeRow = (id: number, tenant = tenantId, subject = subjectId): Row => ({
    id, tenantId: tenant, subjectId: subject,
    email: `person-${id}@example.test`, displayName: `Person ${id}`,
    accessToken: `private-token-${id}`, total: 9_007_199_254_740_993n + BigInt(id),
  });
  const originals = Array.from({ length: rowCount }, (_, index) => makeRow(index + 1));
  const outsiders = [makeRow(rowCount + 1, 'other-tenant'), makeRow(rowCount + 2, tenantId, 'other-subject')];
  const rows = new Map([...originals, ...outsiders].map(row => [row.id, { ...row }]));
  const pageCalls: PageCall[] = [];
  const idCalls: IdCall[] = [];
  let highWatermarkCalls = 0;
  const project = (row: Row, fields?: string[]) => fields
    ? Object.fromEntries(fields.map(field => [field, row[field]])) : { ...row };
  const lookup = (ids: PagedId[], tenant: string) => ids.flatMap(id => {
    const row = rows.get(numericId(id));
    return row?.tenantId === tenant ? [row] : [];
  });
  const paged: PagedEntityExecutor = {
    identityField: 'id', scope: { mode: 'multi-tenant', tenantField: 'tenantId' },
    async highWatermark(input) {
      highWatermarkCalls += 1;
      let highest: number | null = null;
      for (const row of rows.values()) {
        if (row.tenantId === input.tenantId && row.subjectId === input.subjectId) highest = row.id;
      }
      return highest;
    },
    async readPage(input) {
      const selected: Row[] = [];
      // Contiguous numeric fixture identities give bounded keyset reads without full-table scans.
      const through = numericId(input.through);
      for (let id = input.after === undefined ? 1 : numericId(input.after) + 1;
        id <= through && selected.length < input.limit; id += 1) {
        const row = rows.get(id);
        if (row?.tenantId === input.tenantId && row.subjectId === input.subjectId) selected.push(row);
      }
      pageCalls.push({ ...input, ids: selected.map(row => row.id) });
      return selected.map(row => project(row, input.fields));
    },
    async selectByIds(ids, tenant, fields) {
      idCalls.push({ operation: 'select', ids: [...ids], tenantId: tenant });
      return lookup(ids, tenant).map(row => project(row, fields));
    },
    async updateByIds(ids, tenant, replacements) {
      idCalls.push({ operation: 'update', ids: [...ids], tenantId: tenant });
      const selected = lookup(ids, tenant);
      for (const row of selected) Object.assign(row, replacements);
      return selected.length;
    },
    async eraseByIds() { throw new Error('Mixed policy must preserve rows'); },
  };
  const unbounded = async (): Promise<never> => { throw new Error('Paged benchmark invoked an unbounded executor'); };
  const executor: EntityExecutor = {
    identityField: 'id', scope: paged.scope,
    select: unbounded, selectByIds: unbounded, erase: unbounded, anonymize: unbounded,
  };
  const [definition] = definePolicy([{
    entityName: 'LedgerEntry', subjectField: 'subjectId', stableIdField: 'id', scope: paged.scope,
    rowLevel: 'delete-fields',
    fields: {
      subjectId: { strategy: 'anonymize', replacement: '[erased]' },
      email: 'delete', displayName: { strategy: 'anonymize', replacement: '[erased]' },
      accessToken: 'delete', total: { strategy: 'retain', legalBasis: 'tax:KR-basic-law-sec85' },
    },
    ignoredFields: { id: 'Stable identity for verification', tenantId: 'Tenant isolation boundary' },
    exportFields: ['id', 'email', 'displayName', 'total'],
  }]);
  const registry = new Registry();
  registry.registerDefinition(definition, executor);
  const handler = createPagedPrivacyHandler({
    registry, schemaSource, executors: { LedgerEntry: paged }, batchSize, maxChunkBytes,
  });
  const payload = createPagedPrivacyPayload({ type, subjectId, registry });
  const timestamp = new Date('2026-01-01T00:00:00Z');
  const job: JobRecord = {
    id: `bench-paged-${type}`, tenantId, kind: PAGED_PRIVACY_JOB_KIND, idempotencyKey: `bench-${type}`,
    // The public payload has only scalar values; sorting its keys produces its canonical JSON hash.
    payload, payloadHash: sha256Hex(JSON.stringify(payload, Object.keys(payload).sort())),
    state: 'queued', checkpoint: null, result: null, processedRows: 0, pagesCommitted: 0,
    chunksWritten: 0, attempts: 0, revision: 0, hasCommittedChanges: false, partial: false,
    lastError: null, createdAt: timestamp, updatedAt: timestamp, availableAt: timestamp,
    completedAt: null, chunksDeletedAt: null, expiresAt: new Date('2100-01-01T00:00:00Z'), purgedAt: null,
  };
  const chunks: Buffer[] = [];
  const chunksPerPage: number[] = [];
  const dataPages = Math.ceil(rowCount / batchSize);

  return {
    async run() {
      // Carry committed outputs into the next handler call; this is not a queue or transaction emulator.
      for (let step = 0; step < dataPages + 2; step += 1) {
        const chunkStart = chunks.length;
        const result = await handler({ job, appendChunk: async chunk => { chunks.push(chunk); } });
        chunksPerPage.push(chunks.length - chunkStart);
        job.checkpoint = result.checkpoint;
        job.processedRows += result.processedRows;
        job.pagesCommitted += 1;
        job.chunksWritten = chunks.length;
        job.hasCommittedChanges ||= result.hasCommittedChanges ?? false;
        if (result.done) {
          job.state = 'completed';
          job.result = result.result ?? null;
          return;
        }
      }
      throw new Error('Paged benchmark exceeded its bounded completion guard');
    },
    verify() {
      assert.equal(job.state, 'completed');
      assert.equal(job.processedRows, rowCount);
      assert.equal(job.pagesCommitted, Math.max(1, dataPages));
      assert.equal(job.chunksWritten, dataPages);
      assert.equal(job.hasCommittedChanges, type === 'erase' && rowCount > 0);
      assert.equal(highWatermarkCalls, 1);
      assert.equal(pageCalls.length, dataPages);
      assert(chunksPerPage.every(count => count <= 1));
      assert.deepEqual(job.result, {
        schemaVersion: 'data-subject.paged-result.v1', type, policyHash: payload.policyHash,
        scope: 'per-entity-high-watermark', snapshot: false,
        verification: type === 'erase' ? 'verified-per-batch' : 'export-allowlist',
        entities: [{ entityName: 'LedgerEntry', processedRows: rowCount }],
      });
      assert.deepEqual(pageCalls.flatMap(call => call.ids), originals.map(row => row.id));
      const requiredFields = type === 'export'
        ? ['id', 'subjectId', 'tenantId', 'email', 'displayName', 'total']
        : ['id', 'subjectId', 'tenantId', 'email', 'displayName', 'accessToken', 'total'];
      for (const [index, call] of pageCalls.entries()) {
        assert.equal(call.limit, batchSize);
        assert.equal(call.through, rowCount);
        assert.equal(call.after, index === 0 ? undefined : pageCalls[index - 1].ids.at(-1));
        assert.equal(call.tenantId, tenantId);
        assert.equal(call.subjectId, subjectId);
        assert(call.ids.length > 0 && call.ids.length <= batchSize);
        assert.deepEqual(call.fields, requiredFields);
      }
      assert.equal(idCalls.length, type === 'erase' ? dataPages * 3 : 0);
      for (const [index, call] of idCalls.entries()) {
        assert.equal(call.operation, index % 3 === 1 ? 'update' : 'select');
        assert.equal(call.tenantId, tenantId);
        assert.deepEqual(call.ids, pageCalls[Math.floor(index / 3)].ids);
        assert(call.ids.length <= batchSize);
      }
      const decoded = chunks.map(chunk => {
        assert(chunk.byteLength > 0 && chunk.byteLength <= maxChunkBytes);
        const text = chunk.toString('utf8');
        assert(text.endsWith('\n'));
        assert(!text.includes('private-token-'));
        return text.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
      });
      if (type === 'export') {
        assert.deepEqual(decoded.map(records => records.length), pageCalls.map(call => call.ids.length));
        assert.deepEqual(decoded.flat(), originals.map(row => ({
          entityName: 'LedgerEntry',
          data: { id: row.id, email: row.email, displayName: row.displayName, total: row.total.toString() },
        })));
        assert.deepEqual([...rows.values()], [...originals, ...outsiders]);
      } else {
        for (const [index, records] of decoded.entries()) {
          const count = pageCalls[index].ids.length;
          assert.deepEqual(records, [{
            schemaVersion: 'data-subject.paged-evidence.v1', entityName: 'LedgerEntry',
            policyHash: payload.policyHash, scope: 'original-page-identities',
            effectiveRowStrategy: 'update-fields', processedRows: count,
            verification: {
              status: 'verified', checkedRows: count,
              fields: Object.entries(definition.fields).map(([field, rule]) => ({
                field, strategy: rule === 'delete' ? 'delete' : rule.strategy, checked: count, status: 'verified',
              })),
            },
          }]);
        }
        assert.deepEqual([...rows.values()], [
          ...originals.map(row => ({ ...row, subjectId: '[erased]', email: null, displayName: '[erased]', accessToken: null })),
          ...outsiders,
        ]);
      }
    },
  };
}

function numericId(id: PagedId): number {
  if (typeof id !== 'number') throw new Error('Paged benchmark requires numeric identities');
  return id;
}
