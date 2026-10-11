# 인증된 사용자 자신의 요청을 처리하는 NestJS 예제

`privacy.module.ts`는 호스트의 인증·권한·주체 확인과 현재 P0/P1 실행 API를 연결한다. 저장소 소스 기준 상대 import는 앱에 복사할 때 `@nestarc/data-subject`로 바꾼다. 완성된 인증 서버나 공개 배포용 서버는 아니며, 앱의 실제 정책·저장소·트랜잭션 연결이 필요하다.

## 인증과 경로

`TenantSafePrivacyModule.forRoot(options, hostAccessService)`에 실제 `HostAccessService`를 주입한다. 생략하면 모든 요청을 거절한다.

1. `authenticateBearer`는 서명/세션·만료·폐기와 현재 tenant membership을 검증해 `actorId`, `tenantId`를 반환한다. 단순 decode한 토큰을 신뢰하지 않는다.
2. `isAllowed`는 `export`, `erase`, `read`, `retry`, `export:download`, `evidence:download`를 각각 검사한다. 삭제 승인과 추가 본인 확인은 호스트가 결정한다.
3. `verifyOwnSubject`는 해당 tenant의 권위 있는 신원 기록으로 주체 ID와 본인 확인 유효기간을 반환한다. HTTP body의 ID를 사용하지 않는다.

모든 경로는 Guard를 통과해야 한다. 관리자가 타인을 대신하거나 서비스 작업자가 여러 주체를 처리하는 경로는 별도 권한 정책을 구성한다.

| 경로 | 동작과 추가 입력 |
| --- | --- |
| `POST /me/privacy/exports` | 본인 데이터 ZIP 내보내기. 영구 실행에서는 `Idempotency-Key` 필요 |
| `POST /me/privacy/erasure/preview` | 읽기 전용 서명된 삭제 계획. `erase` 권한 필요 |
| `POST /me/privacy/erasure` | 본인 삭제. 승인한 계획은 body의 `{ preview }`로 전달 |
| `GET /me/privacy/requests/:id` | tenant와 subject가 모두 일치하는 요청 상태 |
| `GET /me/privacy/requests/:id/artifact` | `read` 및 종류별 `export:download`/`evidence:download` 권한 필요 |
| `POST /me/privacy/requests/:id/retry-completion` | `retry` 권한과 소유권 확인 후 artifact·통지만 복구 |

body의 `tenantId`, `subjectId`, `requestedBy`, `requestKey`는 실행 주체나 요청 키로 사용하지 않는다. 동일 tenant에서도 다른 subject의 요청·파일·재시도는 404로 처리한다.

## 공유 정책과 schema 검사

`policy.ts`는 `definePolicy`로 만든 정의를 runtime과 lint에서 공유한다. **기존 예제와 달리** `tenantUserEntity(delegate)`와 `singleTenantUserEntity(delegate, id)`는 `{ definition, executor }`를 반환하므로 모듈의 `definitions`에 전달한다. `entities`에 넣지 않는다.

```ts
import { readFileSync } from 'node:fs';
import { lintPrismaSchema } from '@nestarc/data-subject';
import { tenantUserDefinitions, tenantUserEntity } from './policy';

const report = lintPrismaSchema(readFileSync('prisma/schema.prisma', 'utf8'), {
  definitions: tenantUserDefinitions,
  strictCoverage: true,
  checkRelations: true,
  // 전체 앱 schema의 다른 모델은 검토한 구체적 사유로 suppressions에 명시한다.
});
if (!report.ok) throw new Error(JSON.stringify(report.findings));

TenantSafePrivacyModule.forRoot({
  requestStorage,
  artifactStorage,
  definitions: [tenantUserEntity(transactionBoundUserDelegate)],
  runInTransaction,
}, hostAccessService);
```

`schema.example.prisma`는 업무 모델 조각이다. `id`는 불변의 유일한 scalar 식별자다. `email`, `displayName`, `passwordHash`, `sessionToken`은 필드 삭제 시 null로 바꾸므로 nullable이어야 한다. 비밀 필드는 export allowlist에 포함하지 않는다. 새 scalar 컬럼은 정책 또는 검토한 제외 사유가 없으면 검사에 실패한다. 실제 앱 schema에는 `prisma validate`도 실행한다. 이 정책은 인증 토큰 폐기나 모든 저장소의 삭제를 대신하지 않는다.

single-tenant 변형은 tenantId 컬럼 없는 DB를 전제로 하며, 설치 시 고정한 ID를 정의와 모듈에 동일하게 전달한다. 사용자 입력으로 설치 ID를 선택하지 않는다.

```ts
const singleTenantId = 'my-installation';
TenantSafePrivacyModule.forRoot({
  singleTenantId,
  requestStorage,
  artifactStorage,
  definitions: [singleTenantUserEntity(transactionBoundUserDelegate, singleTenantId)],
  runInTransaction,
}, hostAccessService);
// lint에는 singleTenantUserDefinitions(singleTenantId)를 사용한다.
```

## 미리보기와 영구 실행

`requireErasePreview: true`는 삭제에 서명된 미리보기를 필수로 한다. 기본값은 false다. 필수 모드는 `durableStore` 또는 `runInTransaction`이 없으면 초기화 단계에서 거절한다. 선택 모드라도 preview를 전달한 삭제에는 실제 트랜잭션 연결이 필요하다. 라이브러리는 서명·tenant·subject·만료·정책과 대상 데이터 변경을 검사한다. 미리보기는 호스트의 실행 승인 자체를 대신하지 않는다.

```ts
TenantSafePrivacyModule.forRoot({
  durableStore,
  requestStorage: durableStore.requests,
  artifactStorage,
  definitions: [tenantUserEntity(transactionBoundUserDelegate)],
  previewSigningKey, // 여러 인스턴스에서 공유하는 최소 32바이트 비밀 키
  requireErasePreview: true,
}, hostAccessService);
```

`durableStore`는 [P1 설정](../../docs/p1-migration.md)에 따라 생성한 `PrismaExecutionStore`다. 모든 업무 delegate가 저장소의 같은 transaction client에 참여하도록 연결한다. 일반 경로는 `runInTransaction`에 Serializable transaction을 연결한다. 전역 Prisma client를 호출하면서 콜백만 감싸는 것은 rollback을 보장하지 않는다.

영구 실행의 export/erase에는 ASCII 공백 없는 1~200자 `Idempotency-Key` 헤더 하나가 필요하다. 예를 들어 승인된 작업마다 만든 UUID를 사용한다. 이 값과 인증된 actor·subject를 함께 해시하고 tenant/type별 코어 중복 방지 범위에 전달한다. 같은 작업의 네트워크 재시도에는 **동일한 키와 원래 preview**를 재사용한다. 새 승인·새 계획은 새 키를 사용한다. 다른 actor는 같은 헤더로 기존 실행을 재사용하지 않는다. 영구 저장소 없는 모드에서 키를 보내면 중복 방지로 오인하지 않도록 400을 반환한다.

영구 실행에서는 만료·불일치한 preview 등의 실행 실패가 예외 대신 저장된 `failed` 요청 DTO로 반환될 수 있다. HTTP 응답 성공만으로 삭제 완료를 판단하지 않고 `state`, `failureReason`, `lifecycle`, `verification`을 함께 확인한다.

이미 실행한 삭제의 artifact·통지 복구는 `retry-completion`을 사용한다. 이 경로는 `retryCompletion(id, tenantId)`만 호출하며 업무 삭제를 다시 실행하지 않는다. 영구 저장소가 없는 모드에서는 코어의 400 오류를 반환한다. 검증 실패 요청은 복구 후에도 failed로 남는다. `dsr_request_persistence_failed` 응답의 `requestId`, `dataOutcome`, `recovery`로 상태를 대조하고 불확실한 실행을 새 키로 반복하지 않는다. 그 밖의 코어 오류는 정제한 code와 코어 HTTP 상태를 반환한다.

## 상태와 다운로드

상태 DTO는 `lifecycle`, 필드별 `verification`, `evidenceVersion`을 제공하고 내부 `artifactUrl`을 노출하지 않는다. `artifactReady`는 완료된 업로드 기록에 대한 힌트이며, 파일 보존기간이 지났다면 다운로드는 404가 될 수 있다.

다운로드는 완료 요청만 제공하고, 종류별 권한·content type·SHA-256을 확인한 뒤 `Cache-Control: no-store`와 attachment 헤더로 반환한다. 실패한 P1 삭제 증빙은 별도의 호스트 검토·권한·실패 상태 표시를 갖춘 경로로 제공한다. 증빙 파일이 존재해도 요청을 completed로 바꾸지 않는다. [비공개 S3 저장소 예제](../../docs/private-artifacts.md)는 별도 보존기간과 짧은 서명 링크를 설명한다.

`listOverdue`, `expirePendingArtifacts`는 관리 작업이며 사용자 경로에 연결하지 않는다. [P2 큐·NDJSON](../../docs/p2-execution.md)은 별도 API이므로 이 예제의 request ID·ZIP 다운로드 경로와 혼용하지 않는다. 외부 플랫폼 연동은 [플랫폼 안내](../../docs/platform-integration.md)를 따른다.

## 검증

저장소 루트에서 실행한다.

```sh
npm run examples:check
npm test -- --runInBand test/integration/host-boundary.test.ts test/integration/example-policy.test.ts
```

로컬 테스트는 인증 경계, 정책/schema 일치, Nest 주입, preview·요청 키·재시도 연결, 소유권·다운로드 무결성을 검증한다. 외부 인증 공급자와 실제 transaction 연결은 호스트 환경에서 검증한다. 영구 실행과 [Nestarc 조합](../../docs/nestarc-composition.md)은 실제 PostgreSQL 소비자 fixture에서 별도로 검증한다.
