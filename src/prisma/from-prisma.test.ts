import { fromPrisma } from './from-prisma';
import { DataSubjectErrorCode } from '../errors';

function mockDelegate(rows: Record<string, unknown>[] = [{ id: 'u1', userId: 's1', email: 'a@b.com' }]) {
  const state = { rows };

  return {
    state,
    delegate: {
      findMany: jest.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          state.rows.filter((row) =>
            Object.entries(where).every(
              ([key, value]) => (row as Record<string, unknown>)[key] === value,
            ),
          ),
      ),
      deleteMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const before = state.rows.length;
        state.rows = state.rows.filter(
          (row) =>
            !Object.entries(where).every(
              ([key, value]) => (row as Record<string, unknown>)[key] === value,
            ),
        );
        return { count: before - state.rows.length };
      }),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          let count = 0;
          state.rows = state.rows.map((row) => {
            if (
              Object.entries(where).every(
                ([key, value]) => (row as Record<string, unknown>)[key] === value,
              )
            ) {
              count += 1;
              return { ...row, ...data };
            }

            return row;
          });
          return { count };
        },
      ),
    },
  };
}

describe('fromPrisma', () => {
  it('select queries by subjectField and tenantId', async () => {
    const mock = mockDelegate();
    const exec = fromPrisma({
      delegate: mock.delegate,
      subjectField: 'userId',
      tenantField: 'tenantId',
    });

    const rows = await exec.select('s1', 't1');

    expect(mock.delegate.findMany).toHaveBeenCalledWith({
      where: { userId: 's1', tenantId: 't1' },
    });
    expect(rows.length).toBe(0);
  });

  it('erase deletes by where clause', async () => {
    const mock = mockDelegate();
    const exec = fromPrisma({
      delegate: mock.delegate,
      subjectField: 'userId',
      singleTenantId: 't1',
    });

    const count = await exec.erase('s1', 't1', {
      rowLevel: 'delete-row',
      deleteFields: ['email'],
    });

    expect(count).toBe(1);
    expect(mock.state.rows.length).toBe(0);
  });

  it('erase nulls delete-fields when row deletion is disabled', async () => {
    const mock = mockDelegate();
    const exec = fromPrisma({
      delegate: mock.delegate,
      subjectField: 'userId',
      singleTenantId: 't1',
    });

    const count = await exec.erase('s1', 't1', {
      rowLevel: 'delete-fields',
      deleteFields: ['email'],
    });

    expect(count).toBe(1);
    expect(mock.state.rows).toEqual([{ id: 'u1', userId: 's1', email: null }]);
    expect(mock.delegate.updateMany).toHaveBeenCalledWith({
      where: { userId: 's1' },
      data: { email: null },
    });
  });

  it('anonymize updates by where clause with replacements', async () => {
    const mock = mockDelegate();
    const exec = fromPrisma({
      delegate: mock.delegate,
      subjectField: 'userId',
      singleTenantId: 't1',
    });

    const count = await exec.anonymize('s1', 't1', { email: '[REDACTED]' });

    expect(count).toBe(1);
    expect(mock.state.rows[0].email).toBe('[REDACTED]');
  });

  it.each([
    {},
    { tenantField: '' },
    { tenantField: '   ' },
    { singleTenantId: '' },
    { singleTenantId: '   ' },
    { tenantField: 'tenantId', singleTenantId: 't1' },
    { tenantField: 'userId' },
  ])('rejects missing, ambiguous, or invalid tenant scope %j', (scope) => {
    const mock = mockDelegate();
    expect(() => fromPrisma({ delegate: mock.delegate, subjectField: 'userId', ...scope }))
      .toThrow(DataSubjectErrorCode.InvalidScope);
    expect(mock.delegate.findMany).not.toHaveBeenCalled();
  });

  it('publishes scope metadata and requires nonblank subject fields', () => {
    const mock = mockDelegate();
    expect(fromPrisma({ delegate: mock.delegate, subjectField: 'userId', tenantField: 'tenantId' }).scope)
      .toEqual({ mode: 'multi-tenant', tenantField: 'tenantId' });
    expect(fromPrisma({ delegate: mock.delegate, subjectField: 'userId', singleTenantId: 't1' }).scope)
      .toEqual({ mode: 'single-tenant', tenantId: 't1' });
    expect(() => fromPrisma({ delegate: mock.delegate, subjectField: ' ', tenantField: 'tenantId' }))
      .toThrow(DataSubjectErrorCode.InvalidScope);
  });

  it.each([
    ['', 't1'],
    ['s1', ''],
    ['   ', 't1'],
    ['s1', '   '],
  ])('rejects blank identifiers before any database call', async (subjectId, tenantId) => {
    const mock = mockDelegate();
    const exec = fromPrisma({ delegate: mock.delegate, subjectField: 'userId', tenantField: 'tenantId' });
    await expect(exec.select(subjectId, tenantId)).rejects.toMatchObject({ code: DataSubjectErrorCode.InvalidInput });
    await expect(exec.erase(subjectId, tenantId, { rowLevel: 'delete-fields', deleteFields: [] }))
      .rejects.toMatchObject({ code: DataSubjectErrorCode.InvalidInput });
    await expect(exec.anonymize(subjectId, tenantId, {})).rejects.toMatchObject({ code: DataSubjectErrorCode.InvalidInput });
    expect(mock.delegate.findMany).not.toHaveBeenCalled();
    expect(mock.delegate.deleteMany).not.toHaveBeenCalled();
    expect(mock.delegate.updateMany).not.toHaveBeenCalled();
  });

  it('rejects another tenant in explicit single-tenant mode', async () => {
    const mock = mockDelegate();
    const exec = fromPrisma({ delegate: mock.delegate, subjectField: 'userId', singleTenantId: 't1' });
    await expect(exec.select('s1', 't2')).rejects.toMatchObject({ code: DataSubjectErrorCode.InvalidScope });
    await expect(exec.erase('s1', 't2', { rowLevel: 'delete-row', deleteFields: [] }))
      .rejects.toMatchObject({ code: DataSubjectErrorCode.InvalidScope });
    await expect(exec.anonymize('s1', 't2', { email: null }))
      .rejects.toMatchObject({ code: DataSubjectErrorCode.InvalidScope });
    expect(mock.delegate.findMany).not.toHaveBeenCalled();
    expect(mock.delegate.deleteMany).not.toHaveBeenCalled();
    expect(mock.delegate.updateMany).not.toHaveBeenCalled();
  });

  it('isolates reads, field erasure, anonymization, and row deletion for identical subject IDs', async () => {
    const otherTenant = { id: 'u2', userId: 'shared', tenantId: 't2', email: 'other@example.com', name: 'Other' };
    const mock = mockDelegate([
      { id: 'u1', userId: 'shared', tenantId: 't1', email: 'first@example.com', name: 'First' },
      otherTenant,
    ]);
    const exec = fromPrisma({ delegate: mock.delegate, subjectField: 'userId', tenantField: 'tenantId' });

    expect(await exec.select('shared', 't1')).toHaveLength(1);
    expect(await exec.erase('shared', 't1', { rowLevel: 'delete-fields', deleteFields: ['email'] })).toBe(1);
    expect(await exec.anonymize('shared', 't1', { name: '[REDACTED]' })).toBe(1);
    expect(mock.state.rows).toEqual([
      { id: 'u1', userId: 'shared', tenantId: 't1', email: null, name: '[REDACTED]' },
      otherTenant,
    ]);
    expect(await exec.erase('shared', 't1', { rowLevel: 'delete-row', deleteFields: [] })).toBe(1);
    expect(mock.state.rows).toEqual([otherTenant]);
  });
});
