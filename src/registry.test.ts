import { DataSubjectError, DataSubjectErrorCode } from './errors';
import { Registry } from './registry';
import type { EntityExecutor } from './types';
import type { PolicySpec } from './policy-compiler';

const noopExec: EntityExecutor = {
  select: async () => [],
  erase: async () => 0,
  anonymize: async () => 0,
};

describe('Registry', () => {
  it('keeps policy and executor metadata stable while asynchronous reads are pending', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sourcePolicy: PolicySpec = {
      entityName: 'User',
      subjectField: 'userId',
      stableIdField: 'id',
      fields: { email: { strategy: 'anonymize', replacement: '[removed]' } },
      exportFields: ['email'],
    };
    const sourceExecutor: EntityExecutor & { label: string } = {
      label: 'bound source instance',
      scope: { mode: 'multi-tenant', tenantField: 'tenantId' },
      identityField: 'id',
      async select() {
        await gate;
        return [{ id: '1', label: this.label }];
      },
      async selectByIds() {
        return [{ id: '1' }];
      },
      async erase() {
        return 1;
      },
      async anonymize() {
        return 1;
      },
    };
    const registry = new Registry();
    registry.register({ policy: sourcePolicy, executor: sourceExecutor });
    const entry = registry.get('User')!;
    const pendingRead = entry.executor.select('subject', 'tenant');
    sourcePolicy.fields.email = 'delete';
    sourcePolicy.exportFields!.push('secret');
    sourceExecutor.scope = { mode: 'single-tenant', tenantId: 'other' };
    sourceExecutor.identityField = 'subjectId';
    sourceExecutor.select = async () => [{ id: 'swapped' }];
    sourceExecutor.erase = async () => 999;
    delete sourceExecutor.selectByIds;
    release();
    expect(await pendingRead).toEqual([{ id: '1', label: 'bound source instance' }]);
    expect(await entry.executor.select('subject', 'tenant')).toEqual([
      { id: '1', label: 'bound source instance' },
    ]);
    expect(
      await entry.executor.erase('subject', 'tenant', { rowLevel: 'delete-row', deleteFields: [] }),
    ).toBe(1);
    expect(await entry.executor.selectByIds!(['1'], 'tenant')).toEqual([{ id: '1' }]);
    expect(entry.executor.scope).toEqual({ mode: 'multi-tenant', tenantField: 'tenantId' });
    expect(entry.executor.identityField).toBe('id');
    expect(entry.policy.fields.email).toEqual({ strategy: 'anonymize', replacement: '[removed]' });
    expect(entry.policy.exportFields).toEqual(['email']);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.policy.fields.email)).toBe(true);
    expect(Object.isFrozen(entry.policy.exportFields)).toBe(true);
    expect(Object.isFrozen(entry.executor.scope)).toBe(true);
    expect(() => {
      entry.policy.fields.email = 'delete';
    }).toThrow(TypeError);
    expect(() => {
      entry.executor.erase = async () => 0;
    }).toThrow(TypeError);
    expect(registry.list()[0]).toBe(entry);
  });

  it('orders children before parents independently of registration order', () => {
    const registry = new Registry();
    for (const [name, dependsOn] of [
      ['User', []],
      ['Invoice', ['User']],
      ['Line', ['Invoice']],
    ] as Array<[string, string[]]>) {
      registry.register({
        policy: {
          entityName: name,
          subjectField: 'userId',
          dependsOn,
          fields: { email: 'delete' },
        },
        executor: noopExec,
      });
    }
    expect(registry.list().map((entry) => entry.policy.entityName)).toEqual([
      'Line',
      'Invoice',
      'User',
    ]);
  });

  it('rejects missing parents and dependency cycles before execution', () => {
    const registry = new Registry();
    registry.register({
      policy: {
        entityName: 'A',
        subjectField: 'userId',
        dependsOn: ['B'],
        fields: { email: 'delete' },
      },
      executor: noopExec,
    });
    expect(() => registry.list()).toThrow(/missing dependency/);
    registry.register({
      policy: {
        entityName: 'B',
        subjectField: 'userId',
        dependsOn: ['A'],
        fields: { email: 'delete' },
      },
      executor: noopExec,
    });
    expect(() => registry.list()).toThrow(/Cyclic/);
  });
  it('registers and retrieves an entity', () => {
    const registry = new Registry();

    registry.register({
      policy: {
        entityName: 'User',
        subjectField: 'userId',
        fields: { email: 'delete' },
      },
      executor: noopExec,
    });

    const entry = registry.get('User');
    expect(entry?.policy.entityName).toBe('User');
  });

  it('rejects duplicate entity names', () => {
    const registry = new Registry();

    registry.register({
      policy: {
        entityName: 'User',
        subjectField: 'userId',
        fields: { email: 'delete' },
      },
      executor: noopExec,
    });

    try {
      registry.register({
        policy: {
          entityName: 'User',
          subjectField: 'userId',
          fields: { name: 'delete' },
        },
        executor: noopExec,
      });
      throw new Error('expected duplicate registration to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(DataSubjectError);
      expect(error).toMatchObject({
        code: DataSubjectErrorCode.EntityAlreadyRegistered,
      });
    }
  });

  it('list returns all registered entries', () => {
    const registry = new Registry();

    registry.register({
      policy: {
        entityName: 'User',
        subjectField: 'userId',
        fields: { email: 'delete' },
      },
      executor: noopExec,
    });
    registry.register({
      policy: {
        entityName: 'Invoice',
        subjectField: 'customerId',
        fields: { note: 'delete' },
      },
      executor: noopExec,
    });

    expect(
      registry
        .list()
        .map((entry) => entry.policy.entityName)
        .sort(),
    ).toEqual(['Invoice', 'User']);
  });

  it('compiles policy on registration (strict mode propagates)', () => {
    const registry = new Registry({ strictLegalBasis: true });

    expect(() =>
      registry.register({
        policy: {
          entityName: 'Invoice',
          subjectField: 'customerId',
          fields: { amount: { strategy: 'retain', legalBasis: 'bare' } },
        },
        executor: noopExec,
      }),
    ).toThrow(/scheme/);
  });
});
