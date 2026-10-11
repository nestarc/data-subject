import { DataSubjectErrorCode } from '../errors';
import { pagedFromPrisma, type PagedPrismaDelegate } from './paged-from-prisma';

function setup(options: { subjectField?: string; stableIdField?: string; singleTenantId?: string } = {}) {
  const findMany = jest.fn(async (_args: Parameters<PagedPrismaDelegate['findMany']>[0]): Promise<Record<string, unknown>[]> => []);
  const deleteMany = jest.fn(async (_args: Parameters<PagedPrismaDelegate['deleteMany']>[0]) => ({ count: 1 }));
  const updateMany = jest.fn(async (_args: Parameters<PagedPrismaDelegate['updateMany']>[0]) => ({ count: 1 }));
  const delegate = { findMany, deleteMany, updateMany };
  const executor = pagedFromPrisma({
    delegate, subjectField: options.subjectField ?? 'userId',
    ...(options.singleTenantId ? { singleTenantId: options.singleTenantId } : { tenantField: 'tenantId' }),
    ...(options.stableIdField ? { stableIdField: options.stableIdField } : {}),
  });
  return { executor, delegate, findMany, deleteMany, updateMany };
}

describe('pagedFromPrisma', () => {
  it('reads the scoped high watermark with only one stable ID selected', async () => {
    const { executor, findMany } = setup({ stableIdField: 'rowKey' });
    findMany.mockResolvedValueOnce([{ rowKey: 'last-key' }]);

    await expect(executor.highWatermark({ subjectId: 'subject_1', tenantId: 'tenant_1' })).resolves.toBe('last-key');

    expect(findMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant_1', userId: 'subject_1' },
      orderBy: { rowKey: 'desc' }, take: 1, select: { rowKey: true },
    });
    expect(executor.identityField).toBe('rowKey');
    expect(executor.scope).toEqual({ mode: 'multi-tenant', tenantField: 'tenantId' });
  });

  it('returns null for an empty high-watermark query', async () => {
    const { executor } = setup();
    await expect(executor.highWatermark({ subjectId: 'subject_1', tenantId: 'tenant_1' })).resolves.toBeNull();
  });

  it('bounds every page using keyset predicates, deterministic database order, and a hard limit', async () => {
    const { executor, findMany } = setup();
    await executor.readPage({ subjectId: 'subject_1', tenantId: 'tenant_1', after: 20, through: 90, limit: 25, fields: ['email'] });

    expect(findMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant_1', userId: 'subject_1', AND: [{ id: { gt: 20, lte: 90 } }] },
      orderBy: { id: 'asc' }, take: 25,
      select: { id: true, userId: true, tenantId: true, email: true },
    });
    expect(findMany.mock.calls[0][0]).not.toHaveProperty('skip');
  });

  it('omits the lower bound for the first page and permits the explicit full-row compatibility path', async () => {
    const { executor, findMany } = setup();
    await executor.readPage({ subjectId: 'subject_1', tenantId: 'tenant_1', through: 90, limit: 1000 });

    expect(findMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant_1', userId: 'subject_1', AND: [{ id: { lte: 90 } }] },
      orderBy: { id: 'asc' }, take: 1000,
    });
  });

  it('does not compare or sort string keys using JavaScript collation', async () => {
    const { executor, findMany } = setup();
    findMany.mockResolvedValueOnce([{ id: 'database-chosen-key' }]);

    const rows = await executor.readPage({ subjectId: 'subject_1', tenantId: 'tenant_1', after: 'z', through: 'A', limit: 2 });

    expect(rows).toEqual([{ id: 'database-chosen-key' }]);
    expect(findMany.mock.calls[0][0].where).toMatchObject({ AND: [{ id: { gt: 'z', lte: 'A' } }] });
  });

  it('preserves subject equality when the subject field is the stable ID', async () => {
    const { executor, findMany } = setup({ subjectField: 'id' });
    await executor.readPage({ subjectId: 'subject_1', tenantId: 'tenant_1', through: 'subject_9', limit: 10 });

    expect(findMany.mock.calls[0][0].where).toEqual({
      tenantId: 'tenant_1', id: 'subject_1', AND: [{ id: { lte: 'subject_9' } }],
    });
  });

  it('looks up only tenant-scoped stable IDs after a subject key has changed', async () => {
    const { executor, findMany } = setup();
    findMany.mockResolvedValueOnce([{ id: 'row_1', userId: '[REDACTED]', tenantId: 'tenant_1', email: null }]);

    const rows = await executor.selectByIds(['row_1'], 'tenant_1', ['email']);

    expect(findMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant_1', id: { in: ['row_1'] } }, take: 1,
      select: { id: true, userId: true, tenantId: true, email: true },
    });
    expect(findMany.mock.calls[0][0].where).not.toHaveProperty('userId');
    expect(rows[0].userId).toBe('[REDACTED]');
  });

  it('constrains both mutation kinds to the selected tenant and exact stable IDs', async () => {
    const { executor, deleteMany, updateMany } = setup();

    await expect(executor.eraseByIds(['row_1', 'row_2'], 'tenant_1')).resolves.toBe(1);
    await expect(executor.updateByIds(['row_3'], 'tenant_2', { email: null, userId: '[REDACTED]' })).resolves.toBe(1);

    expect(deleteMany).toHaveBeenCalledWith({ where: { tenantId: 'tenant_1', id: { in: ['row_1', 'row_2'] } } });
    expect(updateMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant_2', id: { in: ['row_3'] } }, data: { email: null, userId: '[REDACTED]' },
    });
  });

  it('enforces single-tenant configuration for reads, lookups, and mutations', async () => {
    const { executor, findMany, updateMany, deleteMany } = setup({ singleTenantId: 'only_tenant' });

    await expect(executor.highWatermark({ subjectId: 'subject_1', tenantId: 'other_tenant' })).rejects.toMatchObject({ code: DataSubjectErrorCode.InvalidScope });
    await expect(executor.readPage({ subjectId: 'subject_1', tenantId: 'other_tenant', through: 'z', limit: 10 })).rejects.toMatchObject({ code: DataSubjectErrorCode.InvalidScope });
    await expect(executor.selectByIds(['row_1'], 'other_tenant')).rejects.toMatchObject({ code: DataSubjectErrorCode.InvalidScope });
    await expect(executor.eraseByIds(['row_1'], 'other_tenant')).rejects.toMatchObject({ code: DataSubjectErrorCode.InvalidScope });
    await expect(executor.updateByIds(['row_1'], 'other_tenant', { email: null })).rejects.toMatchObject({ code: DataSubjectErrorCode.InvalidScope });
    expect(findMany).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();

    await executor.readPage({ subjectId: 'subject_1', tenantId: 'only_tenant', through: 'z', limit: 10, fields: ['email'] });
    expect(findMany.mock.calls[0][0]).toMatchObject({
      where: { userId: 'subject_1', AND: [{ id: { lte: 'z' } }] },
      select: { id: true, userId: true, email: true },
    });
    expect(findMany.mock.calls[0][0].where).not.toHaveProperty('tenantId');
  });

  it.each([
    { tenantField: undefined },
    { tenantField: 'tenantId', singleTenantId: 'tenant_1' },
    { tenantField: '' },
    { tenantField: 'tenantId', subjectField: 'tenantId' },
    { tenantField: 'tenantId', stableIdField: 'tenantId' },
    { tenantField: 'tenantId', subjectField: ' ' },
    { tenantField: 'tenantId', stableIdField: 'nested.id' },
  ])('rejects malformed scope configuration %#', (overrides) => {
    const { delegate } = setup();
    expect(() => pagedFromPrisma({ delegate, subjectField: 'userId', ...overrides })).toThrow(DataSubjectErrorCode.InvalidScope);
  });

  it.each([
    [], [''], [' '], [1.5], [Number.MAX_SAFE_INTEGER + 1], [Infinity], [NaN],
    ['row_1', 'row_1'], [1, 'row_1'], Array.from({ length: 1001 }, (_, index) => index),
  ].map(ids => ({ ids })))('rejects malformed or unbounded ID lists %# before calling the database', async ({ ids }) => {
    const { executor, findMany, deleteMany, updateMany } = setup();
    const invalidIds = ids as never;
    for (const operation of [
      () => executor.selectByIds(invalidIds, 'tenant_1'),
      () => executor.eraseByIds(invalidIds, 'tenant_1'),
      () => executor.updateByIds(invalidIds, 'tenant_1', { email: null }),
    ]) await expect(operation()).rejects.toMatchObject({ code: DataSubjectErrorCode.InvalidInput });
    expect(findMany).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it.each([
    { limit: 0 }, { limit: 1001 }, { limit: 1.5 }, { limit: NaN },
    { through: '' }, { through: 1.5 }, { through: Number.MAX_SAFE_INTEGER + 1 },
    { after: 'string', through: 5 }, { after: 1, through: 'string' },
    { subjectId: ' ' }, { tenantId: '' },
  ])('rejects malformed page inputs %# before calling the database', async (overrides) => {
    const { executor, findMany } = setup();

    await expect(executor.readPage({ subjectId: 'subject_1', tenantId: 'tenant_1', through: 100, limit: 10, ...overrides })).rejects.toMatchObject({ code: DataSubjectErrorCode.InvalidInput });
    expect(findMany).not.toHaveBeenCalled();
  });

  it.each([[], [''], [' '], ['nested.field']].map(fields => ({ fields })))('rejects invalid projections %# before database access', async ({ fields }) => {
    const { executor, findMany } = setup();

    await expect(executor.readPage({ subjectId: 'subject_1', tenantId: 'tenant_1', through: 100, limit: 10, fields })).rejects.toMatchObject({ code: DataSubjectErrorCode.InvalidInput });
    await expect(executor.selectByIds([1], 'tenant_1', fields)).rejects.toMatchObject({ code: DataSubjectErrorCode.InvalidInput });
    expect(findMany).not.toHaveBeenCalled();
  });

  it.each([{ id: 'changed' }, { tenantId: 'other_tenant' }])('rejects scope identity mutation %# before calling the database', async (replacements) => {
    const { executor, updateMany } = setup();

    await expect(executor.updateByIds(['row_1'], 'tenant_1', replacements)).rejects.toMatchObject({ code: DataSubjectErrorCode.InvalidPolicy });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it.each([{}, { email: undefined }, { '': null }, { 'nested.email': null }])('rejects malformed replacement maps %# before calling the database', async (replacements) => {
    const { executor, updateMany } = setup();

    await expect(executor.updateByIds(['row_1'], 'tenant_1', replacements)).rejects.toMatchObject({ code: DataSubjectErrorCode.InvalidInput });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('never issues an unbounded findMany query on any read path', async () => {
    const { executor, findMany } = setup();
    await executor.highWatermark({ subjectId: 'subject_1', tenantId: 'tenant_1' });
    await executor.readPage({ subjectId: 'subject_1', tenantId: 'tenant_1', through: 1000, limit: 1000 });
    await executor.selectByIds(Array.from({ length: 1000 }, (_, index) => index), 'tenant_1');

    for (const [query] of findMany.mock.calls) {
      expect(query.take).toBeGreaterThan(0);
      expect(query.take).toBeLessThanOrEqual(1000);
      expect(query.where).toHaveProperty('tenantId', 'tenant_1');
    }
  });
});
