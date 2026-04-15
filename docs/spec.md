# @nestarc/data-subject — v0.1 Technical Spec

본 문서는 v0.1에서 고정되는 기술 결정을 기록한다. 변경은 RFC 수준의 논의를 거친다.

## 1. 엔티티 레지스트리

### 1.1 데코레이터 경로

```ts
@DataSubjectEntity({
  subjectField: 'userId',
  policy: {
    email: 'delete',
    name: 'delete',
    avatarUrl: 'delete',
    lastLoginAt: 'delete',
  },
})
export class User {
  id: string;
  userId: string;
  email: string;
  // ...
}
```

### 1.2 프로그래매틱 경로 (외부 스키마용)

```ts
dataSubject.register({
  entity: 'Invoice',
  subjectField: 'customerId',
  policy: {
    customerName: {
      strategy: 'retain',
      legalBasis: 'tax:KR-basic-law-§85',
      until: '+7y',
    },
    amount: { strategy: 'retain', legalBasis: 'tax:KR-basic-law-§85', until: '+7y' },
    customerEmail: { strategy: 'anonymize', replacement: 'redacted@example.com' },
    internalNote: 'delete',
  },
});
```

### 1.3 제외 선언

```ts
@DataSubjectIgnore('no PII, system-owned')
export class SystemMigrationLog { /* ... */ }
```

빌드타임 린트는 이 클래스를 건너뛰되, 이유 문자열을 필수로 받아 기록한다.

## 2. 전략 세부

### 2.1 `delete` (기본)

- 필드 단위: `UPDATE ... SET col = NULL` (nullable) 또는 `UPDATE ... SET col = ''` (non-null)
- 행 전체: `DELETE FROM ... WHERE subjectField = ?`
- 행 전체 삭제 여부는 엔티티 레벨 옵션 `rowLevel: 'delete-row' | 'delete-fields'`로 결정. 기본은 `delete-fields`(FK 안정).

### 2.2 `anonymize`

- 정적 치환값 필수. `replacement` 필드로 지정.
- 동적 생성 금지(`() => randomUUID()` 등). 런타임 타입 가드로 거부.
- 여러 행에 같은 값이 들어가 집계가 망가질 수 있음을 문서에 명시.

### 2.3 `retain`

- `legalBasis: string` 필수. 비어 있으면 `InvalidPolicyError`.
- 형식 권장: `<scheme>:<jurisdiction>-<reference>` (예: `tax:KR-basic-law-§85`).
- 엄격 모드(`strictLegalBasis: true`)에서는 위 regex를 강제.
- 기간: `until: '+7y' | '+N{y|m|d}' | ISO8601` (v0.2에서 확장).
- 선택 필드 `pseudonymize: 'hmac' | 'none'` (기본 `none`). 활성화 시 subjectField를 `HMAC-SHA256(subjectId, pepper)`로 저장. README에 **"pseudonymization is not erasure"** 명시 경고.

## 3. `DataSubjectRequest` 테이블

```prisma
model DataSubjectRequest {
  id            String    @id @default(cuid())
  tenantId      String
  subjectId     String
  type          String    // "export" | "erase"
  state         String    // "created" | "validating" | "processing" | "completed" | "failed"
  createdAt     DateTime  @default(now())
  dueAt         DateTime  // createdAt + 30 days (ISO + EU/US standard)
  completedAt   DateTime?
  failedAt      DateTime?
  failureReason String?
  artifactHash  String?   // sha256 of export ZIP or erase report
  artifactUrl   String?   // consumer-managed storage reference
  stats         Json?     // { entities: [...], rowCounts: {...} }
  requestedBy   String?

  @@index([tenantId, subjectId])
  @@index([state, dueAt])
}
```

**Note**: `subjectId`는 이 테이블에 **평문으로 유지**된다. 이는 `retain + legalBasis: 'accountability:gdpr-art-5-2'` 정책에 의해 정당화되며, 법적 방어의 핵심 증빙이다.

## 4. 라이프사이클

```
created
  │  (동기: subject 존재 검증, tenant scope 확인)
  ▼
validating
  │  (비동기: 정책 컴파일, 영향 범위 pre-scan)
  ▼
processing
  │  (비동기: 배치 실행, 트랜잭션 단위 커밋, outbox 발행)
  ▼
completed ◀── (verification scan: residual 0)
    or
failed (with reason)
```

각 전환은 `audit-log`에 기록되며, `DataSubjectRequest.state`도 함께 업데이트된다.

## 5. Export 플로우

1. `dataSubject.export(subjectId, tenantId)` → `DataSubjectRequest` INSERT (state=`created`)
2. 레지스트리의 모든 엔티티를 순회:
   - `SELECT * FROM <entity> WHERE <subjectField> = ? AND tenantId = ?`
   - 결과를 `{ entity, rows }` 구조로 누적
3. 누적 결과를 JSON으로 직렬화 → ZIP 압축
4. `sha256(zipBytes)`를 `artifactHash`에 저장
5. consumer가 지정한 storage에 ZIP 업로드, URL을 `artifactUrl`에 저장
6. `state=completed`, `stats` 업데이트

Storage adapter는 interface로 정의되며, v0.1은 `InMemoryStorageAdapter`(테스트용)와 `S3StorageAdapter`(선택 peer dep) 제공.

## 6. Erase 플로우

1. `dataSubject.erase(subjectId, tenantId, opts?)` → `DataSubjectRequest` INSERT
2. **pre-scan**: 레지스트리 전 엔티티의 영향 행 개수 집계 → `stats.preCount`
3. 트랜잭션 배치로 정책 적용:
   - `delete`: `DELETE` 또는 필드 NULL
   - `anonymize`: `UPDATE ... SET col = replacement`
   - `retain`: 건너뜀. `legalBasis`를 `stats.retained[]`에 기록
4. **outbox tombstone publish** (같은 트랜잭션 안에서 outbox 테이블에 INSERT):
   ```json
   {
     "type": "data_subject.erasure_requested",
     "subjectId": "user_123",
     "tenantId": "tenant_1",
     "requestId": "dsr_abc",
     "requestedAt": "2026-04-14T12:34:56Z"
   }
   ```
   PII 절대 포함 금지. subjectId만.
5. **verification scan**: 전 엔티티에서 `WHERE <subjectField> = ?` 재조회.
   - `delete` 전략 엔티티에서 행 발견 시 → `state=failed`, `failureReason`에 엔티티명 기록
   - `retain` 전략 엔티티는 법적 근거와 함께 `stats.retained`에 기록
6. `state=completed`, `artifactHash`에 erase report JSON의 sha256 저장

**Implementation note (v0.1):** 기본 구현은 선택적 `runInTransaction` 훅을 노출한다. 실제 롤백 가능 여부는 executor, request storage, outbox가 같은 트랜잭션 경계에 참여하는지에 달려 있다. 그렇지 않으면 erase는 best-effort다.

## 7. 공개 API 표면

```ts
interface DataSubjectService {
  export(subjectId: string, tenantId: string): Promise<DataSubjectRequest>;
  erase(
    subjectId: string,
    tenantId: string,
    opts?: { rowLevel?: 'delete-row' | 'delete-fields' },
  ): Promise<DataSubjectRequest>;

  getRequest(requestId: string): Promise<DataSubjectRequest>;
  listByTenant(tenantId: string, opts?: { state?: RequestState }): Promise<DataSubjectRequest[]>;
  listOverdue(): Promise<DataSubjectRequest[]>;

  // Registry introspection
  describeEntity(name: string): EntityPolicy;
  validateRegistry(): ValidationReport;  // 빌드타임/CI에서 호출
}

// Decorators
@DataSubjectEntity({ ... })
@DataSubjectIgnore(reason: string)
```

### 모듈 등록

```ts
DataSubjectModule.forRoot({
  prisma: prismaClient,
  outbox: outboxService,        // from @nestarc/outbox
  auditLog: auditLogService,    // from @nestarc/audit-log
  storage: new S3StorageAdapter({ ... }),
  runInTransaction: async (work) => prismaClient.$transaction(async () => work()),
  pepper: process.env.DATA_SUBJECT_PEPPER,  // for optional pseudonymization
  slaDays: 30,
  strictLegalBasis: true,
})
```

## 8. 빌드타임 린트

CI에서 실행할 CLI:

```bash
npx @nestarc/data-subject lint
```

동작:
1. Prisma 스키마 파싱
2. 모든 모델의 컬럼 중 PII 의심 패턴 매칭 (`email`, `name`, `phone`, `address`, `ip_address`, `birthday`, `national_id` 등 + 사용자 확장 리스트)
3. 해당 컬럼이 등록된 엔티티의 `policy`에 포함되어 있는지 확인
4. 누락 시 경고 출력 + non-zero exit code

Suppression:
```ts
@DataSubjectIgnore('no PII — internal metadata only')
```

## 9. Outbox 이벤트 스펙

| 이벤트 | 페이로드 | 발행 시점 |
|---|---|---|
| `data_subject.request_created` | `{ requestId, type, subjectId, tenantId }` | 요청 INSERT 동시 |
| `data_subject.erasure_requested` | tombstone: `{ requestId, subjectId, tenantId, requestedAt }` | Erase 트랜잭션 내 |
| `data_subject.request_completed` | `{ requestId, state, artifactHash }` | 완료 직후 |
| `data_subject.request_failed` | `{ requestId, failureReason }` | 실패 직후 |
| `data_subject.request_overdue` | `{ requestId, subjectId, daysOverdue }` | v0.2 스케줄러 |

모든 페이로드는 **subjectId 외 PII를 포함하지 않는다.**

## 10. 에러 코드

| 코드 | HTTP | 의미 |
|---|---|---|
| `dsr_subject_not_found` | 404 | subjectId가 tenant scope에 존재하지 않음 |
| `dsr_unregistered_entity` | 500 | 레지스트리에 없는 엔티티가 실행 중 발견 |
| `dsr_invalid_policy` | 500 | `retain`에 `legalBasis` 누락 등 정책 유효성 오류 |
| `dsr_verification_failed` | 500 | erase 후 검증 스캔에서 잔여 행 발견 |
| `dsr_anonymize_dynamic_replacement` | 500 | `replacement`가 함수/undefined |
| `dsr_entity_already_registered` | 500 | 같은 엔티티 이름이 중복 등록됨 |
| `dsr_request_conflict` | 409 | 요청 id 충돌 또는 중복 insert |
| `dsr_request_not_found` | 404 | 요청 조회/갱신 대상이 존재하지 않음 |
| `dsr_overdue_threshold` | 경고 이벤트 | SLA 초과 (30일) |

## 11. 보안 체크리스트

- [x] Export ZIP은 consumer 측 암호화 저장소에 업로드. 라이브러리는 평문 전송 금지
- [x] Outbox 이벤트 페이로드에 PII 금지 (subjectId + tenantId + requestId만)
- [x] Pseudonymization pepper는 env only, rotatable
- [x] `DataSubjectRequest.subjectId`는 평문 유지 (accountability 법적 근거)
- [x] 에러 메시지에 PII 노출 금지 (subjectId는 로깅 허용, 다른 필드 금지)
- [x] Prisma 쿼리는 모두 parameterized. raw SQL 금지

## 12. 다른 nestarc 패키지와의 결합

### @nestarc/tenancy
- 모든 API는 `tenantId` 필수 파라미터. RLS가 이미 적용되어 있으면 추가 필터 생략 가능
- `export`/`erase`에서 subjectId 조회는 tenant scope 내로 자동 제한

### @nestarc/audit-log
- 요청 라이프사이클 이벤트 4종(`created/validating/processing/completed|failed`) 자동 기록
- `AuditLogEntry` 엔티티 자체를 `retain + legalBasis='accountability:gdpr-art-5-2'`로 등록
- 선택: `pseudonymize: 'hmac'` 활성화 시 audit log의 `actorId`를 HMAC 저장

### @nestarc/outbox
- §9의 5개 이벤트를 발행
- 같은 트랜잭션에서 INSERT → at-least-once 보장

### @nestarc/soft-delete (v0.2)
- 기존에 `deletedAt`만 찍힌 행에 대해 PII 필드 익명화 hook 제공
- `onSoftDelete: 'anonymize-pii'` 옵션으로 자동 처리

## 13. 테스트 전략

- **단위**: 정책 컴파일, 레지스트리 유효성, export ZIP 직렬화 — pure functions
- **통합**: InMemoryPrismaLike로 전체 export/erase 플로우 (실제 Prisma는 consumer 검증)
- **Contract**: Storage adapter 인터페이스는 contract 테스트로 InMemory/S3 공통 검증
- **Compliance test**: 빌드타임 린트가 의도한 PII 컬럼을 모두 잡는지 fixture로 확인
- **Failure scenarios**: 검증 스캔 실패, 트랜잭션 롤백, outbox 실패
