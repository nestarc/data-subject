# @nestarc/data-subject v0.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship v0.1 of `@nestarc/data-subject` — a NestJS package providing DPA-ready GDPR/CCPA data subject request handling with entity registry, three-strategy policy engine (delete/anonymize/retain), export/erase lifecycle, and outbox tombstone fan-out.

**Architecture:** Pure-function core (legal-basis validator, policy compiler) → registry → storage interfaces with InMemory impls → export + erase services → facade + NestJS module. Decorator path and CLI lint are deferred to v0.2. Integration with `@nestarc/outbox` and `@nestarc/audit-log` happens through pluggable callbacks.

**Tech Stack:** TypeScript 5.4, NestJS 10, Prisma 5 (optional peer), JSZip, Jest, npm, Node 20+

**Reference docs:** `docs/prd.md`, `docs/spec.md`, `docs/compliance.md`

---

## Scope Locks for v0.1

- ✅ Programmatic `dataSubject.register(...)` with executor callbacks
- ✅ `fromPrisma()` helper (optional import, thin wrapper)
- ✅ Three strategies (`delete` | `anonymize` | `retain`) with legal-basis validation
- ✅ Export (JSON zip + sha256), Erase (batch + verification scan)
- ✅ `DataSubjectRequest` lifecycle + overdue query
- ✅ Outbox + audit hook callbacks
- ❌ `@DataSubjectEntity` decorator path — v0.2
- ❌ CLI build-time lint — v0.2
- ❌ S3 storage adapter — v0.2 (InMemory + interface only in v0.1)

---

## File Structure

```
data-subject/
├── package.json
├── tsconfig.json
├── tsconfig.build.json
├── jest.config.ts
├── .prettierrc
├── .eslintrc.cjs
├── prisma/
│   └── schema.example.prisma
├── src/
│   ├── index.ts
│   ├── types.ts                       # strategies, policy, request, stats
│   ├── errors.ts                      # typed errors with codes
│   ├── legal-basis.ts                 # validator for "scheme:jurisdiction-ref"
│   ├── policy-compiler.ts             # validates + normalizes policy spec
│   ├── registry.ts                    # register / lookup / list entities
│   ├── storage/
│   │   ├── request-storage.interface.ts
│   │   ├── in-memory-request-storage.ts
│   │   ├── artifact-storage.interface.ts
│   │   └── in-memory-artifact-storage.ts
│   ├── export-runner.ts               # select → JSON → zip → hash
│   ├── erase-runner.ts                # apply strategies → verification scan
│   ├── data-subject.service.ts        # facade orchestrator
│   ├── data-subject.module.ts         # NestJS forRoot
│   ├── prisma/
│   │   └── from-prisma.ts             # optional helper
│   └── lint/
│       └── registry-lint.ts           # programmatic: registry vs known entities
├── test/
│   ├── fixtures.ts
│   ├── contract/
│   │   ├── request-storage-contract.ts
│   │   └── artifact-storage-contract.ts
│   └── integration/
│       ├── in-memory-request-storage.test.ts
│       ├── in-memory-artifact-storage.test.ts
│       ├── export-runner.test.ts
│       ├── erase-runner.test.ts
│       └── data-subject.service.test.ts
└── docs/
    └── (prd.md, spec.md, compliance.md already exist)
```

Each file has one clear responsibility. Storage abstractions isolate DB concerns from flow logic. Two contract suites (request-storage, artifact-storage) prove alternate implementations remain interchangeable.

---

## Task 1: Project Bootstrap

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `jest.config.ts`, `.prettierrc`, `.eslintrc.cjs`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@nestarc/data-subject",
  "version": "0.1.0-alpha.0",
  "description": "DPA-ready GDPR/CCPA toolkit for NestJS + Prisma. Entity registry, export/erase lifecycle, legal retention, outbox fan-out.",
  "license": "MIT",
  "author": "nestarc",
  "repository": "github:nestarc/data-subject",
  "engines": { "node": ">=20" },
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist", "README.md", "LICENSE"],
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "test": "jest",
    "test:watch": "jest --watch",
    "lint": "eslint 'src/**/*.ts' 'test/**/*.ts'",
    "format": "prettier --write 'src/**/*.ts' 'test/**/*.ts'",
    "prepublishOnly": "npm run build"
  },
  "dependencies": {
    "jszip": "^3.10.1"
  },
  "peerDependencies": {
    "@nestjs/common": "^10.0.0",
    "@nestjs/core": "^10.0.0",
    "@prisma/client": "^5.0.0",
    "reflect-metadata": "^0.2.0",
    "rxjs": "^7.0.0"
  },
  "peerDependenciesMeta": {
    "@prisma/client": { "optional": true }
  },
  "devDependencies": {
    "@nestjs/common": "^10.3.0",
    "@nestjs/core": "^10.3.0",
    "@nestjs/testing": "^10.3.0",
    "@prisma/client": "^5.10.0",
    "@types/jest": "^29.5.12",
    "@types/node": "^20.11.0",
    "@typescript-eslint/eslint-plugin": "^7.0.0",
    "@typescript-eslint/parser": "^7.0.0",
    "eslint": "^8.56.0",
    "jest": "^29.7.0",
    "prettier": "^3.2.0",
    "reflect-metadata": "^0.2.1",
    "rxjs": "^7.8.1",
    "ts-jest": "^29.1.2",
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "declaration": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "moduleResolution": "node",
    "resolveJsonModule": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "test"]
}
```

- [ ] **Step 3: Create tsconfig.build.json**

```json
{
  "extends": "./tsconfig.json",
  "exclude": ["node_modules", "dist", "test", "**/*.test.ts"]
}
```

- [ ] **Step 4: Create jest.config.ts**

```typescript
import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts', '!src/index.ts'],
  coverageDirectory: 'coverage',
};

export default config;
```

- [ ] **Step 5: Create .prettierrc**

```json
{
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100
}
```

- [ ] **Step 6: Create .eslintrc.cjs**

```javascript
module.exports = {
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: { node: true, jest: true, es2022: true },
  rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
  },
};
```

- [ ] **Step 7: Install dependencies**

Run:
```bash
cd C:/Users/ksy/Documents/GitHub/data-subject
npm install
```
Expected: all packages install.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json tsconfig.build.json jest.config.ts .prettierrc .eslintrc.cjs
git commit -m "chore: initial project bootstrap"
```

---

## Task 2: Core Types

**Files:**
- Create: `src/types.ts`

- [ ] **Step 1: Create src/types.ts**

```typescript
export type Strategy = 'delete' | 'anonymize' | 'retain';

export type PolicyEntry =
  | 'delete'
  | { strategy: 'delete' }
  | { strategy: 'anonymize'; replacement: string | number | null }
  | {
      strategy: 'retain';
      legalBasis: string;
      until?: string;
      pseudonymize?: 'hmac' | 'none';
    };

export interface EntityPolicy {
  entityName: string;
  subjectField: string;
  rowLevel?: 'delete-row' | 'delete-fields';
  fields: Record<string, PolicyEntry>;
}

export interface EntityExecutor {
  select(subjectId: string, tenantId: string): Promise<Record<string, unknown>[]>;
  erase(subjectId: string, tenantId: string, rowLevel: 'delete-row' | 'delete-fields'): Promise<number>;
  anonymize(subjectId: string, tenantId: string, replacements: Record<string, unknown>): Promise<number>;
}

export interface RegisteredEntity {
  policy: EntityPolicy;
  executor: EntityExecutor;
}

export type RequestType = 'export' | 'erase';
export type RequestState = 'created' | 'validating' | 'processing' | 'completed' | 'failed';

export interface DataSubjectRequest {
  id: string;
  tenantId: string;
  subjectId: string;
  type: RequestType;
  state: RequestState;
  createdAt: Date;
  dueAt: Date;
  completedAt: Date | null;
  failedAt: Date | null;
  failureReason: string | null;
  artifactHash: string | null;
  artifactUrl: string | null;
  stats: RequestStats | null;
  requestedBy: string | null;
}

export interface RequestStats {
  entities: Array<{
    entityName: string;
    affected: number;
    strategy: Strategy | 'mixed';
  }>;
  retained?: Array<{ entityName: string; field: string; legalBasis: string; count: number }>;
  verificationResidual?: Array<{ entityName: string; count: number }>;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/types.ts
git commit -m "feat: core types for policy, request, stats"
```

---

## Task 3: Errors

**Files:**
- Create: `src/errors.ts`
- Test: `src/errors.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/errors.test.ts
import { DataSubjectError, DataSubjectErrorCode } from './errors';

describe('DataSubjectError', () => {
  it('carries a code and http status', () => {
    const err = new DataSubjectError(DataSubjectErrorCode.SubjectNotFound);
    expect(err.code).toBe('dsr_subject_not_found');
    expect(err.httpStatus).toBe(404);
  });

  it('invalid policy maps to 500', () => {
    const err = new DataSubjectError(DataSubjectErrorCode.InvalidPolicy);
    expect(err.httpStatus).toBe(500);
  });

  it('preserves an optional reason', () => {
    const err = new DataSubjectError(DataSubjectErrorCode.InvalidPolicy, 'missing legalBasis');
    expect(err.message).toContain('missing legalBasis');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/errors.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement src/errors.ts**

```typescript
export const DataSubjectErrorCode = {
  SubjectNotFound: 'dsr_subject_not_found',
  UnregisteredEntity: 'dsr_unregistered_entity',
  InvalidPolicy: 'dsr_invalid_policy',
  VerificationFailed: 'dsr_verification_failed',
  AnonymizeDynamicReplacement: 'dsr_anonymize_dynamic_replacement',
} as const;

export type DataSubjectErrorCode = (typeof DataSubjectErrorCode)[keyof typeof DataSubjectErrorCode];

const HTTP_STATUS: Record<DataSubjectErrorCode, number> = {
  dsr_subject_not_found: 404,
  dsr_unregistered_entity: 500,
  dsr_invalid_policy: 500,
  dsr_verification_failed: 500,
  dsr_anonymize_dynamic_replacement: 500,
};

export class DataSubjectError extends Error {
  readonly code: DataSubjectErrorCode;
  readonly httpStatus: number;

  constructor(code: DataSubjectErrorCode, reason?: string) {
    super(reason ? `${code}: ${reason}` : code);
    this.name = 'DataSubjectError';
    this.code = code;
    this.httpStatus = HTTP_STATUS[code];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/errors.test.ts`
Expected: PASS, 3/3.

- [ ] **Step 5: Commit**

```bash
git add src/errors.ts src/errors.test.ts
git commit -m "feat: typed error codes"
```

---

## Task 4: Legal Basis Validator

**Files:**
- Create: `src/legal-basis.ts`
- Test: `src/legal-basis.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/legal-basis.test.ts
import { validateLegalBasis, LegalBasisOptions } from './legal-basis';

describe('validateLegalBasis (non-strict)', () => {
  it('accepts any non-empty string', () => {
    expect(validateLegalBasis('tax:KR-basic-law-§85')).toBeNull();
    expect(validateLegalBasis('accountability')).toBeNull();
  });

  it('rejects empty string', () => {
    expect(validateLegalBasis('')).toMatch(/empty/);
  });

  it('rejects whitespace-only', () => {
    expect(validateLegalBasis('   ')).toMatch(/empty/);
  });
});

describe('validateLegalBasis (strict)', () => {
  const opts: LegalBasisOptions = { strict: true };

  it('requires scheme:jurisdiction-reference form', () => {
    expect(validateLegalBasis('tax:KR-basic-law-§85', opts)).toBeNull();
    expect(validateLegalBasis('accountability:gdpr-art-5-2', opts)).toBeNull();
  });

  it('rejects missing scheme', () => {
    expect(validateLegalBasis('tax-records', opts)).toMatch(/scheme/);
  });

  it('rejects missing reference', () => {
    expect(validateLegalBasis('tax:', opts)).toMatch(/reference/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/legal-basis.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement src/legal-basis.ts**

```typescript
export interface LegalBasisOptions {
  strict?: boolean;
}

const STRICT_FORMAT = /^[a-z][a-z0-9-]*:[^\s].*$/i;

export function validateLegalBasis(value: string, opts: LegalBasisOptions = {}): string | null {
  if (!value || value.trim().length === 0) {
    return 'legalBasis is empty';
  }
  if (opts.strict) {
    if (!value.includes(':')) {
      return 'legalBasis missing scheme (expected "scheme:reference")';
    }
    const [, ref] = value.split(':', 2);
    if (!ref || ref.trim().length === 0) {
      return 'legalBasis missing reference after scheme';
    }
    if (!STRICT_FORMAT.test(value)) {
      return 'legalBasis does not match "scheme:reference" format';
    }
  }
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/legal-basis.test.ts`
Expected: PASS, 6/6.

- [ ] **Step 5: Commit**

```bash
git add src/legal-basis.ts src/legal-basis.test.ts
git commit -m "feat: legalBasis validator with strict mode"
```

---

## Task 5: Policy Compiler

**Files:**
- Create: `src/policy-compiler.ts`
- Test: `src/policy-compiler.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/policy-compiler.test.ts
import { compilePolicy } from './policy-compiler';
import { DataSubjectError } from './errors';

describe('compilePolicy', () => {
  it('normalizes shorthand "delete" to { strategy: "delete" }', () => {
    const p = compilePolicy({
      entityName: 'User',
      subjectField: 'userId',
      fields: { email: 'delete' },
    });
    expect(p.fields.email).toEqual({ strategy: 'delete' });
  });

  it('accepts anonymize with static replacement', () => {
    const p = compilePolicy({
      entityName: 'User',
      subjectField: 'userId',
      fields: { email: { strategy: 'anonymize', replacement: '[REDACTED]' } },
    });
    expect(p.fields.email).toEqual({ strategy: 'anonymize', replacement: '[REDACTED]' });
  });

  it('rejects anonymize with function replacement', () => {
    expect(() =>
      compilePolicy({
        entityName: 'User',
        subjectField: 'userId',
        fields: {
          email: {
            strategy: 'anonymize',
            replacement: (() => 'x') as unknown as string,
          },
        },
      }),
    ).toThrow(DataSubjectError);
  });

  it('requires legalBasis for retain', () => {
    expect(() =>
      compilePolicy({
        entityName: 'Invoice',
        subjectField: 'customerId',
        fields: { amount: { strategy: 'retain' } as never },
      }),
    ).toThrow(/legalBasis/);
  });

  it('accepts retain with legalBasis', () => {
    const p = compilePolicy({
      entityName: 'Invoice',
      subjectField: 'customerId',
      fields: {
        amount: { strategy: 'retain', legalBasis: 'tax:KR-basic-law-§85', until: '+7y' },
      },
    });
    expect(p.fields.amount).toMatchObject({ strategy: 'retain', legalBasis: 'tax:KR-basic-law-§85' });
  });

  it('defaults rowLevel to "delete-fields"', () => {
    const p = compilePolicy({
      entityName: 'User',
      subjectField: 'userId',
      fields: { email: 'delete' },
    });
    expect(p.rowLevel).toBe('delete-fields');
  });

  it('applies strict legalBasis when option set', () => {
    expect(() =>
      compilePolicy(
        {
          entityName: 'Invoice',
          subjectField: 'customerId',
          fields: { amount: { strategy: 'retain', legalBasis: 'bare-string' } },
        },
        { strictLegalBasis: true },
      ),
    ).toThrow(/scheme/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/policy-compiler.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement src/policy-compiler.ts**

```typescript
import { DataSubjectError, DataSubjectErrorCode } from './errors';
import { validateLegalBasis } from './legal-basis';
import type { EntityPolicy, PolicyEntry } from './types';

export interface CompileOptions {
  strictLegalBasis?: boolean;
}

export interface PolicySpec {
  entityName: string;
  subjectField: string;
  rowLevel?: 'delete-row' | 'delete-fields';
  fields: Record<string, PolicyEntry>;
}

export function compilePolicy(spec: PolicySpec, opts: CompileOptions = {}): EntityPolicy {
  const fields: Record<string, PolicyEntry> = {};
  for (const [name, raw] of Object.entries(spec.fields)) {
    fields[name] = normalizeEntry(spec.entityName, name, raw, opts);
  }
  return {
    entityName: spec.entityName,
    subjectField: spec.subjectField,
    rowLevel: spec.rowLevel ?? 'delete-fields',
    fields,
  };
}

function normalizeEntry(
  entityName: string,
  fieldName: string,
  entry: PolicyEntry,
  opts: CompileOptions,
): PolicyEntry {
  if (entry === 'delete') return { strategy: 'delete' };

  if (entry.strategy === 'delete') return { strategy: 'delete' };

  if (entry.strategy === 'anonymize') {
    if (typeof entry.replacement === 'function') {
      throw new DataSubjectError(
        DataSubjectErrorCode.AnonymizeDynamicReplacement,
        `${entityName}.${fieldName}: replacement must be static`,
      );
    }
    return { strategy: 'anonymize', replacement: entry.replacement };
  }

  if (entry.strategy === 'retain') {
    const basis = (entry as { legalBasis?: string }).legalBasis;
    if (!basis) {
      throw new DataSubjectError(
        DataSubjectErrorCode.InvalidPolicy,
        `${entityName}.${fieldName}: retain requires legalBasis`,
      );
    }
    const err = validateLegalBasis(basis, { strict: opts.strictLegalBasis });
    if (err) {
      throw new DataSubjectError(
        DataSubjectErrorCode.InvalidPolicy,
        `${entityName}.${fieldName}: ${err}`,
      );
    }
    return {
      strategy: 'retain',
      legalBasis: basis,
      until: entry.until,
      pseudonymize: entry.pseudonymize ?? 'none',
    };
  }

  throw new DataSubjectError(
    DataSubjectErrorCode.InvalidPolicy,
    `${entityName}.${fieldName}: unknown strategy`,
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/policy-compiler.test.ts`
Expected: PASS, 7/7.

- [ ] **Step 5: Commit**

```bash
git add src/policy-compiler.ts src/policy-compiler.test.ts
git commit -m "feat: policy compiler with strategy normalization and validation"
```

---

## Task 6: Registry

**Files:**
- Create: `src/registry.ts`
- Test: `src/registry.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/registry.test.ts
import { Registry } from './registry';
import type { EntityExecutor } from './types';

const noopExec: EntityExecutor = {
  select: async () => [],
  erase: async () => 0,
  anonymize: async () => 0,
};

describe('Registry', () => {
  it('registers and retrieves an entity', () => {
    const r = new Registry();
    r.register({
      policy: {
        entityName: 'User',
        subjectField: 'userId',
        fields: { email: 'delete' },
      },
      executor: noopExec,
    });
    const entry = r.get('User');
    expect(entry?.policy.entityName).toBe('User');
  });

  it('rejects duplicate entity names', () => {
    const r = new Registry();
    r.register({
      policy: { entityName: 'User', subjectField: 'userId', fields: { email: 'delete' } },
      executor: noopExec,
    });
    expect(() =>
      r.register({
        policy: { entityName: 'User', subjectField: 'userId', fields: { name: 'delete' } },
        executor: noopExec,
      }),
    ).toThrow(/already registered/);
  });

  it('list returns all registered entries', () => {
    const r = new Registry();
    r.register({
      policy: { entityName: 'User', subjectField: 'userId', fields: { email: 'delete' } },
      executor: noopExec,
    });
    r.register({
      policy: { entityName: 'Invoice', subjectField: 'customerId', fields: { note: 'delete' } },
      executor: noopExec,
    });
    expect(r.list().map((e) => e.policy.entityName).sort()).toEqual(['Invoice', 'User']);
  });

  it('compiles policy on registration (strict mode propagates)', () => {
    const r = new Registry({ strictLegalBasis: true });
    expect(() =>
      r.register({
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/registry.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement src/registry.ts**

```typescript
import { compilePolicy, CompileOptions, PolicySpec } from './policy-compiler';
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/registry.test.ts`
Expected: PASS, 4/4.

- [ ] **Step 5: Commit**

```bash
git add src/registry.ts src/registry.test.ts
git commit -m "feat: entity registry with duplicate guard and strict compile"
```

---

## Task 7: Request Storage (Interface + Contract)

**Files:**
- Create: `src/storage/request-storage.interface.ts`
- Create: `test/contract/request-storage-contract.ts`

- [ ] **Step 1: Define the request storage interface**

```typescript
// src/storage/request-storage.interface.ts
import type { DataSubjectRequest, RequestState } from '../types';

export interface RequestStorage {
  insert(req: DataSubjectRequest): Promise<void>;
  update(id: string, patch: Partial<DataSubjectRequest>): Promise<void>;
  findById(id: string): Promise<DataSubjectRequest | null>;
  listByTenant(tenantId: string, opts?: { state?: RequestState }): Promise<DataSubjectRequest[]>;
  listOverdue(now: Date): Promise<DataSubjectRequest[]>;
}
```

- [ ] **Step 2: Write the reusable contract suite**

```typescript
// test/contract/request-storage-contract.ts
import type { RequestStorage } from '../../src/storage/request-storage.interface';
import type { DataSubjectRequest } from '../../src/types';

function fixture(overrides: Partial<DataSubjectRequest> = {}): DataSubjectRequest {
  return {
    id: 'dsr_1',
    tenantId: 'tenant_1',
    subjectId: 'subject_1',
    type: 'export',
    state: 'created',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    dueAt: new Date('2026-01-31T00:00:00Z'),
    completedAt: null,
    failedAt: null,
    failureReason: null,
    artifactHash: null,
    artifactUrl: null,
    stats: null,
    requestedBy: null,
    ...overrides,
  };
}

export function requestStorageContract(name: string, factory: () => RequestStorage): void {
  describe(`RequestStorage contract: ${name}`, () => {
    let storage: RequestStorage;
    beforeEach(() => {
      storage = factory();
    });

    it('insert + findById round-trips', async () => {
      await storage.insert(fixture());
      const r = await storage.findById('dsr_1');
      expect(r?.state).toBe('created');
    });

    it('findById returns null for missing', async () => {
      expect(await storage.findById('missing')).toBeNull();
    });

    it('update patches fields', async () => {
      await storage.insert(fixture());
      await storage.update('dsr_1', { state: 'processing' });
      const r = await storage.findById('dsr_1');
      expect(r?.state).toBe('processing');
    });

    it('listByTenant filters by state', async () => {
      await storage.insert(fixture({ id: 'a', state: 'created' }));
      await storage.insert(fixture({ id: 'b', state: 'completed' }));
      const done = await storage.listByTenant('tenant_1', { state: 'completed' });
      expect(done.map((r) => r.id)).toEqual(['b']);
    });

    it('listOverdue returns pending requests past dueAt', async () => {
      await storage.insert(
        fixture({
          id: 'a',
          dueAt: new Date('2025-12-01T00:00:00Z'),
          state: 'processing',
        }),
      );
      await storage.insert(
        fixture({ id: 'b', dueAt: new Date('2027-01-01T00:00:00Z'), state: 'processing' }),
      );
      await storage.insert(
        fixture({ id: 'c', dueAt: new Date('2025-12-01T00:00:00Z'), state: 'completed' }),
      );
      const overdue = await storage.listOverdue(new Date('2026-06-01T00:00:00Z'));
      expect(overdue.map((r) => r.id)).toEqual(['a']);
    });
  });
}
```

- [ ] **Step 3: Commit**

```bash
git add src/storage/request-storage.interface.ts test/contract/request-storage-contract.ts
git commit -m "feat: request storage interface with contract suite"
```

---

## Task 8: InMemory Request Storage

**Files:**
- Create: `src/storage/in-memory-request-storage.ts`
- Test: `test/integration/in-memory-request-storage.test.ts`

- [ ] **Step 1: Write the test that runs the contract**

```typescript
// test/integration/in-memory-request-storage.test.ts
import { InMemoryRequestStorage } from '../../src/storage/in-memory-request-storage';
import { requestStorageContract } from '../contract/request-storage-contract';

requestStorageContract('InMemoryRequestStorage', () => new InMemoryRequestStorage());
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/integration/in-memory-request-storage.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement src/storage/in-memory-request-storage.ts**

```typescript
import type { RequestStorage } from './request-storage.interface';
import type { DataSubjectRequest, RequestState } from '../types';

const PENDING: RequestState[] = ['created', 'validating', 'processing'];

export class InMemoryRequestStorage implements RequestStorage {
  private readonly store = new Map<string, DataSubjectRequest>();

  async insert(req: DataSubjectRequest): Promise<void> {
    if (this.store.has(req.id)) throw new Error(`duplicate id: ${req.id}`);
    this.store.set(req.id, { ...req });
  }

  async update(id: string, patch: Partial<DataSubjectRequest>): Promise<void> {
    const r = this.store.get(id);
    if (!r) throw new Error(`not found: ${id}`);
    Object.assign(r, patch);
  }

  async findById(id: string): Promise<DataSubjectRequest | null> {
    const r = this.store.get(id);
    return r ? { ...r } : null;
  }

  async listByTenant(
    tenantId: string,
    opts: { state?: RequestState } = {},
  ): Promise<DataSubjectRequest[]> {
    return [...this.store.values()]
      .filter((r) => r.tenantId === tenantId)
      .filter((r) => (opts.state ? r.state === opts.state : true))
      .map((r) => ({ ...r }));
  }

  async listOverdue(now: Date): Promise<DataSubjectRequest[]> {
    return [...this.store.values()]
      .filter((r) => PENDING.includes(r.state) && r.dueAt.getTime() < now.getTime())
      .map((r) => ({ ...r }));
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/integration/in-memory-request-storage.test.ts`
Expected: PASS, 5/5 contract cases.

- [ ] **Step 5: Commit**

```bash
git add src/storage/in-memory-request-storage.ts test/integration/in-memory-request-storage.test.ts
git commit -m "feat: in-memory request storage passing contract"
```

---

## Task 9: Artifact Storage (Interface + Contract + InMemory)

**Files:**
- Create: `src/storage/artifact-storage.interface.ts`
- Create: `src/storage/in-memory-artifact-storage.ts`
- Create: `test/contract/artifact-storage-contract.ts`
- Test: `test/integration/in-memory-artifact-storage.test.ts`

- [ ] **Step 1: Define the artifact storage interface**

```typescript
// src/storage/artifact-storage.interface.ts
export interface ArtifactStorage {
  put(key: string, body: Buffer, contentType: string): Promise<string>;
  get(key: string): Promise<{ body: Buffer; contentType: string } | null>;
}
```

- [ ] **Step 2: Write the contract suite**

```typescript
// test/contract/artifact-storage-contract.ts
import type { ArtifactStorage } from '../../src/storage/artifact-storage.interface';

export function artifactStorageContract(name: string, factory: () => ArtifactStorage): void {
  describe(`ArtifactStorage contract: ${name}`, () => {
    let s: ArtifactStorage;
    beforeEach(() => {
      s = factory();
    });

    it('put returns a URL-like string', async () => {
      const url = await s.put('k1', Buffer.from('hi'), 'text/plain');
      expect(typeof url).toBe('string');
      expect(url.length).toBeGreaterThan(0);
    });

    it('put + get round-trips content', async () => {
      await s.put('k1', Buffer.from('hello'), 'application/zip');
      const result = await s.get('k1');
      expect(result?.body.toString()).toBe('hello');
      expect(result?.contentType).toBe('application/zip');
    });

    it('get returns null for missing key', async () => {
      expect(await s.get('missing')).toBeNull();
    });
  });
}
```

- [ ] **Step 3: Implement in-memory artifact storage**

```typescript
// src/storage/in-memory-artifact-storage.ts
import type { ArtifactStorage } from './artifact-storage.interface';

export class InMemoryArtifactStorage implements ArtifactStorage {
  private readonly store = new Map<string, { body: Buffer; contentType: string }>();

  async put(key: string, body: Buffer, contentType: string): Promise<string> {
    this.store.set(key, { body, contentType });
    return `memory://${key}`;
  }

  async get(key: string): Promise<{ body: Buffer; contentType: string } | null> {
    return this.store.get(key) ?? null;
  }
}
```

- [ ] **Step 4: Run contract against in-memory**

```typescript
// test/integration/in-memory-artifact-storage.test.ts
import { InMemoryArtifactStorage } from '../../src/storage/in-memory-artifact-storage';
import { artifactStorageContract } from '../contract/artifact-storage-contract';

artifactStorageContract('InMemoryArtifactStorage', () => new InMemoryArtifactStorage());
```

- [ ] **Step 5: Run tests**

Run: `npm test -- test/integration/in-memory-artifact-storage.test.ts`
Expected: PASS, 3/3.

- [ ] **Step 6: Commit**

```bash
git add src/storage/artifact-storage.interface.ts src/storage/in-memory-artifact-storage.ts test/contract/artifact-storage-contract.ts test/integration/in-memory-artifact-storage.test.ts
git commit -m "feat: artifact storage interface and in-memory impl"
```

---

## Task 10: Export Runner

**Files:**
- Create: `src/export-runner.ts`
- Test: `test/integration/export-runner.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// test/integration/export-runner.test.ts
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { ExportRunner } from '../../src/export-runner';
import { Registry } from '../../src/registry';
import { InMemoryArtifactStorage } from '../../src/storage/in-memory-artifact-storage';
import type { EntityExecutor } from '../../src/types';

function mockExecutor(rows: Record<string, unknown>[]): EntityExecutor {
  return {
    select: async () => rows,
    erase: async () => 0,
    anonymize: async () => 0,
  };
}

describe('ExportRunner', () => {
  it('collects rows across registered entities into a zip', async () => {
    const registry = new Registry();
    registry.register({
      policy: { entityName: 'User', subjectField: 'userId', fields: { email: 'delete' } },
      executor: mockExecutor([{ id: 'u1', email: 'a@b.com' }]),
    });
    registry.register({
      policy: { entityName: 'Order', subjectField: 'customerId', fields: { note: 'delete' } },
      executor: mockExecutor([{ id: 'o1', note: 'test' }]),
    });
    const artifacts = new InMemoryArtifactStorage();
    const runner = new ExportRunner(registry, artifacts);

    const result = await runner.run('dsr_1', 'subject_1', 'tenant_1');

    expect(result.artifactHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.stats.entities.map((e) => e.entityName).sort()).toEqual(['Order', 'User']);

    const stored = await artifacts.get('dsr_1.zip');
    expect(stored).not.toBeNull();
    const zip = await JSZip.loadAsync(stored!.body);
    const userJson = await zip.file('User.json')?.async('string');
    expect(JSON.parse(userJson!)[0].email).toBe('a@b.com');
  });

  it('verifies hash matches the stored zip bytes', async () => {
    const registry = new Registry();
    registry.register({
      policy: { entityName: 'User', subjectField: 'userId', fields: { email: 'delete' } },
      executor: mockExecutor([{ id: 'u1' }]),
    });
    const artifacts = new InMemoryArtifactStorage();
    const runner = new ExportRunner(registry, artifacts);
    const result = await runner.run('dsr_2', 'subject_1', 'tenant_1');
    const stored = await artifacts.get('dsr_2.zip');
    const expected = createHash('sha256').update(stored!.body).digest('hex');
    expect(result.artifactHash).toBe(expected);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/integration/export-runner.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement src/export-runner.ts**

```typescript
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import type { Registry } from './registry';
import type { ArtifactStorage } from './storage/artifact-storage.interface';
import type { RequestStats } from './types';

export interface ExportResult {
  artifactHash: string;
  artifactUrl: string;
  stats: RequestStats;
}

export class ExportRunner {
  constructor(
    private readonly registry: Registry,
    private readonly artifacts: ArtifactStorage,
  ) {}

  async run(requestId: string, subjectId: string, tenantId: string): Promise<ExportResult> {
    const zip = new JSZip();
    const entities: RequestStats['entities'] = [];

    for (const entry of this.registry.list()) {
      const rows = await entry.executor.select(subjectId, tenantId);
      zip.file(`${entry.policy.entityName}.json`, JSON.stringify(rows, null, 2));
      entities.push({
        entityName: entry.policy.entityName,
        affected: rows.length,
        strategy: 'delete',
      });
    }

    const body = await zip.generateAsync({ type: 'nodebuffer' });
    const hash = createHash('sha256').update(body).digest('hex');
    const url = await this.artifacts.put(`${requestId}.zip`, body, 'application/zip');

    return { artifactHash: hash, artifactUrl: url, stats: { entities } };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/integration/export-runner.test.ts`
Expected: PASS, 2/2.

- [ ] **Step 5: Commit**

```bash
git add src/export-runner.ts test/integration/export-runner.test.ts
git commit -m "feat: export runner builds zipped artifact with sha256"
```

---

## Task 11: Erase Runner

**Files:**
- Create: `src/erase-runner.ts`
- Test: `test/integration/erase-runner.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// test/integration/erase-runner.test.ts
import { EraseRunner } from '../../src/erase-runner';
import { Registry } from '../../src/registry';
import type { EntityExecutor } from '../../src/types';
import { DataSubjectError } from '../../src/errors';

function makeExec(initial: Record<string, unknown>[]): {
  executor: EntityExecutor;
  state: { rows: Record<string, unknown>[] };
} {
  const state = { rows: [...initial] };
  return {
    state,
    executor: {
      select: async () => state.rows.map((r) => ({ ...r })),
      erase: async () => {
        const n = state.rows.length;
        state.rows = [];
        return n;
      },
      anonymize: async (_s, _t, replacements) => {
        let n = 0;
        state.rows = state.rows.map((r) => {
          n++;
          return { ...r, ...replacements };
        });
        return n;
      },
    },
  };
}

describe('EraseRunner', () => {
  it('deletes matching rows and records stats', async () => {
    const registry = new Registry();
    const user = makeExec([{ id: 'u1', email: 'a@b.com' }]);
    registry.register({
      policy: { entityName: 'User', subjectField: 'userId', fields: { email: 'delete' } },
      executor: user.executor,
    });

    const runner = new EraseRunner(registry);
    const result = await runner.run('subject_1', 'tenant_1');

    expect(user.state.rows.length).toBe(0);
    expect(result.stats.entities).toEqual([
      { entityName: 'User', affected: 1, strategy: 'delete' },
    ]);
    expect(result.stats.verificationResidual).toEqual([]);
  });

  it('anonymizes rows with static replacement', async () => {
    const registry = new Registry();
    const user = makeExec([{ id: 'u1', email: 'a@b.com' }]);
    registry.register({
      policy: {
        entityName: 'User',
        subjectField: 'userId',
        fields: { email: { strategy: 'anonymize', replacement: '[REDACTED]' } },
      },
      executor: user.executor,
    });

    const runner = new EraseRunner(registry);
    const result = await runner.run('subject_1', 'tenant_1');

    expect(user.state.rows[0].email).toBe('[REDACTED]');
    expect(result.stats.entities[0].strategy).toBe('anonymize');
  });

  it('retains rows and records legalBasis', async () => {
    const registry = new Registry();
    const inv = makeExec([{ id: 'i1', amount: 100 }]);
    registry.register({
      policy: {
        entityName: 'Invoice',
        subjectField: 'customerId',
        fields: {
          amount: { strategy: 'retain', legalBasis: 'tax:KR-basic-law-§85' },
        },
      },
      executor: inv.executor,
    });

    const runner = new EraseRunner(registry);
    const result = await runner.run('subject_1', 'tenant_1');

    expect(inv.state.rows.length).toBe(1);
    expect(result.stats.retained).toEqual([
      { entityName: 'Invoice', field: 'amount', legalBasis: 'tax:KR-basic-law-§85', count: 1 },
    ]);
  });

  it('fails verification when delete leaves residuals', async () => {
    const registry = new Registry();
    const broken: EntityExecutor = {
      select: async () => [{ id: 'u1' }],
      erase: async () => 0,
      anonymize: async () => 0,
    };
    registry.register({
      policy: { entityName: 'User', subjectField: 'userId', fields: { email: 'delete' } },
      executor: broken,
    });

    const runner = new EraseRunner(registry);
    await expect(runner.run('subject_1', 'tenant_1')).rejects.toThrow(DataSubjectError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/integration/erase-runner.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement src/erase-runner.ts**

```typescript
import { DataSubjectError, DataSubjectErrorCode } from './errors';
import type { Registry } from './registry';
import type { EntityPolicy, PolicyEntry, RequestStats, Strategy } from './types';

export interface EraseResult {
  stats: RequestStats;
}

export class EraseRunner {
  constructor(private readonly registry: Registry) {}

  async run(subjectId: string, tenantId: string): Promise<EraseResult> {
    const entities: RequestStats['entities'] = [];
    const retained: NonNullable<RequestStats['retained']> = [];

    for (const entry of this.registry.list()) {
      const outcome = classify(entry.policy);
      let affected = 0;
      let strategy: Strategy | 'mixed' = outcome.rowStrategy;

      if (outcome.rowStrategy === 'delete') {
        affected = await entry.executor.erase(subjectId, tenantId, entry.policy.rowLevel ?? 'delete-fields');
      } else if (outcome.rowStrategy === 'anonymize') {
        affected = await entry.executor.anonymize(subjectId, tenantId, outcome.anonymizeMap);
      } else {
        // retain-only: no mutation, record basis
        const rows = await entry.executor.select(subjectId, tenantId);
        affected = rows.length;
      }

      for (const r of outcome.retained) {
        const count = await entry.executor.select(subjectId, tenantId).then((rows) => rows.length);
        retained.push({
          entityName: entry.policy.entityName,
          field: r.field,
          legalBasis: r.legalBasis,
          count,
        });
      }

      entities.push({ entityName: entry.policy.entityName, affected, strategy });
    }

    const residual: NonNullable<RequestStats['verificationResidual']> = [];
    for (const entry of this.registry.list()) {
      const outcome = classify(entry.policy);
      if (outcome.rowStrategy !== 'delete') continue;
      const rows = await entry.executor.select(subjectId, tenantId);
      if (rows.length > 0) {
        residual.push({ entityName: entry.policy.entityName, count: rows.length });
      }
    }

    if (residual.length > 0) {
      throw new DataSubjectError(
        DataSubjectErrorCode.VerificationFailed,
        `residual rows: ${residual.map((r) => `${r.entityName}(${r.count})`).join(', ')}`,
      );
    }

    return { stats: { entities, retained, verificationResidual: residual } };
  }
}

interface Outcome {
  rowStrategy: Strategy;
  anonymizeMap: Record<string, unknown>;
  retained: Array<{ field: string; legalBasis: string }>;
}

function classify(policy: EntityPolicy): Outcome {
  const anonymizeMap: Record<string, unknown> = {};
  const retained: Outcome['retained'] = [];
  const strategies = new Set<Strategy>();

  for (const [field, entry] of Object.entries(policy.fields)) {
    const normalized = normalize(entry);
    strategies.add(normalized.strategy);
    if (normalized.strategy === 'anonymize') {
      anonymizeMap[field] = (entry as { replacement: unknown }).replacement;
    }
    if (normalized.strategy === 'retain') {
      retained.push({ field, legalBasis: (entry as { legalBasis: string }).legalBasis });
    }
  }

  const hasDelete = strategies.has('delete');
  const hasAnonymize = strategies.has('anonymize');
  const hasRetainOnly = strategies.size === 1 && strategies.has('retain');

  const rowStrategy: Strategy = hasDelete
    ? 'delete'
    : hasAnonymize
      ? 'anonymize'
      : 'retain';

  return { rowStrategy, anonymizeMap, retained: hasRetainOnly || retained.length > 0 ? retained : [] };
}

function normalize(entry: PolicyEntry): { strategy: Strategy } {
  if (entry === 'delete') return { strategy: 'delete' };
  return { strategy: entry.strategy };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/integration/erase-runner.test.ts`
Expected: PASS, 4/4.

- [ ] **Step 5: Commit**

```bash
git add src/erase-runner.ts test/integration/erase-runner.test.ts
git commit -m "feat: erase runner with strategy classification and verification scan"
```

---

## Task 12: DataSubjectService Facade

**Files:**
- Create: `src/data-subject.service.ts`
- Test: `test/integration/data-subject.service.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// test/integration/data-subject.service.test.ts
import { DataSubjectService } from '../../src/data-subject.service';
import { Registry } from '../../src/registry';
import { InMemoryRequestStorage } from '../../src/storage/in-memory-request-storage';
import { InMemoryArtifactStorage } from '../../src/storage/in-memory-artifact-storage';
import type { EntityExecutor } from '../../src/types';

function makeExec(rows: Record<string, unknown>[]): EntityExecutor {
  const state = { rows: [...rows] };
  return {
    select: async () => [...state.rows],
    erase: async () => {
      const n = state.rows.length;
      state.rows = [];
      return n;
    },
    anonymize: async () => 0,
  };
}

function svc() {
  const registry = new Registry();
  registry.register({
    policy: { entityName: 'User', subjectField: 'userId', fields: { email: 'delete' } },
    executor: makeExec([{ id: 'u1', email: 'a@b.com' }]),
  });
  const requests = new InMemoryRequestStorage();
  const artifacts = new InMemoryArtifactStorage();
  const outboxEvents: Array<{ type: string; payload: unknown }> = [];
  const service = new DataSubjectService({
    registry,
    requestStorage: requests,
    artifactStorage: artifacts,
    slaDays: 30,
    idFactory: (() => {
      let n = 0;
      return () => `dsr_${++n}`;
    })(),
    clock: () => new Date('2026-01-01T00:00:00Z'),
    publishOutbox: async (type, payload) => {
      outboxEvents.push({ type, payload });
    },
  });
  return { service, requests, artifacts, outboxEvents };
}

describe('DataSubjectService', () => {
  it('export runs to completed and records artifact hash', async () => {
    const { service, requests } = svc();
    const r = await service.export('subject_1', 'tenant_1');
    expect(r.state).toBe('completed');
    expect(r.artifactHash).toMatch(/^[a-f0-9]{64}$/);
    const stored = await requests.findById(r.id);
    expect(stored?.state).toBe('completed');
  });

  it('erase publishes a tombstone outbox event with no PII', async () => {
    const { service, outboxEvents } = svc();
    await service.erase('subject_1', 'tenant_1');
    const ev = outboxEvents.find((e) => e.type === 'data_subject.erasure_requested');
    expect(ev).toBeDefined();
    expect(ev!.payload).toMatchObject({ subjectId: 'subject_1', tenantId: 'tenant_1' });
    const json = JSON.stringify(ev!.payload);
    expect(json).not.toContain('a@b.com');
  });

  it('erase completes successfully with artifact hash', async () => {
    const { service } = svc();
    const r = await service.erase('subject_1', 'tenant_1');
    expect(r.state).toBe('completed');
    expect(r.stats?.entities[0]).toMatchObject({ entityName: 'User', affected: 1 });
    expect(r.artifactHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('sets dueAt to createdAt + slaDays', async () => {
    const { service } = svc();
    const r = await service.export('subject_1', 'tenant_1');
    expect(r.dueAt.toISOString()).toBe('2026-01-31T00:00:00.000Z');
  });

  it('marks request failed when runner throws', async () => {
    const registry = new Registry();
    registry.register({
      policy: { entityName: 'User', subjectField: 'userId', fields: { email: 'delete' } },
      executor: {
        select: async () => [{ id: 'u1' }],
        erase: async () => 0,
        anonymize: async () => 0,
      },
    });
    const service = new DataSubjectService({
      registry,
      requestStorage: new InMemoryRequestStorage(),
      artifactStorage: new InMemoryArtifactStorage(),
      slaDays: 30,
      clock: () => new Date('2026-01-01T00:00:00Z'),
    });
    const r = await service.erase('subject_1', 'tenant_1');
    expect(r.state).toBe('failed');
    expect(r.failureReason).toMatch(/residual/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/integration/data-subject.service.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement src/data-subject.service.ts**

```typescript
import { createHash, randomUUID } from 'node:crypto';
import { ExportRunner } from './export-runner';
import { EraseRunner } from './erase-runner';
import type { Registry } from './registry';
import type { RequestStorage } from './storage/request-storage.interface';
import type { ArtifactStorage } from './storage/artifact-storage.interface';
import type { DataSubjectRequest, RequestState, RequestType } from './types';

export interface DataSubjectServiceDeps {
  registry: Registry;
  requestStorage: RequestStorage;
  artifactStorage: ArtifactStorage;
  slaDays: number;
  idFactory?: () => string;
  clock?: () => Date;
  publishOutbox?: (type: string, payload: unknown) => Promise<void>;
  publishAudit?: (event: string, data: Record<string, unknown>) => Promise<void>;
}

export class DataSubjectService {
  private readonly idFactory: () => string;
  private readonly clock: () => Date;
  private readonly publishOutbox: NonNullable<DataSubjectServiceDeps['publishOutbox']>;
  private readonly publishAudit: NonNullable<DataSubjectServiceDeps['publishAudit']>;

  constructor(private readonly deps: DataSubjectServiceDeps) {
    this.idFactory = deps.idFactory ?? (() => randomUUID());
    this.clock = deps.clock ?? (() => new Date());
    this.publishOutbox = deps.publishOutbox ?? (async () => {});
    this.publishAudit = deps.publishAudit ?? (async () => {});
  }

  async export(subjectId: string, tenantId: string): Promise<DataSubjectRequest> {
    const request = await this.createRequest('export', subjectId, tenantId);
    try {
      await this.setState(request.id, 'processing');
      const runner = new ExportRunner(this.deps.registry, this.deps.artifactStorage);
      const result = await runner.run(request.id, subjectId, tenantId);
      await this.deps.requestStorage.update(request.id, {
        state: 'completed',
        completedAt: this.clock(),
        artifactHash: result.artifactHash,
        artifactUrl: result.artifactUrl,
        stats: result.stats,
      });
    } catch (err) {
      await this.markFailed(request.id, err);
    }
    return this.mustLoad(request.id);
  }

  async erase(subjectId: string, tenantId: string): Promise<DataSubjectRequest> {
    const request = await this.createRequest('erase', subjectId, tenantId);
    await this.publishOutbox('data_subject.erasure_requested', {
      requestId: request.id,
      subjectId,
      tenantId,
      requestedAt: this.clock().toISOString(),
    });
    try {
      await this.setState(request.id, 'processing');
      const runner = new EraseRunner(this.deps.registry);
      const result = await runner.run(subjectId, tenantId);
      const report = JSON.stringify({ requestId: request.id, stats: result.stats });
      const artifactHash = createHash('sha256').update(report).digest('hex');
      await this.deps.requestStorage.update(request.id, {
        state: 'completed',
        completedAt: this.clock(),
        stats: result.stats,
        artifactHash,
      });
      await this.publishOutbox('data_subject.request_completed', {
        requestId: request.id,
        state: 'completed',
        artifactHash,
      });
    } catch (err) {
      await this.markFailed(request.id, err);
      await this.publishOutbox('data_subject.request_failed', {
        requestId: request.id,
        failureReason: (err as Error).message,
      });
    }
    return this.mustLoad(request.id);
  }

  async getRequest(id: string): Promise<DataSubjectRequest> {
    return this.mustLoad(id);
  }

  async listByTenant(
    tenantId: string,
    opts: { state?: RequestState } = {},
  ): Promise<DataSubjectRequest[]> {
    return this.deps.requestStorage.listByTenant(tenantId, opts);
  }

  async listOverdue(): Promise<DataSubjectRequest[]> {
    return this.deps.requestStorage.listOverdue(this.clock());
  }

  private async createRequest(
    type: RequestType,
    subjectId: string,
    tenantId: string,
  ): Promise<DataSubjectRequest> {
    const now = this.clock();
    const dueAt = new Date(now.getTime() + this.deps.slaDays * 86_400_000);
    const request: DataSubjectRequest = {
      id: this.idFactory(),
      tenantId,
      subjectId,
      type,
      state: 'created',
      createdAt: now,
      dueAt,
      completedAt: null,
      failedAt: null,
      failureReason: null,
      artifactHash: null,
      artifactUrl: null,
      stats: null,
      requestedBy: null,
    };
    await this.deps.requestStorage.insert(request);
    await this.publishOutbox('data_subject.request_created', {
      requestId: request.id,
      type,
      subjectId,
      tenantId,
    });
    await this.publishAudit('data_subject.request_created', {
      requestId: request.id,
      type,
      tenantId,
    });
    return request;
  }

  private async setState(id: string, state: RequestState): Promise<void> {
    await this.deps.requestStorage.update(id, { state });
  }

  private async markFailed(id: string, err: unknown): Promise<void> {
    await this.deps.requestStorage.update(id, {
      state: 'failed',
      failedAt: this.clock(),
      failureReason: (err as Error).message,
    });
  }

  private async mustLoad(id: string): Promise<DataSubjectRequest> {
    const r = await this.deps.requestStorage.findById(id);
    if (!r) throw new Error(`request ${id} not found`);
    return r;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/integration/data-subject.service.test.ts`
Expected: PASS, 5/5.

- [ ] **Step 5: Commit**

```bash
git add src/data-subject.service.ts test/integration/data-subject.service.test.ts
git commit -m "feat: DataSubjectService facade orchestrating export/erase lifecycle"
```

---

## Task 13: NestJS Module Wiring

**Files:**
- Create: `src/data-subject.module.ts`

- [ ] **Step 1: Implement src/data-subject.module.ts**

```typescript
import { DynamicModule, Module, Provider } from '@nestjs/common';
import { DataSubjectService, DataSubjectServiceDeps } from './data-subject.service';
import { Registry } from './registry';
import type { RegisterInput } from './registry';
import type { RequestStorage } from './storage/request-storage.interface';
import type { ArtifactStorage } from './storage/artifact-storage.interface';

export const DATA_SUBJECT_REGISTRY = Symbol('DATA_SUBJECT_REGISTRY');

export interface DataSubjectModuleOptions {
  requestStorage: RequestStorage;
  artifactStorage: ArtifactStorage;
  slaDays?: number;
  strictLegalBasis?: boolean;
  entities?: RegisterInput[];
  publishOutbox?: DataSubjectServiceDeps['publishOutbox'];
  publishAudit?: DataSubjectServiceDeps['publishAudit'];
}

@Module({})
export class DataSubjectModule {
  static forRoot(options: DataSubjectModuleOptions): DynamicModule {
    const providers: Provider[] = [
      {
        provide: DATA_SUBJECT_REGISTRY,
        useFactory: () => {
          const registry = new Registry({ strictLegalBasis: options.strictLegalBasis });
          for (const entity of options.entities ?? []) {
            registry.register(entity);
          }
          return registry;
        },
      },
      {
        provide: DataSubjectService,
        useFactory: (registry: Registry) =>
          new DataSubjectService({
            registry,
            requestStorage: options.requestStorage,
            artifactStorage: options.artifactStorage,
            slaDays: options.slaDays ?? 30,
            publishOutbox: options.publishOutbox,
            publishAudit: options.publishAudit,
          }),
        inject: [DATA_SUBJECT_REGISTRY],
      },
    ];

    return {
      module: DataSubjectModule,
      providers,
      exports: [DataSubjectService, DATA_SUBJECT_REGISTRY],
      global: true,
    };
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/data-subject.module.ts
git commit -m "feat: DataSubjectModule.forRoot wiring"
```

---

## Task 14: fromPrisma Helper

**Files:**
- Create: `src/prisma/from-prisma.ts`
- Test: `src/prisma/from-prisma.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/prisma/from-prisma.test.ts
import { fromPrisma } from './from-prisma';

function mockDelegate() {
  const state = { rows: [{ id: 'u1', userId: 's1', email: 'a@b.com' }] };
  return {
    state,
    delegate: {
      findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        state.rows.filter((r) => {
          return Object.entries(where).every(([k, v]) => (r as Record<string, unknown>)[k] === v);
        }),
      ),
      deleteMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const before = state.rows.length;
        state.rows = state.rows.filter(
          (r) => !Object.entries(where).every(([k, v]) => (r as Record<string, unknown>)[k] === v),
        );
        return { count: before - state.rows.length };
      }),
      updateMany: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        let n = 0;
        state.rows = state.rows.map((r) => {
          if (Object.entries(where).every(([k, v]) => (r as Record<string, unknown>)[k] === v)) {
            n++;
            return { ...r, ...data };
          }
          return r;
        });
        return { count: n };
      }),
    },
  };
}

describe('fromPrisma', () => {
  it('select queries by subjectField and tenantId', async () => {
    const m = mockDelegate();
    const exec = fromPrisma({ delegate: m.delegate, subjectField: 'userId', tenantField: 'tenantId' });
    const rows = await exec.select('s1', 't1');
    expect(m.delegate.findMany).toHaveBeenCalledWith({ where: { userId: 's1', tenantId: 't1' } });
    expect(rows.length).toBe(0); // row has no tenantId, so zero match
  });

  it('erase deletes by where clause', async () => {
    const m = mockDelegate();
    const exec = fromPrisma({ delegate: m.delegate, subjectField: 'userId' });
    const n = await exec.erase('s1', 't1', 'delete-row');
    expect(n).toBe(1);
    expect(m.state.rows.length).toBe(0);
  });

  it('anonymize updates by where clause with replacements', async () => {
    const m = mockDelegate();
    const exec = fromPrisma({ delegate: m.delegate, subjectField: 'userId' });
    const n = await exec.anonymize('s1', 't1', { email: '[REDACTED]' });
    expect(n).toBe(1);
    expect(m.state.rows[0].email).toBe('[REDACTED]');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/prisma/from-prisma.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement src/prisma/from-prisma.ts**

```typescript
import type { EntityExecutor } from '../types';

export interface PrismaDelegate {
  findMany(args: { where: Record<string, unknown> }): Promise<Record<string, unknown>[]>;
  deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
  updateMany(args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }): Promise<{ count: number }>;
}

export interface FromPrismaOptions {
  delegate: PrismaDelegate;
  subjectField: string;
  tenantField?: string;
}

export function fromPrisma(opts: FromPrismaOptions): EntityExecutor {
  const { delegate, subjectField, tenantField } = opts;

  const whereFor = (subjectId: string, tenantId: string): Record<string, unknown> => {
    const where: Record<string, unknown> = { [subjectField]: subjectId };
    if (tenantField) where[tenantField] = tenantId;
    return where;
  };

  return {
    async select(subjectId, tenantId) {
      return delegate.findMany({ where: whereFor(subjectId, tenantId) });
    },
    async erase(subjectId, tenantId, rowLevel) {
      if (rowLevel === 'delete-row') {
        const res = await delegate.deleteMany({ where: whereFor(subjectId, tenantId) });
        return res.count;
      }
      const res = await delegate.updateMany({
        where: whereFor(subjectId, tenantId),
        data: {},
      });
      return res.count;
    },
    async anonymize(subjectId, tenantId, replacements) {
      const res = await delegate.updateMany({
        where: whereFor(subjectId, tenantId),
        data: replacements,
      });
      return res.count;
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/prisma/from-prisma.test.ts`
Expected: PASS, 3/3.

- [ ] **Step 5: Commit**

```bash
git add src/prisma/from-prisma.ts src/prisma/from-prisma.test.ts
git commit -m "feat: fromPrisma helper wrapping Prisma delegates as executor"
```

---

## Task 15: Prisma Example Schema

**Files:**
- Create: `prisma/schema.example.prisma`

- [ ] **Step 1: Create prisma/schema.example.prisma**

```prisma
// Example schema for @nestarc/data-subject.
// Consumers copy the DataSubjectRequest model into their own schema.

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

model DataSubjectRequest {
  id             String    @id @default(cuid())
  tenantId       String
  subjectId      String
  type           String
  state          String
  createdAt      DateTime  @default(now())
  dueAt          DateTime
  completedAt    DateTime?
  failedAt       DateTime?
  failureReason  String?
  artifactHash   String?
  artifactUrl    String?
  stats          Json?
  requestedBy    String?

  @@index([tenantId, subjectId])
  @@index([state, dueAt])
}
```

- [ ] **Step 2: Commit**

```bash
git add prisma/schema.example.prisma
git commit -m "feat: example Prisma schema for DataSubjectRequest"
```

---

## Task 16: Public Exports

**Files:**
- Create: `src/index.ts`

- [ ] **Step 1: Implement src/index.ts**

```typescript
export * from './types';
export * from './errors';
export { validateLegalBasis } from './legal-basis';
export type { LegalBasisOptions } from './legal-basis';
export { compilePolicy } from './policy-compiler';
export type { CompileOptions, PolicySpec } from './policy-compiler';
export { Registry } from './registry';
export type { RegisterInput } from './registry';
export { DataSubjectService } from './data-subject.service';
export type { DataSubjectServiceDeps } from './data-subject.service';
export { DataSubjectModule, DATA_SUBJECT_REGISTRY } from './data-subject.module';
export type { DataSubjectModuleOptions } from './data-subject.module';
export type { RequestStorage } from './storage/request-storage.interface';
export { InMemoryRequestStorage } from './storage/in-memory-request-storage';
export type { ArtifactStorage } from './storage/artifact-storage.interface';
export { InMemoryArtifactStorage } from './storage/in-memory-artifact-storage';
export { fromPrisma } from './prisma/from-prisma';
export type { PrismaDelegate, FromPrismaOptions } from './prisma/from-prisma';
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: `dist/` is created with `.js` and `.d.ts` files.

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: all tests pass (total ~40 tests).

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: public package exports"
```

---

## Task 17: README with Quickstart

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace README.md contents**

```markdown
# @nestarc/data-subject

DPA-ready GDPR/CCPA toolkit for NestJS + Prisma. Entity registry, export/erase lifecycle, legal retention, outbox fan-out.

## What this library is NOT

This library **rejects three common compliance mistakes**:

- ❌ "Hashing userId satisfies GDPR erasure" — pseudonymized data is still personal data
- ❌ "Soft delete (`deletedAt`) equals GDPR deletion" — original data is recoverable
- ❌ "Anonymization and pseudonymization are the same" — they are not

The `pseudonymize: 'hmac'` option exists as a defense-in-depth security measure, **not** as a substitute for erasure. See [`docs/compliance.md`](docs/compliance.md) for details.

## Install

```bash
npm install @nestarc/data-subject
```

## Quickstart

```typescript
import { Module } from '@nestjs/common';
import {
  DataSubjectModule,
  InMemoryRequestStorage,
  InMemoryArtifactStorage,
  fromPrisma,
} from '@nestarc/data-subject';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

@Module({
  imports: [
    DataSubjectModule.forRoot({
      requestStorage: new InMemoryRequestStorage(),
      artifactStorage: new InMemoryArtifactStorage(),
      slaDays: 30,
      strictLegalBasis: true,
      entities: [
        {
          policy: {
            entityName: 'User',
            subjectField: 'userId',
            fields: { email: 'delete', name: 'delete' },
          },
          executor: fromPrisma({
            delegate: prisma.user,
            subjectField: 'userId',
            tenantField: 'tenantId',
          }),
        },
        {
          policy: {
            entityName: 'Invoice',
            subjectField: 'customerId',
            fields: {
              customerName: {
                strategy: 'retain',
                legalBasis: 'tax:KR-basic-law-§85',
                until: '+7y',
              },
              amount: { strategy: 'retain', legalBasis: 'tax:KR-basic-law-§85' },
            },
          },
          executor: fromPrisma({
            delegate: prisma.invoice,
            subjectField: 'customerId',
            tenantField: 'tenantId',
          }),
        },
      ],
      publishOutbox: async (type, payload) => {
        /* hand off to @nestarc/outbox */
      },
    }),
  ],
})
export class AppModule {}
```

### Process a request

```typescript
const exportRequest = await dataSubject.export('user_123', 'tenant_abc');
// exportRequest.artifactUrl, exportRequest.artifactHash

const eraseRequest = await dataSubject.erase('user_123', 'tenant_abc');
// eraseRequest.stats.retained holds rows kept under legal basis
```

## Docs

- [`docs/prd.md`](docs/prd.md) — Product requirements
- [`docs/spec.md`](docs/spec.md) — Technical spec
- [`docs/compliance.md`](docs/compliance.md) — DPA Q&A, legal basis templates

## License

MIT
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README with quickstart and compliance disclaimers"
```

---

## Final Verification

- [ ] **Run full checks**

```bash
npm run lint
npm test
npm run build
```
Expected: all pass, `dist/` exists.

- [ ] **Sanity check public API**

```bash
node -e "console.log(Object.keys(require('./dist')))"
```
Expected includes: `DataSubjectService`, `DataSubjectModule`, `Registry`, `InMemoryRequestStorage`, `InMemoryArtifactStorage`, `fromPrisma`, `validateLegalBasis`, `compilePolicy`, `DataSubjectError`.

---

## Done criteria for v0.1

- [ ] All tests green (~40 total)
- [ ] `npm run build` produces `dist/`
- [ ] README quickstart runs against a fresh NestJS project
- [ ] `docs/prd.md`, `docs/spec.md`, `docs/compliance.md` remain accurate
- [ ] Zero functions that claim compliance without producing audit evidence
