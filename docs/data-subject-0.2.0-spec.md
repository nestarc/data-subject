# @nestarc/data-subject - v0.2 Technical Spec

상태: Draft  
기준 문서: [0.2.0 기능 제안서](./data-subject-0.2.0-feature-proposal.md)  
대상 버전: `@nestarc/data-subject@0.2.0`  
작성일: 2026-06-19

본 문서는 `@nestarc/data-subject` 0.2.0에서 구현할 기술 사양을 정의한다. 0.2.0의 목표는 기능 범위를 넓히는 것이 아니라, 0.1.0의 headless export/erase core를 운영 환경에 올릴 수 있는 최소 신뢰층으로 만드는 것이다.

주의: 본 문서는 제품/기술 스펙이며 법률 자문이 아니다. 관할권별 SLA, 신원 확인 수준, 보존 근거, 익명화 충분성, request/evidence retention policy는 모두 법무 검토 필요 영역이다.

## 1. 목표

### 1.1 릴리스 목표

- 운영 환경에서 재시작 후에도 request lifecycle과 evidence를 조회할 수 있다.
- erase 처리 전후의 영향 범위와 보존 근거를 hashable artifact로 남긴다.
- Prisma schema와 registry/policy 사이의 누락 위험을 CI에서 발견한다.
- request state transition, audit event, outbox event의 의미를 명확히 한다.
- README, PRD, spec 간 stale claim을 줄이고 현재 구현 및 0.2.0 범위를 정렬한다.

### 1.2 비목표

- Admin portal 또는 end-user portal을 제공하지 않는다.
- Stripe, Intercom, Segment 등 외부 SaaS 커넥터를 직접 제공하지 않는다.
- backup, snapshot, search index, ML unlearning 자동화를 제공하지 않는다.
- GDPR/CCPA/PIPA/APPI 법률 해석 또는 legal basis catalog를 강제하지 않는다.
- full identity graph 또는 probabilistic matching을 제공하지 않는다.

## 2. 호환성 원칙

0.2.0은 가능한 한 0.1.0 public API를 유지한다.

- 기존 `DataSubjectService.export(subjectId, tenantId)`와 `erase(subjectId, tenantId)`는 유지한다.
- 기존 `RequestStorage`와 `ArtifactStorage` 인터페이스는 breaking change 없이 유지한다.
- `RequestStats`는 additive field만 허용한다.
- `DataSubjectRequest`의 기존 필드는 제거하거나 의미를 바꾸지 않는다.
- 새 기능은 adapter, option, helper, CLI, 추가 타입으로 제공한다.

Breaking change가 필요한 경우 문서와 changelog에 명시하고, migration guide를 제공해야 한다.

## 3. 범위

### 3.1 P0 - 0.2.0 필수

| 기능 | 산출물 | 성공 기준 |
|---|---|---|
| Production request persistence | `PrismaRequestStorage` | storage contract 통과, 재시작 후 request 조회 가능 |
| Durable artifact path | artifact key convention, recipe, hash 검증 | export와 erase evidence 모두 `artifactHash`와 `artifactUrl` 보유 |
| Erasure evidence artifact | JSON report schema, pre/post scan stats | erase 완료 request 100%가 evidence artifact를 저장 |
| Schema/policy lint | `data-subject lint` CLI | 누락 PII 후보, tenantField 누락, policy 누락 시 non-zero exit 가능 |
| Registry validation | runtime validation helper | 중복, 빈 policy, retain legalBasis, tenantField warning 검출 |
| Audit event stream | transition별 audit event | created/processing/completed/failed 전환이 audit/outbox로 추적 가능 |
| Docs cleanup | README/spec/PRD 정합성 | 구현되지 않은 v0.1 claim 제거 또는 roadmap 표시 |

### 3.2 P1 - 포함 권장

| 기능 | 산출물 | 성공 기준 |
|---|---|---|
| Async lifecycle skeleton | `createRequest`, `processRequest` 또는 internal transition guard | long-running job 통합을 막지 않는 API shape |
| Typed outbox events | exported event type union | 이벤트 payload에 subjectId 외 PII가 들어가지 않음 |
| Minimal identity alias resolver | optional `SubjectIdentityResolver` interface | raw email/phone 저장 없이 alias 확장 가능 |
| Overdue event helper | overdue query 또는 event publisher helper | SLA monitoring 구현 가능 |

### 3.3 P2 - 후속 가능

| 기능 | 산출물 | 성공 기준 |
|---|---|---|
| Decorator registration | `@DataSubjectEntity`, `@DataSubjectIgnore` | programmatic registry와 동일한 compile path 사용 |
| Connector receipt abstraction | receipt attach API 또는 stats schema | 외부 processor 처리 결과를 request에 연결 |
| CSV/NDJSON export | optional export format | ZIP manifest와 format별 hash snapshot |

## 4. 현재 구현 기준

0.1.0 기준으로 이미 존재하는 표면:

- `DataSubjectService`
- `DataSubjectModule.forRoot`
- `Registry`
- `compilePolicy`
- `validateLegalBasis`
- `fromPrisma`
- `RequestStorage`
- `ArtifactStorage`
- `InMemoryRequestStorage`
- `InMemoryArtifactStorage`
- `RequestType = export | erase`
- `RequestState = created | validating | processing | completed | failed`
- `Strategy = delete | anonymize | retain`

0.2.0은 위 표면을 확장하되, 기존 sync 실행 경로를 계속 지원한다.

## 5. Data Model

### 5.1 Request table

0.2.0의 기본 `DataSubjectRequest` Prisma model은 0.1.0 예시와 호환되어야 한다.

```prisma
model DataSubjectRequest {
  id            String   @id @default(cuid())
  tenantId      String
  subjectId     String
  type          String
  state         String
  createdAt     DateTime @default(now())
  dueAt         DateTime
  completedAt   DateTime?
  failedAt      DateTime?
  failureReason String?
  artifactHash  String?
  artifactUrl   String?
  stats         Json?
  requestedBy   String?

  @@index([tenantId, subjectId])
  @@index([state, dueAt])
}
```

추가 컬럼은 0.2.0 필수 요건이 아니다. 새 정보는 우선 `stats` JSON과 artifact에 저장한다. DB migration을 강제하지 않기 위함이다.

### 5.2 Request stats

0.2.0은 기존 `RequestStats`에 다음 optional field를 추가할 수 있다.

```ts
export interface RequestStats {
  entities: Array<{
    entityName: string;
    affected: number;
    strategy: 'delete' | 'anonymize' | 'retain' | 'mixed' | 'export';
  }>;
  retained?: Array<{
    entityName: string;
    field: string;
    legalBasis: string;
    count: number;
  }>;
  verificationResidual?: Array<{
    entityName: string;
    count: number;
  }>;
  preScan?: Array<{
    entityName: string;
    count: number;
  }>;
  postScan?: Array<{
    entityName: string;
    count: number;
  }>;
  evidence?: {
    schemaVersion: 'data-subject.evidence.v1';
    artifactHash: string;
    artifactUrl: string;
  };
}
```

`stats`에는 raw row, field value, email, phone, address 등 원문 PII를 저장하면 안 된다.

## 6. Production Persistence

### 6.1 `PrismaRequestStorage`

0.2.0은 `RequestStorage` 구현체로 `PrismaRequestStorage`를 제공한다.

```ts
export interface PrismaDataSubjectRequestDelegate {
  create(args: { data: unknown }): Promise<unknown>;
  update(args: { where: { id: string }; data: unknown }): Promise<unknown>;
  findUnique(args: { where: { id: string } }): Promise<unknown | null>;
  findMany(args: unknown): Promise<unknown[]>;
}

export interface PrismaRequestStorageOptions {
  delegate: PrismaDataSubjectRequestDelegate;
  now?: () => Date;
}

export class PrismaRequestStorage implements RequestStorage {
  constructor(options: PrismaRequestStorageOptions);
}
```

필수 동작:

- `insert`는 request id 충돌 시 `dsr_request_conflict`를 던진다.
- `update`는 없는 id에 대해 `dsr_request_not_found`를 던진다.
- `findById`는 없으면 `null`을 반환한다.
- `listByTenant`는 `tenantId`를 항상 where 조건에 포함한다.
- `listOverdue(now)`는 `state`가 `completed` 또는 `failed`가 아니고 `dueAt < now`인 request를 반환한다.
- Date와 JSON stats 직렬화/역직렬화가 `DataSubjectRequest` 타입과 호환되어야 한다.

### 6.2 Artifact storage

기존 `ArtifactStorage` 인터페이스는 유지한다.

```ts
export interface ArtifactStorage {
  put(key: string, body: Buffer, contentType: string): Promise<string>;
  get(key: string): Promise<{ body: Buffer; contentType: string } | null>;
}
```

0.2.0은 cloud SDK를 필수 dependency로 추가하지 않는다. 대신 다음을 제공한다.

- stable artifact key convention
- hash verification helper
- S3/R2/GCS style adapter recipe
- local file adapter는 개발용으로만 선택 제공 가능

Artifact key convention:

```txt
data-subject/{tenantId}/{requestId}/export.zip
data-subject/{tenantId}/{requestId}/erase-evidence.json
```

`artifactUrl`은 consumer-managed opaque reference다. public URL이어야 할 필요가 없으며, 가능하면 signed URL이 아니라 storage key 또는 internal URI를 저장한다.

## 7. Erasure Evidence Artifact

### 7.1 Evidence schema

Erase 완료 시 `ArtifactStorage.put`으로 다음 JSON artifact를 저장한다.

```ts
export interface ErasureEvidenceArtifact {
  schemaVersion: 'data-subject.erasure-evidence.v1';
  requestId: string;
  tenantId: string;
  requestType: 'erase';
  generatedAt: string;
  state: 'completed';
  preScan: Array<{
    entityName: string;
    count: number;
  }>;
  actions: Array<{
    entityName: string;
    strategy: 'delete' | 'anonymize' | 'retain' | 'mixed';
    affected: number;
    rowLevel: 'delete-row' | 'delete-fields';
    deleteFields?: string[];
    anonymizedFields?: string[];
    retainedFields?: Array<{
      field: string;
      legalBasis: string;
      until?: string;
      count: number;
    }>;
  }>;
  postScan: Array<{
    entityName: string;
    count: number;
  }>;
  verificationResidual: Array<{
    entityName: string;
    count: number;
  }>;
  artifactHashAlgorithm: 'sha256';
}
```

금지 사항:

- raw row를 포함하지 않는다.
- field value를 포함하지 않는다.
- email, phone, address, IP address, name 등 원문 PII를 포함하지 않는다.
- failure stack trace를 포함하지 않는다.

`subjectId`는 기본 artifact에 포함하지 않는다. request record와 `requestId`로 연결한다. consumer가 별도 artifact enrichment를 구현하는 경우 subject identifier 보존 근거와 접근제어는 법무 검토 필요다.

### 7.2 Hashing

- hash 대상은 artifact body bytes다.
- JSON은 deterministic serialization을 사용해야 한다.
- `artifactHash = sha256(bodyBytes).hex()`.
- `DataSubjectRequest.artifactHash`는 evidence artifact hash와 같아야 한다.
- `DataSubjectRequest.artifactUrl`은 `ArtifactStorage.put`이 반환한 값을 저장한다.

### 7.3 Execution order

Erase sync path는 다음 순서를 따른다.

1. request 생성, state `created`
2. outbox `data_subject.request_created`
3. audit `data_subject.request_created`
4. state `processing`
5. audit `data_subject.request_processing`
6. pre-scan
7. outbox `data_subject.erasure_requested`
8. entity별 erase/anonymize/retain 실행
9. post-scan 및 residual verification
10. evidence artifact 생성 및 upload
11. request state `completed`, `artifactHash`, `artifactUrl`, `stats` 업데이트
12. audit `data_subject.request_completed`
13. outbox `data_subject.request_completed`

실패 시:

1. request state `failed`, `failedAt`, sanitized `failureReason` 업데이트
2. audit `data_subject.request_failed`
3. outbox `data_subject.request_failed`

## 8. Schema/Policy Lint

### 8.1 CLI

0.2.0은 package bin으로 `data-subject`를 제공한다.

```bash
npx @nestarc/data-subject lint --schema prisma/schema.prisma --config data-subject.config.ts
```

필수 옵션:

- `--schema`: Prisma schema path

선택 옵션:

- `--config`: lint config path
- `--fail-on warning|error`: non-zero exit 기준. 기본값은 `error`
- `--format text|json`: 출력 형식. 기본값은 `text`

### 8.2 Config

```ts
import type { DataSubjectLintConfig } from '@nestarc/data-subject/lint';

export default {
  registry: [
    {
      entityName: 'User',
      subjectField: 'id',
      tenantField: 'tenantId',
      fields: {
        email: 'delete',
        name: 'delete',
      },
    },
  ],
  piiFieldPatterns: ['email', 'phone', 'name', 'address', 'ip', 'birth'],
  suppressions: [
    {
      model: 'SystemMigrationLog',
      reason: 'system-owned operational metadata; no subject PII',
    },
  ],
} satisfies DataSubjectLintConfig;
```

Config의 `registry`는 runtime executor가 없는 policy metadata만 가진다. programmatic `DataSubjectModule.forRoot({ entities })`와 동일한 policy compiler를 사용해야 한다.

### 8.3 Findings

```ts
export interface DataSubjectLintFinding {
  severity: 'warning' | 'error';
  code:
    | 'dsr_lint_unregistered_model'
    | 'dsr_lint_missing_policy_field'
    | 'dsr_lint_missing_tenant_field'
    | 'dsr_lint_empty_suppression_reason'
    | 'dsr_lint_invalid_policy'
    | 'dsr_lint_subject_field_missing';
  model: string;
  field?: string;
  message: string;
}
```

필수 검증:

- PII 후보 field가 있는 model이 registry 또는 suppression에 없으면 finding을 낸다.
- registry에 등록된 field가 schema에 없으면 error를 낸다.
- registry에 등록된 `subjectField`가 schema에 없으면 error를 낸다.
- multi-tenant mode에서 `tenantField`가 없으면 warning을 낸다.
- suppression은 non-empty reason을 요구한다.
- `retain`에는 `legalBasis`가 필요하다.
- dynamic anonymize replacement는 허용하지 않는다.

PII 후보 탐지는 보조 안전장치이며 완전한 data discovery가 아니다. false negative 가능성은 문서에 명시한다.

## 9. Registry Validation

런타임 validation helper를 제공한다.

```ts
export interface RegistryValidationReport {
  ok: boolean;
  findings: DataSubjectLintFinding[];
}

export function validateRegistry(
  registry: Registry,
  opts?: {
    requireTenantField?: boolean;
  },
): RegistryValidationReport;
```

`validateRegistry`는 Prisma schema를 요구하지 않는 lightweight validation이다.

필수 검증:

- entityName 중복은 기존 `Registry.register`에서 즉시 실패한다.
- fields가 비어 있으면 warning 또는 error를 낸다.
- `retain` entry는 compiled policy 기준 legalBasis를 가져야 한다.
- `subjectField`가 빈 문자열이면 error를 낸다.
- `requireTenantField`가 true인데 entity metadata에 tenantField가 없으면 warning을 낸다.

현재 `EntityPolicy`에는 `tenantField`가 없다. 0.2.0에서 lint metadata에는 `tenantField`를 허용하되, runtime executor boundary는 기존 `fromPrisma({ tenantField })`를 유지한다.

## 10. Audit and Outbox Events

### 10.1 Event names

0.2.0은 다음 event name을 표준화한다.

| Event | Audit | Outbox | Payload |
|---|---|---|---|
| `data_subject.request_created` | Yes | Yes | `{ requestId, type, tenantId, subjectId? }` |
| `data_subject.request_processing` | Yes | Optional | `{ requestId, type, tenantId }` |
| `data_subject.erasure_requested` | Optional | Yes | `{ requestId, tenantId, subjectId, requestedAt }` |
| `data_subject.request_completed` | Yes | Yes | `{ requestId, type, tenantId, artifactHash }` |
| `data_subject.request_failed` | Yes | Yes | `{ requestId, type, tenantId, failureReason }` |
| `data_subject.request_overdue` | Yes | Yes | `{ requestId, type, tenantId, daysOverdue }` |

Outbox payload는 subjectId 외 원문 PII를 포함하지 않는다. audit payload는 가능하면 subjectId도 생략하고 `requestId`, `tenantId`, `type` 중심으로 남긴다.

### 10.2 Typed events

```ts
export type DataSubjectOutboxEvent =
  | {
      type: 'data_subject.request_created';
      payload: {
        requestId: string;
        requestType: 'export' | 'erase';
        tenantId: string;
        subjectId: string;
      };
    }
  | {
      type: 'data_subject.erasure_requested';
      payload: {
        requestId: string;
        tenantId: string;
        subjectId: string;
        requestedAt: string;
      };
    }
  | {
      type: 'data_subject.request_completed';
      payload: {
        requestId: string;
        requestType: 'export' | 'erase';
        tenantId: string;
        artifactHash: string;
      };
    }
  | {
      type: 'data_subject.request_failed';
      payload: {
        requestId: string;
        requestType: 'export' | 'erase';
        tenantId: string;
        failureReason: string;
      };
    };
```

`failureReason`은 sanitized string이어야 한다. stack trace와 raw row data를 포함하지 않는다.

## 11. Lifecycle and State Transitions

0.2.0의 기본 sync API는 다음 state machine을 따른다.

```txt
created -> processing -> completed
created -> processing -> failed
```

`validating`은 async lifecycle 또는 explicit verification flow를 위한 reserved state다. 0.2.0에서 `validating`을 실제로 사용할 경우 다음 전이만 허용한다.

```txt
created -> validating -> processing -> completed
created -> validating -> failed
created -> processing -> completed
created -> processing -> failed
```

금지 전이:

- `completed -> processing`
- `completed -> failed`
- `failed -> completed`
- `failed -> processing`

Retry/resume API를 도입하는 경우 새 request id를 만들거나, 별도 `retryOfRequestId` 같은 additive metadata를 사용해야 한다. 기존 request state를 되돌리는 방식은 기본 제공하지 않는다.

## 12. Optional Identity Alias Resolver

0.2.0은 최소 interface만 제공할 수 있다. 기본 구현은 제공하지 않는다.

```ts
export interface SubjectIdentityAlias {
  kind: 'subjectId' | 'authSub' | 'customerId' | 'emailHash' | 'externalId';
  value: string;
  provider?: string;
}

export interface SubjectIdentityResolver {
  resolve(input: {
    tenantId: string;
    subjectId: string;
  }): Promise<{
    canonicalSubjectId: string;
    aliases: SubjectIdentityAlias[];
  }>;
}
```

원칙:

- raw email, phone, address를 alias value로 저장하지 않는다.
- email 기반 alias가 필요하면 normalized email의 HMAC 같은 irreversible identifier를 consumer가 제공한다.
- alias resolution은 tenant boundary 안에서만 동작해야 한다.
- cross-tenant alias merge는 기본 제공하지 않는다.
- 신원 확인 수준은 consumer 책임이며 법무 검토 필요다.

0.2.0 P0 기능은 resolver 없이도 동작해야 한다.

## 13. Export Artifact

0.1.0의 JSON ZIP export는 유지한다.

0.2.0에서 export artifact는 다음 manifest를 ZIP 안에 포함할 수 있다.

```json
{
  "schemaVersion": "data-subject.export-manifest.v1",
  "requestId": "dsr_123",
  "tenantId": "tenant_1",
  "generatedAt": "2026-06-19T00:00:00.000Z",
  "format": "json",
  "entities": [
    { "entityName": "User", "rowCount": 1 }
  ]
}
```

CSV/NDJSON은 P2다. 0.2.0 P0에서 필수는 아니다.

## 14. Error Codes

기존 error code는 유지한다.

| Code | Status | 의미 |
|---|---:|---|
| `dsr_subject_not_found` | 404 | subjectId가 tenant scope에 없음 |
| `dsr_unregistered_entity` | 500 | 등록되지 않은 entity 사용 |
| `dsr_invalid_policy` | 500 | policy compile 실패 |
| `dsr_verification_failed` | 500 | erase 후 residual verification 실패 |
| `dsr_anonymize_dynamic_replacement` | 500 | anonymize replacement가 static value가 아님 |
| `dsr_entity_already_registered` | 500 | entityName 중복 등록 |
| `dsr_request_conflict` | 409 | request id 충돌 |
| `dsr_request_not_found` | 404 | request 조회 또는 update 대상 없음 |

0.2.0에서 추가 가능한 code:

| Code | Status | 의미 |
|---|---:|---|
| `dsr_artifact_write_failed` | 500 | artifact upload 실패 |
| `dsr_invalid_state_transition` | 500 | 허용되지 않은 state transition |
| `dsr_lint_failed` | 1 exit | lint finding으로 CLI 실패 |
| `dsr_evidence_report_invalid` | 500 | evidence artifact schema 생성 실패 |

새 code를 추가할 때는 `DataSubjectErrorCode`와 HTTP status mapping을 함께 업데이트한다.

## 15. Security and Privacy Requirements

- Export ZIP과 erase evidence artifact는 consumer-managed private storage에 저장한다.
- `artifactUrl`은 public unauthenticated URL이면 안 된다.
- audit/outbox payload에는 subjectId 외 원문 PII를 포함하지 않는다.
- erase evidence artifact에는 raw row와 field value를 포함하지 않는다.
- `failureReason`은 stack trace, SQL, raw data를 제거한 sanitized string이어야 한다.
- `tenantId`는 모든 list/query/update path에서 scope로 사용한다.
- `tenantField`가 없는 Prisma executor는 명시적으로 single-tenant 또는 externally scoped로 문서화해야 한다.
- `subjectId` 평문 저장, request retention 기간, evidence retention 기간은 법무 검토 필요다.
- anonymize replacement가 재식별 가능하거나 통계적으로 unique하면 익명화로 주장하면 안 된다. 법무 검토 필요다.

## 16. Tests

### 16.1 Unit tests

- `PrismaRequestStorage` Date/JSON mapping
- `PrismaRequestStorage` missing row and duplicate id error mapping
- deterministic evidence JSON serialization
- artifact hash consistency
- lint finding formatter
- registry validation helper
- state transition guard

### 16.2 Integration tests

- sync erase path stores evidence artifact and request artifact fields
- failed erase path emits sanitized failure event
- export path preserves existing behavior
- `listOverdue` works with Prisma storage
- `fromPrisma({ tenantField })` prevents cross-tenant selection in fixtures
- lint CLI exits non-zero on missing policy field

### 16.3 Contract tests

모든 `RequestStorage` 구현체는 동일한 contract test를 통과해야 한다.

- insert/findById
- update partial field
- listByTenant with state filter
- listOverdue excludes completed/failed
- not found behavior
- conflict behavior

모든 `ArtifactStorage` 구현체는 동일한 contract test를 통과해야 한다.

- put/get round trip
- contentType preservation
- missing key returns null
- binary body preservation

## 17. Documentation Requirements

0.2.0 릴리스 전 다음 문서를 정리한다.

- README: 0.2.0 quickstart를 `PrismaRequestStorage` 중심으로 갱신
- README: in-memory storage는 test/dev only로 명시
- README: erase evidence artifact 예시 추가
- README: `data-subject lint` 사용법 추가
- `docs/spec.md`: v0.1 historical spec 또는 superseded 상태 표시
- `docs/prd.md`: 실제 0.1 구현과 0.2 scope가 다른 부분 표시
- `docs/compliance.md`: legal interpretation은 법무 검토 필요 문구 유지

## 18. Acceptance Criteria

0.2.0은 다음 기준을 만족해야 릴리스 가능하다.

- `npm test`가 통과한다.
- `npm run build`가 통과한다.
- `PrismaRequestStorage`가 request storage contract를 통과한다.
- erase 완료 request가 `artifactHash`, `artifactUrl`, `stats.evidence`를 가진다.
- erase evidence artifact hash가 request `artifactHash`와 일치한다.
- evidence artifact snapshot에 raw row 또는 raw PII fixture value가 포함되지 않는다.
- lint CLI가 fixture schema의 누락 PII field를 탐지한다.
- audit/outbox event tests가 created, processing, completed, failed path를 검증한다.
- README의 quickstart가 in-memory storage를 production path로 오해하게 만들지 않는다.

## 19. Open Questions

- `PrismaRequestStorage`를 root export로 둘지, `@nestarc/data-subject/prisma` subpath export로 둘지 결정이 필요하다.
- artifact encryption helper를 0.2.0 필수로 둘지 recipe로 둘지 결정이 필요하다.
- `subjectId` HMAC 저장 option을 request table에 추가할지, consumer schema 책임으로 둘지 결정이 필요하다. 법무 검토 필요.
- lint config에서 TypeScript registry loading을 지원할지, JSON metadata만 지원할지 결정이 필요하다.
- `validating` state를 0.2.0에서 실제로 사용할지 reserved로 유지할지 결정이 필요하다.
- connector receipt abstraction을 0.2.0에 포함할 경우 request table 확장 없이 stats/artifact만으로 충분한지 검토가 필요하다.

## 20. Final Recommendation

0.2.0의 구현 순서는 다음을 권장한다.

1. `PrismaRequestStorage`와 storage contract test를 먼저 만든다.
2. erase runner/service에 pre-scan, post-scan, evidence artifact 저장을 추가한다.
3. audit/outbox transition을 정렬하고 failure payload sanitization을 보강한다.
4. Prisma schema lint CLI와 registry validation helper를 추가한다.
5. README와 기존 docs를 현재 구현 기준으로 정리한다.

이 순서가 가장 작은 API 변화로 가장 큰 운영 신뢰도를 만든다.
