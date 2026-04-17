/**
 * data-subject benchmark — measures DSR processing time and policy-complexity impact.
 *
 * Scenarios:
 *   A) Baseline: raw read 1000 rows from in-memory executor
 *   B) compilePolicy() — boot-time cost of compiling 1 entity with 5 fields
 *   C) export() — 5 entities × 200 rows = 1000 rows total (JSON + ZIP archive)
 *   D) erase() — delete-row on 1 entity × 1000 rows (simple case)
 *   E) erase() — delete-fields on 1 entity × 1000 rows (field-level update)
 *   F) erase() — mixed (delete + anonymize + retain) on 1 entity × 1000 rows
 *      (complex case — also verifies stats.retained is populated correctly)
 *
 * Key measurement: F should be noticeably slower than D/E but still bounded; its
 * stats.retained must list the retain fields with the legalBasis. This validates
 * the package's "conservative mixed strategy" claim — not just timing, but
 * behavioral correctness.
 *
 * All I/O is in-memory. Numbers reflect pure library overhead, not database cost.
 *
 * Usage:
 *   npx ts-node bench/data-subject.bench.ts
 *   npx ts-node bench/data-subject.bench.ts --iterations 100 --warmup 10
 */
import { compilePolicy, type PolicySpec } from '../src/policy-compiler';
import { Registry } from '../src/registry';
import { DataSubjectService } from '../src/data-subject.service';
import { InMemoryRequestStorage } from '../src/storage/in-memory-request-storage';
import { InMemoryArtifactStorage } from '../src/storage/in-memory-artifact-storage';
import type { EntityExecutor, ErasePlan } from '../src/types';

// ── CLI args ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function flag(name: string, fallback: string): string {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}
const ITERATIONS = Number(flag('iterations', '100'));
const WARMUP = Number(flag('warmup', '10'));
const ROWS_PER_ENTITY = Number(flag('rows', '1000'));

// ── Stats ─────────────────────────────────────────────────────────────
interface Stats { avg: number; p50: number; p95: number; p99: number }

function computeStats(samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    avg: sum / sorted.length,
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    p99: sorted[Math.floor(sorted.length * 0.99)],
  };
}

function fmt(ms: number): string {
  return ms < 1 ? `${(ms * 1000).toFixed(0)}µs` : `${ms.toFixed(2)}ms`;
}

function printStats(label: string, stats: Stats): void {
  console.log(
    `  ${label.padEnd(56)} Avg ${fmt(stats.avg).padStart(8)}  P50 ${fmt(stats.p50).padStart(8)}  P95 ${fmt(stats.p95).padStart(8)}  P99 ${fmt(stats.p99).padStart(8)}`,
  );
}

async function measure(
  label: string,
  fn: (i: number) => Promise<void>,
): Promise<Stats> {
  for (let i = 0; i < WARMUP; i++) await fn(ITERATIONS + i);
  const samples: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    await fn(i);
    samples.push(performance.now() - start);
  }
  const stats = computeStats(samples);
  printStats(label, stats);
  return stats;
}

// ── Fixture: in-memory executor that re-seeds on demand ───────────────
type Row = Record<string, unknown>;

function makeRows(subjectId: string, tenantId: string, count: number): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < count; i++) {
    rows.push({
      id: `${subjectId}-row-${i}`,
      userId: subjectId,
      tenantId,
      email: `user${i}@example.com`,
      name: `User ${i}`,
      amount: 100 + i,
      customerName: `Customer ${i}`,
      customerEmail: `cust${i}@example.com`,
      internalNote: `note ${i}`,
      createdAt: new Date(),
    });
  }
  return rows;
}

/**
 * In-memory executor that isolates library overhead from database I/O.
 * Each run starts from a fresh row set so repeated erase() calls observe
 * a full-scale workload rather than a drained one.
 */
class InMemoryExecutor implements EntityExecutor {
  rows: Row[] = [];

  seed(count: number, subjectId: string, tenantId: string): void {
    this.rows = makeRows(subjectId, tenantId, count);
  }

  async select(subjectId: string, tenantId: string): Promise<Row[]> {
    return this.rows.filter(
      (row) => row.userId === subjectId && row.tenantId === tenantId,
    );
  }

  async erase(subjectId: string, tenantId: string, plan: ErasePlan): Promise<number> {
    const matching = this.rows.filter(
      (row) => row.userId === subjectId && row.tenantId === tenantId,
    );
    if (plan.rowLevel === 'delete-row') {
      this.rows = this.rows.filter(
        (row) => !(row.userId === subjectId && row.tenantId === tenantId),
      );
    } else {
      for (const row of matching) {
        for (const field of plan.deleteFields) {
          row[field] = null;
        }
      }
    }
    return matching.length;
  }

  async anonymize(subjectId: string, tenantId: string, replacements: Row): Promise<number> {
    const matching = this.rows.filter(
      (row) => row.userId === subjectId && row.tenantId === tenantId,
    );
    for (const row of matching) {
      Object.assign(row, replacements);
    }
    return matching.length;
  }
}

// ── Main ──────────────────────────────────────────────────────────────
async function run() {
  console.log(`\ndata-subject Benchmark`);
  console.log(`  iterations: ${ITERATIONS}, warmup: ${WARMUP}, rows-per-entity: ${ROWS_PER_ENTITY}\n`);

  const SUBJECT = 'user_bench';
  const TENANT = 'tenant_bench';

  // ── A) Baseline: raw read ──────────────────────────────────────
  const baselineExecutor = new InMemoryExecutor();
  baselineExecutor.seed(ROWS_PER_ENTITY, SUBJECT, TENANT);
  const baselineStats = await measure(
    `A) Baseline: raw executor.select() of ${ROWS_PER_ENTITY} rows`,
    async () => {
      await baselineExecutor.select(SUBJECT, TENANT);
    },
  );

  // ── B) compilePolicy() ─────────────────────────────────────────
  const deleteSpec: PolicySpec = {
    entityName: 'User',
    subjectField: 'userId',
    rowLevel: 'delete-row',
    fields: {
      email: 'delete',
      name: 'delete',
      internalNote: 'delete',
      customerName: 'delete',
      customerEmail: 'delete',
    },
  };
  const compileStats = await measure(
    'B) compilePolicy() — 1 entity, 5 fields',
    async () => {
      compilePolicy(deleteSpec);
    },
  );

  // ── Helpers to build a fresh service per iteration ─────────────
  function makeService(
    entities: Array<{ policy: PolicySpec; executor: InMemoryExecutor }>,
  ): { service: DataSubjectService; executors: InMemoryExecutor[] } {
    const registry = new Registry();
    for (const e of entities) {
      registry.register({ policy: e.policy, executor: e.executor });
    }
    const service = new DataSubjectService({
      registry,
      requestStorage: new InMemoryRequestStorage(),
      artifactStorage: new InMemoryArtifactStorage(),
      slaDays: 30,
    });
    return { service, executors: entities.map((e) => e.executor) };
  }

  // ── C) export() across 5 entities × N rows each ────────────────
  const exportEntityCount = 5;
  const rowsPerExportEntity = Math.floor(ROWS_PER_ENTITY / exportEntityCount);
  const exportStats = await measure(
    `C) export() — ${exportEntityCount} entities × ${rowsPerExportEntity} rows (ZIP)`,
    async () => {
      const entities = Array.from({ length: exportEntityCount }, (_, idx) => ({
        policy: {
          entityName: `Entity${idx}`,
          subjectField: 'userId',
          rowLevel: 'delete-fields' as const,
          fields: { email: 'delete' as const },
        },
        executor: (() => {
          const ex = new InMemoryExecutor();
          ex.seed(rowsPerExportEntity, SUBJECT, TENANT);
          return ex;
        })(),
      }));
      const { service } = makeService(entities);
      const req = await service.export(SUBJECT, TENANT);
      if (req.state !== 'completed') throw new Error(`export state: ${req.state}`);
    },
  );

  // ── D) erase() — delete-row, single entity ─────────────────────
  const deleteRowStats = await measure(
    `D) erase() — delete-row, 1 entity × ${ROWS_PER_ENTITY} rows`,
    async () => {
      const executor = new InMemoryExecutor();
      executor.seed(ROWS_PER_ENTITY, SUBJECT, TENANT);
      const { service } = makeService([{ policy: deleteSpec, executor }]);
      const req = await service.erase(SUBJECT, TENANT);
      if (req.state !== 'completed') throw new Error(`erase state: ${req.state}`);
    },
  );

  // ── E) erase() — delete-fields, single entity ──────────────────
  const deleteFieldsSpec: PolicySpec = {
    entityName: 'User',
    subjectField: 'userId',
    rowLevel: 'delete-fields',
    fields: {
      email: 'delete',
      name: 'delete',
      internalNote: 'delete',
    },
  };
  const deleteFieldsStats = await measure(
    `E) erase() — delete-fields, 1 entity × ${ROWS_PER_ENTITY} rows`,
    async () => {
      const executor = new InMemoryExecutor();
      executor.seed(ROWS_PER_ENTITY, SUBJECT, TENANT);
      const { service } = makeService([{ policy: deleteFieldsSpec, executor }]);
      const req = await service.erase(SUBJECT, TENANT);
      if (req.state !== 'completed') throw new Error(`erase state: ${req.state}`);
    },
  );

  // ── F) erase() — mixed strategies ──────────────────────────────
  const mixedSpec: PolicySpec = {
    entityName: 'User',
    subjectField: 'userId',
    rowLevel: 'delete-row', // downgraded to delete-fields due to retain
    fields: {
      // retain → must survive the erase
      customerName: {
        strategy: 'retain',
        legalBasis: 'tax:KR-basic-law-sec85',
        until: '+7y',
      },
      amount: {
        strategy: 'retain',
        legalBasis: 'tax:KR-basic-law-sec85',
      },
      // anonymize → replaced with static string
      customerEmail: {
        strategy: 'anonymize',
        replacement: '[REDACTED]',
      },
      // delete → nulled
      email: 'delete',
      internalNote: 'delete',
    },
  };

  let lastMixedRequest: Awaited<ReturnType<DataSubjectService['erase']>> | null = null;
  const mixedStats = await measure(
    `F) erase() — mixed (delete+anonymize+retain), 1 × ${ROWS_PER_ENTITY}`,
    async () => {
      const executor = new InMemoryExecutor();
      executor.seed(ROWS_PER_ENTITY, SUBJECT, TENANT);
      const { service } = makeService([{ policy: mixedSpec, executor }]);
      lastMixedRequest = await service.erase(SUBJECT, TENANT);
      if (lastMixedRequest.state !== 'completed') {
        throw new Error(`erase state: ${lastMixedRequest.state}`);
      }
    },
  );

  // ── Summary & correctness checks ───────────────────────────────
  console.log('\n  Summary');
  console.log(`  ──────────────────────────────────────────────────────`);
  console.log(`  Baseline raw select (A, avg):                     ~${fmt(baselineStats.avg)}`);
  console.log(`  export() 5×${rowsPerExportEntity} rows with ZIP (C, avg):               ~${fmt(exportStats.avg)}`);
  console.log(`  erase() delete-row (D, avg):                      ~${fmt(deleteRowStats.avg)}`);
  console.log(`  erase() delete-fields (E, avg):                   ~${fmt(deleteFieldsStats.avg)}`);
  console.log(`  erase() mixed strategies (F, avg):                ~${fmt(mixedStats.avg)}`);
  console.log(`  Export throughput:                                ~${(1000 * ROWS_PER_ENTITY / exportStats.avg).toFixed(0)} rows/sec`);
  console.log(`  Erase (delete-row) throughput:                    ~${(1000 * ROWS_PER_ENTITY / deleteRowStats.avg).toFixed(0)} rows/sec`);

  // Behavioral correctness: mixed erase must preserve retain fields.
  console.log('\n  Behavioral correctness (F)');
  console.log(`  ──────────────────────────────────────────────────────`);
  if (!lastMixedRequest) {
    console.error('  ✗ FAIL — no mixed request captured');
    process.exit(1);
  }
  const typed = lastMixedRequest as Awaited<ReturnType<DataSubjectService['erase']>>;
  const mixedEntity = typed.stats?.entities?.[0];
  const retained = typed.stats?.retained ?? [];

  console.log(`  stats.entities[0].strategy:                       ${mixedEntity?.strategy ?? '<none>'}`);
  console.log(`  stats.retained count:                             ${retained.length}`);
  for (const r of retained) {
    console.log(`    - ${r.entityName}.${r.field}  legalBasis=${r.legalBasis}  count=${r.count}`);
  }

  const retainFields = new Set(retained.map((r) => r.field));
  const expectedRetainFields = new Set(['customerName', 'amount']);
  const allRetainFieldsPresent = [...expectedRetainFields].every((f) => retainFields.has(f));

  if (mixedEntity?.strategy !== 'mixed') {
    console.error(`\n  ✗ FAIL — expected strategy='mixed', got '${mixedEntity?.strategy}'`);
    process.exit(1);
  }
  if (!allRetainFieldsPresent) {
    console.error(`\n  ✗ FAIL — expected retained fields {customerName, amount}, got {${[...retainFields].join(', ')}}`);
    process.exit(1);
  }
  console.log(`\n  ✓ PASS — mixed erase reports strategy='mixed' and retains {customerName, amount} under legal basis.`);

  console.log('\nDone.\n');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
