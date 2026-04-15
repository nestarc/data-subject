import { fromPrisma } from './from-prisma';

function mockDelegate() {
  const state = { rows: [{ id: 'u1', userId: 's1', email: 'a@b.com' }] };

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
    });

    const count = await exec.anonymize('s1', 't1', { email: '[REDACTED]' });

    expect(count).toBe(1);
    expect(mock.state.rows[0].email).toBe('[REDACTED]');
  });
});
