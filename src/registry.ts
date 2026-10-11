import { DataSubjectError, DataSubjectErrorCode } from './errors';
import { compilePolicy, type CompileOptions, type PolicySpec } from './policy-compiler';
import type { EntityExecutor, RegisteredEntity } from './types';
import { definePolicy, type EntityDefinition } from './policy-definition';

export interface RegisterInput {
  policy: PolicySpec;
  executor: EntityExecutor;
}

export class Registry {
  private readonly entries = new Map<string, RegisteredEntity>();
  private readonly sharedDefinitions = new Map<string, EntityDefinition>();

  constructor(private readonly opts: CompileOptions = {}) {}

  register(input: RegisterInput): void {
    const name = input.policy.entityName;
    if (this.entries.has(name)) {
      throw new DataSubjectError(
        DataSubjectErrorCode.EntityAlreadyRegistered,
        `entity ${name} already registered`,
      );
    }

    const compiled = freezePolicyValue(compilePolicy(input.policy, this.opts));
    const original = input.executor;
    const executor: EntityExecutor = Object.freeze({
      ...(original.scope ? { scope: Object.freeze({ ...original.scope }) } : {}),
      ...(original.identityField !== undefined ? { identityField: original.identityField } : {}),
      select: original.select.bind(original),
      erase: original.erase.bind(original),
      anonymize: original.anonymize.bind(original),
      ...(original.selectByIds ? { selectByIds: original.selectByIds.bind(original) } : {}),
    });
    this.entries.set(name, Object.freeze({ policy: compiled, executor }));
  }

  get(name: string): RegisteredEntity | undefined {
    return this.entries.get(name);
  }

  registerDefinition(definition: EntityDefinition, executor: EntityExecutor): void {
    const [copy] = definePolicy([definition]);
    const actual = executor.scope;
    const expected = copy.scope;
    if (
      !actual ||
      actual.mode !== expected.mode ||
      (actual.mode === 'multi-tenant' &&
        expected.mode === 'multi-tenant' &&
        actual.tenantField !== expected.tenantField) ||
      (actual.mode === 'single-tenant' &&
        expected.mode === 'single-tenant' &&
        actual.tenantId !== expected.tenantId)
    ) {
      throw new DataSubjectError(
        DataSubjectErrorCode.InvalidPolicy,
        `${copy.entityName}: executor scope differs from shared policy definition`,
      );
    }
    this.register({ policy: copy, executor });
    this.sharedDefinitions.set(copy.entityName, copy);
  }

  definitions(): EntityDefinition[] {
    return definePolicy([...this.sharedDefinitions.values()]);
  }

  list(): RegisteredEntity[] {
    const remaining = new Map([...this.entries.keys()].map((name) => [name, 0]));
    for (const entry of this.entries.values()) {
      for (const parent of entry.policy.dependsOn ?? []) {
        if (!remaining.has(parent)) {
          throw new DataSubjectError(
            DataSubjectErrorCode.InvalidPolicy,
            `${entry.policy.entityName}: missing dependency ${parent}`,
          );
        }
        remaining.set(parent, remaining.get(parent)! + 1);
      }
    }
    const result: RegisteredEntity[] = [];
    while (remaining.size) {
      const next = [...remaining].find(([, incoming]) => incoming === 0);
      if (!next) {
        throw new DataSubjectError(
          DataSubjectErrorCode.InvalidPolicy,
          'Cyclic entity dependencies are unsupported',
        );
      }
      const entry = this.entries.get(next[0])!;
      result.push(entry);
      remaining.delete(next[0]);
      for (const parent of entry.policy.dependsOn ?? [])
        remaining.set(parent, remaining.get(parent)! - 1);
    }
    return result;
  }
}

function freezePolicyValue<T extends object>(value: T, visited = new WeakSet<object>()): T {
  if (visited.has(value)) return value;
  visited.add(value);
  for (const child of Object.values(value)) {
    if (typeof child === 'object' && child !== null) freezePolicyValue(child, visited);
  }
  return Object.freeze(value);
}
