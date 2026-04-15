import { DataSubjectError, DataSubjectErrorCode } from './errors';
import { Registry } from './registry';
import type { EntityExecutor } from './types';

const noopExec: EntityExecutor = {
  select: async () => [],
  erase: async () => 0,
  anonymize: async () => 0,
};

describe('Registry', () => {
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

    expect(registry.list().map((entry) => entry.policy.entityName).sort()).toEqual([
      'Invoice',
      'User',
    ]);
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
