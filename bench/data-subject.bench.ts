/** In-memory library microbenchmarks. See README.md#benchmarks for measurement scope. */
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {
  compilePolicy, sha256Hex, DataSubjectErrorCode, type DataSubjectRequest, type EntityDefinition,
  type ErasureEvidenceArtifact, type ErasurePreview,
} from '../src';
import {
  InMemoryExecutor, makeService, definition, deleteRow, deleteFields, mixed, scalarReplacement,
  SUBJECT, TENANT, OTHER_TENANT, REPLACEMENT_DATE, REPLACEMENT_UNITS, REPLACEMENT_BALANCE,
} from './fixtures';
import { measure, parseOptions, USAGE, type Scenario } from './harness';
import { pagedScenarios } from './paged-privacy';

function assertCompleted(request: DataSubjectRequest): void {
  assert.equal(request.state, 'completed', request.failureReason ?? 'Request did not complete');
  assert.equal(request.stats?.lifecycle?.dataOutcome, 'completed');
  assert.equal(request.stats?.lifecycle?.artifactFailure, undefined);
}

function immediateScenarios(rows: number): Scenario[] {
  const erase = (label: string, policy: EntityDefinition, approved = false): Scenario => ({
    label, rows,
    async prepare() {
      const executor = new InMemoryExecutor(rows);
      const { service } = makeService([{ policy, executor }]);
      const preview = approved ? await service.previewErase(SUBJECT, TENANT) : undefined;
      let request: DataSubjectRequest;
      return {
        async run() { request = await service.erase(SUBJECT, TENANT, preview ? { preview } : undefined); },
        async verify() {
          assertCompleted(request);
          assert.equal(request.stats?.evidence?.schemaVersion, 'data-subject.evidence.v2');
          assert.equal(request.stats?.verification?.[0].status, 'verified');
          assert.equal(request.stats?.verification?.[0].checkedRows, rows);
          assert.deepEqual(request.stats?.verificationResidual, []);
          executor.assertOtherScopesUnchanged();
          const target = await executor.select(SUBJECT, TENANT);
          if (policy === deleteRow) assert.equal(target.length, 0);
          else {
            assert.equal(target.length, rows);
            for (const [index, row] of target.entries()) for (const [field, rule] of Object.entries(policy.fields)) {
              if (rule === 'delete' || rule.strategy === 'delete') assert.equal(row[field], null);
              else if (rule.strategy === 'retain') assert.deepEqual(row[field], executor.original[index][field]);
              else if (field === 'happenedAt') assert.equal((row[field] as Date).toISOString(), REPLACEMENT_DATE);
              else if (field === 'units') assert.equal(row[field], BigInt(REPLACEMENT_UNITS));
              else if (field === 'balance') assert.equal(String(row[field]), REPLACEMENT_BALANCE);
              else assert.equal(row[field], rule.replacement);
            }
          }
          if (policy === mixed) {
            assert.equal(request.stats?.entities[0].strategy, 'mixed');
            assert.deepEqual(request.stats?.retained?.map(item => [item.field, item.count]), [['amount', rows], ['balance', rows]]);
          }
          const artifact = await service.getArtifact(request.id, TENANT);
          assert(artifact);
          assert.equal(sha256Hex(artifact.body), request.artifactHash);
          const evidence = JSON.parse(artifact.body.toString('utf8')) as ErasureEvidenceArtifact;
          assert.equal(evidence.schemaVersion, 'data-subject.erasure-evidence.v2');
          assert.equal(evidence.verificationOverall, 'verified');
          assert.equal(evidence.state, 'completed');
          assert.equal(evidence.actions[0].affected, rows);
          assert.equal(evidence.actions[0].effectiveRowStrategy, policy === deleteRow ? 'delete-row' : 'update-fields');
          await assert.rejects(service.getArtifact(request.id, OTHER_TENANT), { code: DataSubjectErrorCode.RequestNotFound });
        },
      };
    },
  });
  return [
    {
      label: 'A) Raw scoped executor.select()', rows,
      prepare() {
        const executor = new InMemoryExecutor(rows);
        let count = 0;
        return { async run() { count = (await executor.select(SUBJECT, TENANT)).length; }, verify() { assert.equal(count, rows); } };
      },
    },
    {
      label: 'B) compilePolicy() — one entity, five fields',
      prepare() {
        let compiled: ReturnType<typeof compilePolicy>;
        return { async run() { compiled = compilePolicy(deleteRow); }, verify() { assert.equal(Object.keys(compiled.fields).length, 5); } };
      },
    },
    {
      label: 'C) Allowlisted ZIP export — five entities, exact total rows', rows,
      prepare() {
        const exportFields = ['id', 'email', 'displayName', 'units', 'happenedAt'];
        const entities = Array.from({ length: 5 }, (_, index) => ({
          policy: definition({ entityName: `Entity${index}`, subjectField: 'subjectId', fields: { email: 'delete' }, exportFields }),
          executor: new InMemoryExecutor(Math.floor(rows / 5) + (index < rows % 5 ? 1 : 0)),
        }));
        const { service } = makeService(entities);
        let request: DataSubjectRequest;
        return {
          async run() { request = await service.export(SUBJECT, TENANT); },
          async verify() {
            assertCompleted(request);
            assert.equal(request.stats?.entities.reduce((sum, entity) => sum + entity.affected, 0), rows);
            const artifact = await service.getArtifact(request.id, TENANT);
            assert(artifact);
            assert.equal(sha256Hex(artifact.body), request.artifactHash);
            const zip = await JSZip.loadAsync(artifact.body);
            assert.equal(Object.keys(zip.files).length, entities.length);
            let actualRows = 0;
            for (const entity of entities) {
              const file = zip.file(`${entity.policy.entityName}.json`);
              assert(file);
              const exported: unknown = JSON.parse(await file.async('string'));
              const expected = (await entity.executor.select(SUBJECT, TENANT)).map(row =>
                Object.fromEntries(exportFields.map(field => [field, typeof row[field] === 'bigint' ? String(row[field])
                  : row[field] instanceof Date ? row[field].toISOString() : row[field]])));
              assert.deepEqual(exported, expected);
              actualRows += expected.length;
              assert.deepEqual(entity.executor.rows, entity.executor.original);
            }
            assert.equal(actualRows, rows);
            await assert.rejects(service.getArtifact(request.id, OTHER_TENANT), { code: DataSubjectErrorCode.RequestNotFound });
          },
        };
      },
    },
    erase('D) Verified erase — delete-row', deleteRow),
    erase('E) Verified erase — delete-fields', deleteFields),
    erase('F) Verified erase — delete + anonymize + retain', mixed),
    {
      label: 'G) Signed read-only erase preview', rows,
      prepare() {
        const executor = new InMemoryExecutor(rows);
        const { service, requestStorage } = makeService([{ policy: mixed, executor }]);
        let preview: ErasurePreview;
        return {
          async run() { preview = await service.previewErase(SUBJECT, TENANT); },
          async verify() {
            assert.equal(preview.plan.entities[0].expectedRows, rows);
            assert.equal(preview.plan.entities[0].verification, 'available');
            assert.match(preview.signature, /^[a-f0-9]{64}$/);
            assert.deepEqual(executor.rows, executor.original);
            assert.deepEqual(await requestStorage.listByTenant(TENANT), []);
          },
        };
      },
    },
    erase('H) Verified erase with prepared signed preview', mixed, true),
    erase('I) Verified DateTime / Decimal / BigInt replacements (synthetic conversion)', scalarReplacement),
  ];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') { console.log(USAGE); return; }
  const options = parseOptions(args);
  console.log(`\ndata-subject in-memory microbenchmarks (Node ${process.version})`);
  console.log(`  iterations=${options.iterations}, warmup=${options.warmup}, rows=${options.rows}, batch-size=${options.batchSize}`);
  console.log('  Setup and correctness checks excluded; library verification, artifact creation and immediate erase snapshot copying included.');
  console.log('  P2 measures handler processing only; no PostgreSQL queue, locking, network or crash-recovery timing.\n');
  for (const scenario of [...immediateScenarios(options.rows), ...pagedScenarios(options)]) {
    await measure(scenario, options);
  }
  console.log('\nPASS: every warmup and measured iteration passed its data, scope and artifact checks.');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
