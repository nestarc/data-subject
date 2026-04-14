import { compilePolicy, type CompileOptions, type PolicySpec } from './policy-compiler';
import type { EntityExecutor, RegisteredEntity } from './types';

export interface RegisterInput {
  policy: PolicySpec;
  executor: EntityExecutor;
}

export class Registry {
  private readonly entries = new Map<string, RegisteredEntity>();

  constructor(private readonly opts: CompileOptions = {}) {}

  register(input: RegisterInput): void {
    const name = input.policy.entityName;
    if (this.entries.has(name)) {
      throw new Error(`entity ${name} already registered`);
    }

    const compiled = compilePolicy(input.policy, this.opts);
    this.entries.set(name, { policy: compiled, executor: input.executor });
  }

  get(name: string): RegisteredEntity | undefined {
    return this.entries.get(name);
  }

  list(): RegisteredEntity[] {
    return [...this.entries.values()];
  }
}
