import { Decimal } from '@prisma/client/runtime/library';
import { InMemoryExecutor, makeService, mixed, SUBJECT, TENANT, BASE_DATE } from '../../bench/fixtures';

function corruptMutableScalars(row: Record<string, unknown>): void {
  (row.happenedAt as Date).setUTCFullYear(1999);
  (row.balance as Decimal).d[0] = 999;
}

describe('benchmark fixture isolation', () => {
  it.each(['happenedAt', 'balance'])('detects in-place %s mutation outside the target scope', field => {
    const executor = new InMemoryExecutor(1);
    const outsider = executor.rows.find(row => row.tenantId !== TENANT)!;
    if (field === 'happenedAt') (outsider[field] as Date).setUTCFullYear(1999);
    else (outsider[field] as Decimal).d[0] = 999;

    expect(() => executor.assertOtherScopesUnchanged()).toThrow();
    expect((executor.original[1].happenedAt as Date).toISOString()).toBe(BASE_DATE);
    expect(String(executor.original[1].balance)).toBe('100.2');
  });

  it('returns detached scalar values from both scoped reads and ID lookups', async () => {
    const executor = new InMemoryExecutor(1);
    const [selected] = await executor.select(SUBJECT, TENANT);
    const [lookedUp] = await executor.selectByIds([selected.id], TENANT);
    corruptMutableScalars(selected);
    expect((lookedUp.happenedAt as Date).toISOString()).toBe(BASE_DATE);
    expect(String(lookedUp.balance)).toBe('100.1');
    corruptMutableScalars(lookedUp);

    expect((executor.rows[0].happenedAt as Date).toISOString()).toBe(BASE_DATE);
    expect(String(executor.rows[0].balance)).toBe('100.1');
    expect(executor.rows[0].units).toBe(9007199254740993n);
    expect(executor.rows).toEqual(executor.original);
  });

  it('restores scalar mutations when the local erasure transaction fails', async () => {
    const executor = new InMemoryExecutor(1);
    executor.anonymize = async () => {
      for (const row of executor.rows) corruptMutableScalars(row);
      throw new Error('synthetic transaction failure');
    };
    const { service } = makeService([{ policy: mixed, executor }]);

    const request = await service.erase(SUBJECT, TENANT);

    expect(request.state).toBe('failed');
    expect(request.stats?.lifecycle?.failureStage).toBe('data_execution');
    expect(executor.rows).toEqual(executor.original);
    expect((executor.rows[0].happenedAt as Date).toISOString()).toBe(BASE_DATE);
    expect(String(executor.rows[0].balance)).toBe('100.1');
    expect(executor.rows[0].units).toBe(9007199254740993n);
    executor.assertOtherScopesUnchanged();
  });
});
