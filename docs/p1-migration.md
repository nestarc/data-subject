# P1 미리보기·정책 검사·결과 검증·복구로 이전

P1은 [P0 호출·테넌트 계약](./p0-migration.md)을 유지하면서 R4~R7을 추가한다. 기본 삭제 경로는 안정적인 행 ID로 결과를 검증하며, 선택한 영구 실행 경로는 같은 PostgreSQL 안에서 중복 실행을 제어하고 artifact·통지를 재개한다. 패키지 버전과 실제 배포 여부는 릴리스 기록을 기준으로 확인한다.

## 1. 실행과 lint에서 같은 정책을 읽는다 — R5

`definePolicy()`는 JSON으로 직렬화 가능한 `EntityDefinition[]`을 검증하고 복사한다. 다음 `policy.ts`를 애플리케이션과 함께 빌드한다. `Profile`에는 `id`, `subjectId`, `tenantId`, nullable `email`, `displayName`, `createdAt` scalar 컬럼이 있다고 가정한다.

```ts
import { definePolicy } from '@nestarc/data-subject';

export const definitions = definePolicy([
  {
    entityName: 'Profile',
    subjectField: 'subjectId',
    stableIdField: 'id',
    scope: { mode: 'multi-tenant', tenantField: 'tenantId' },
    fields: {
      email: 'delete',
      displayName: { strategy: 'anonymize', replacement: '[removed]' },
    },
    ignoredFields: { createdAt: '서비스 생성 시각이며 삭제 대상에서 제외하기로 검토함' },
    exportFields: ['email', 'displayName'],
  },
]);
```

runtime은 `registry.registerDefinition(definitions[0], executor)`를 호출한다. 선언한 `scope`와 executor의 실제 scope metadata가 다르면 등록을 거절한다. Nest 모듈에서는 `definitions: [{ definition: definitions[0], executor }]`를 전달한다. 기존 `entities`/`register({ policy, executor })`도 지원하지만 공유 정책의 스키마 검사를 사용할 때는 `registerDefinition`으로 옮긴다.

등록 시 컴파일한 정책과 executor의 scope/ID metadata 및 메서드를 고정한다. 원본 객체나 `registry.get()` 결과를 수정하는 방식으로 실행 중 정책을 바꾸지 않는다. 정책 변경은 새 registry와 서비스 구성을 만든 뒤 새 미리보기로 진행한다. custom executor 내부의 실제 쿼리·트랜잭션 참여는 호스트가 책임진다.

CLI용 `data-subject.config.cjs`는 같은 빌드 결과를 가져온다. 정책을 다시 작성하지 않는다.

```js
const { definitions } = require('./dist/policy.js');
module.exports = { definitions, strictCoverage: true, checkRelations: true };
```

```sh
npx prisma validate --schema prisma/schema.prisma
npx data-subject lint --schema prisma/schema.prisma --config data-subject.config.cjs --format json
```

전체 schema에 요청 저장용 모델이나 업무 범위 밖 모델이 있다면 config의 `suppressions`에 `{ model: '모델명', reason: '구체적인 제외 이유' }`를 추가한다. 사유 없는 제외는 실패한다. 라이브러리 호출은 `lintPrismaSchema(schemaText, { definitions })`, 등록된 정책 확인은 `validateRegistry(registry, { schemaSource: schemaText })`를 사용한다.

공유 정의를 사용하면 `strictCoverage`와 `checkRelations`의 기본값이 `true`다. `subjectField`, `tenantField`, 명시한 `stableIdField`를 제외한 모든 scalar는 삭제/치환/보존 정책 또는 `ignoredFields` 사유가 필요하다. 새 컬럼명이 개인정보처럼 보이지 않아도 누락을 검출한다. `exportFields`는 별도 허용 목록이며 여기에만 등록했다고 삭제 정책을 충족하지 않는다. `ignoredFields`는 행 삭제를 막는 보존 지시가 아니므로 실제 보존 대상에는 `retain` 정책을 쓴다.

정의에는 함수·Date·undefined·순환 참조를 넣지 않는다. 선택 속성은 필요 없으면 생략한다. JSON 파일에서 읽는 경우에도 같은 구조를 사용하고 `definePolicy`를 통해 검증한다.

### 관계와 지원 구문

`relations`에는 검토한 Prisma 관계 필드명을 명시한다. `dependsOn`은 부모 엔티티 이름이며 자식을 먼저 실행한다. 예를 들어 `Invoice.user → User` 관계라면 `Invoice` 정의에 `relations: ['user'], dependsOn: ['User']`, `User` 정의에 역방향 관계 필드 `relations: ['invoices']`를 넣는다. 등록 순서 대신 이 의존 순서를 사용한다.

부모 행을 삭제할 때 자식은 먼저 행 삭제되거나 nullable FK를 null로 바꿔 연결을 끊어야 한다. 보존 중인 자식을 그대로 연결한 부모 삭제는 `Cascade` 포함 관계 충돌로 검출한다. nullable 필드를 required로 변경했는데 null 삭제 정책을 유지한 경우도 실패한다. 순환 관계, 명시하지 않은 관계, 미등록 관계 대상, implicit many-to-many는 지원하지 않는다. 별도 join 모델과 명시적인 정책을 사용한다. 임의의 관계를 찾아 자동 삭제하지 않는다.

파서는 한 줄에 완성된 필드/속성을 두는 제한된 Prisma schema 구문을 지원한다. `model`, `enum`, `generator`, `datasource`, scalar nullability, 명시한 FK/reference, 일반적인 속성을 읽고 알 수 없거나 잘린 구문은 실패 처리한다. composite type/view와 여러 줄 필드 선언 등은 미지원이다. 전체 Prisma 구문·타입·DB 의미 검증기를 대신하지 않으므로 `prisma validate`와 lint를 함께 실행한다.

## 2. 모든 삭제 실행기에 안정적인 조회키를 연결한다 — R6

```ts
const executor = fromPrisma({
  delegate: transactionBoundProfileDelegate,
  subjectField: 'subjectId',
  tenantField: 'tenantId',
  stableIdField: 'id',
});
registry.registerDefinition(definitions[0], executor);
```

`fromPrisma`의 `stableIdField` 기본값은 `id`다. 한 행을 식별하는 불변의 유일한 scalar 컬럼을 사용한다. 복합 ID를 단일 ID로 간주하지 않는다. custom executor는 `identityField`와 `selectByIds(ids, tenantId)`를 제공하고, 후자는 변경될 수 있는 subject 필터 대신 tenant와 안정적인 ID로 동일 행을 읽어야 한다. 정책의 `stableIdField`와 executor의 `identityField`가 다르면 거절한다.

실행 전에 ID 누락·중복·조회 불일치와 정책 필드 누락을 확인한다. 검증할 수 없는 executor는 기본적으로 `dsr_verification_unavailable`로 삭제 전에 실패한다. 모든 엔티티의 변경이 끝난 뒤 원래 ID로 다시 조회해 행 삭제, 삭제 필드의 null, 정적 치환 값, 보존 필드의 비변경을 확인한다. subject 컬럼을 치환해도 검증에서 사라진 행으로 오인하지 않는다. 필드 쓰기로 안정적인 ID나 tenant 컬럼을 변경할 수 없다.

`allowUnverified: true`는 기존 custom executor를 이전하는 동안의 명시적인 호환 옵션이다. 검증 누락은 `unverified`로 표시하며 검증 성공으로 표시하지 않는다. 영구 실행 경로에는 이 옵션을 사용할 수 없다. 누락을 허용하더라도 실제로 감지한 검증 실패를 무시하지 않는다.

## 3. 서명된 미리보기를 실행 전에 확인한다 — R4

```ts
const preview = await service.previewErase(verifiedSubjectId, authenticatedTenantId, {
  ttlMs: 60_000,
});
// Host displays the plan and authorizes execution for this verified subject.
const request = await service.erase(verifiedSubjectId, authenticatedTenantId, {
  requestedBy: authenticatedActorId,
  preview,
  requestKey: operationKey, // 영구 실행 경로일 때만 지정
});
```

`previewErase`는 요청 저장, 업무 데이터 변경, artifact 쓰기, outbox/audit 콜백을 호출하지 않는다. 엔티티별 예상 행 수, 실제 실행 전략, 삭제·치환·보존 필드명, 검증 가능 여부, 정책·대상 범위 hash를 반환한다. 원본 행 값이나 행 ID 목록은 반환하지 않는다. 응답에는 tenant/subject ID와 발급·만료 시각, 서명이 있으므로 미리보기 응답에도 호스트 인증·권한 검사를 적용한다.

기본 TTL은 5분이며 `previewTtlMs` 또는 호출의 `ttlMs`로 0보다 크고 1시간 이하로 설정한다. `previewSigningKey`는 최소 32바이트다. 생략하면 서비스 인스턴스별 임시 키를 사용하므로 프로세스 재시작이나 다른 인스턴스에서는 기존 미리보기를 검증할 수 없다. 여러 인스턴스가 처리한다면 동일한 비밀 키를 설정하고 키 교체 시 기존 미리보기를 다시 발급한다.

실행 시 서명·유효기간·tenant·subject를 확인하고, 트랜잭션 안에서 현재 정책과 대상 행·등록 필드의 fingerprint를 다시 계산한다. 정책·scope·검증 가능 여부·대상 데이터가 바뀌면 `dsr_plan_mismatch`, 만료되면 `dsr_plan_expired`로 재계획을 요구한다. 미리보기는 잠금이나 실행 예약이 아니다. 직전에 다시 확인하더라도 올바른 DB 트랜잭션 격리가 필요하다.

영구 저장소 없이 `preview`를 전달하는 일반 경로에는 `runInTransaction`이 반드시 필요하다. 이 콜백은 모든 executor가 실제 같은 transaction client를 쓰도록 연결하고 **Serializable** 격리로 완료 후 resolve해야 한다. 함수만 제공하고 executor가 전역 Prisma client를 호출하는 구현은 이 계약을 충족하지 않는다. `requestKey`를 쓰려면 아래 영구 저장소도 함께 설정한다.

## 4. PostgreSQL 영구 실행 저장소를 설치한다 — R7

[schema 예제](../prisma/schema.example.prisma)의 `DataSubjectExecution` 모델과 `DataSubjectRequest.execution` 관계를 기존 schema에 추가한 뒤 앱의 Prisma client를 재생성한다. [추가 SQL](../prisma/p1-durable-execution.sql)은 기존 `DataSubjectRequest` 테이블이 있는 PostgreSQL용이다. 실제 테이블명·스키마·마이그레이션 이력에 맞춰 애플리케이션의 마이그레이션으로 적용한다. `(tenantId, type, idempotencyKey)` 유일 제약을 제거하지 않는다.

아래는 생성된 client에 `profile`, `dataSubjectRequest`, `dataSubjectExecution`이 있는 호스트의 연결 예다. client import 경로는 사용 중인 Prisma generator 출력에 맞춘다. `artifactStorage`는 별도로 구성한 `ArtifactStorage` 구현, `previewSigningKey`는 비밀 설정에서 읽은 32바이트 이상의 값이다.

```ts
import { AsyncLocalStorage } from 'node:async_hooks';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  DataSubjectService, PrismaExecutionStore, Registry, fromPrisma,
  type ArtifactStorage, type DataSubjectServiceDeps,
} from '@nestarc/data-subject';
import { definitions } from './policy';

export function createPrivacyService(
  prisma: PrismaClient,
  artifactStorage: ArtifactStorage,
  previewSigningKey: Buffer,
  callbacks: Pick<DataSubjectServiceDeps, 'publishOutbox' | 'publishAudit'>,
) {
  const context = new AsyncLocalStorage<Prisma.TransactionClient>();
  const profile = new Proxy(prisma.profile, {
    get(_target, property) {
      const target = (context.getStore() ?? prisma).profile;
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const registry = new Registry();
  registry.registerDefinition(definitions[0], fromPrisma({
    delegate: profile,
    subjectField: 'subjectId',
    tenantField: 'tenantId',
    stableIdField: 'id',
  }));
  const store = new PrismaExecutionStore({
    client: prisma,
    bindTransaction: (transaction, work) => context.run(transaction, work),
    transactionOptions: { maxWait: 10_000, timeout: 30_000 },
  });
  return new DataSubjectService({
    registry,
    durableStore: store,
    requestStorage: store.requests,
    artifactStorage,
    previewSigningKey,
    artifactRetryTtlMs: { export: 86_400_000, erase: 86_400_000 },
    slaDays: 30,
    ...callbacks,
  });
}
```

각 엔티티 delegate에 같은 AsyncLocalStorage 연결을 적용한다. 일부 executor만 트랜잭션에 참여하면 rollback·원자성은 성립하지 않는다. durable 경로는 `bindTransaction`을 사용하며 별도의 일반 경로용 `runInTransaction`을 대신 사용하지 않는다. `requestStorage`는 동일한 `store.requests` 인스턴스여야 한다. 모듈을 사용하는 경우에도 이 인스턴스와 `durableStore: store`를 함께 전달한다.

`PrismaExecutionStore`는 Serializable 트랜잭션, 실행 레코드의 행 잠금, DB 유일 제약으로 예약과 실행을 조정한다. 기본 `maxWait`는 10초, `timeout`은 30초다. 확실히 rollback된 Prisma `P2034`와 raw SQL의 `P2010`/SQLSTATE `40001` 직렬화 충돌만 지수 백오프·jitter를 두고 기본 최대 8회 시도하며 `serializationAttempts`로 1~10회 범위에서 조정한다. 외부 콜백도 재시도될 수 있으므로 업무 executor 안에서 비트랜잭션 외부 부작용을 만들지 않는다.

`@@map`을 사용했다면 `executionTableName`, 기본 SQL search path 밖의 스키마라면 `executionSchemaName`을 지정한다. schema와 table은 각각 단순 식별자이며 점을 포함한 문자열을 table명으로 넘기지 않는다. 생성한 Prisma 모델의 이름은 `DataSubjectRequest`, `DataSubjectExecution`을 사용한다.

## 5. 동일 요청과 완료 재시도를 구분한다

영구 실행 경로의 `export`/`erase`에는 매번 `requestKey`가 필요하다. 같은 tenant·요청 종류·key는 하나의 요청 ID를 공유한다. payload hash에는 subject, tenant, 요청 종류, actor, 현재 정책 hash, 전달한 미리보기 전체가 포함된다. 같은 key에 다른 subject·actor·정책·미리보기를 붙이면 `dsr_request_conflict`다. 재시도용 key와 원래 호출 context를 호스트 업무 기록에 보관한다.

완료된 실행뿐 아니라 데이터 실행에 실패한 요청도 같은 key로 다시 삭제하지 않는다. 실패 원인을 수정한 뒤 새 업무 실행을 승인하려면 기존 요청을 조사하고 별도의 새 key를 발급한다. 만료된 미리보기를 새 미리보기로 교체하면서 원래 key를 재사용하면 payload가 달라진다. 이미 commit된 요청의 파일·통지만 복구하려면 원래 미리보기나 현재 정책으로 삭제를 다시 호출할 필요가 없다.

```ts
const current = await service.getRequest(requestId, authenticatedTenantId);
// Host checks access and decides this is an artifact/notification recovery.
const recovered = await service.retryCompletion(current.id, authenticatedTenantId);
```

`retryCompletion`은 저장된 원래 artifact 바이트와 미전달 통지를 사용한다. 업무 executor의 select/update/delete를 다시 호출하지 않으며 다른 프로세스로 재시작한 후에도 동일 DB와 artifact 저장소로 재개할 수 있다. 데이터 실행이 commit되지 않은 pending 요청을 이 API로 실행하지 않는다. `DataSubjectPersistenceError`처럼 commit 여부를 확인할 수 없는 오류는 제공된 요청 ID로 DB·artifact 상태를 먼저 대조한다.

업로드와 통지는 데이터 변경을 commit한 뒤 별도의 잠금 트랜잭션에서 처리한다. 완료 상태와 완료 이벤트를 DB에 먼저 commit한 뒤 외부 통지를 전달한다. 외부 업로드나 콜백은 DB rollback으로 취소되지 않으므로 같은 artifact key·동일 바이트의 반복 업로드가 안전한 저장소를 쓴다. 응답 유실이나 프로세스 중단으로 콜백은 **적어도 한 번** 전달될 수 있다. durable 콜백의 세 번째 인수 `DeliveryContext`에는 재시도에도 같은 `id`, `requestId`, `tenantId`가 들어온다.

```ts
const callbacks: Pick<DataSubjectServiceDeps, 'publishOutbox' | 'publishAudit'> = {
  publishOutbox: async (event, payload, delivery) => {
    if (!delivery) throw new Error('Durable delivery context required');
    await hostOutbox.insertOnce(delivery.id, { event, payload });
  },
  publishAudit: async (event, payload, delivery) => {
    if (!delivery) throw new Error('Durable delivery context required');
    await hostAudit.insertOnce(delivery.id, { event, payload });
  },
};
```

`hostOutbox`와 `hostAudit`는 호스트 구현 지점이다. `insertOnce`는 delivery ID의 영구 유일 제약으로 중복을 제어해야 한다. 프로세스 메모리의 Set만으로 대체하지 않는다. 사용하지 않는 콜백을 생략하면 해당 채널은 전달할 작업이 없는 것으로 처리한다. 일반 경로 콜백에는 durable delivery context가 없다. created/processing/erasure_requested 이벤트도 durable 경로에서는 데이터 commit 뒤 전달되므로 호스트 사전 승인 훅으로 사용하지 않는다.

작업은 단일 PostgreSQL과 제한된 크기·시간의 트랜잭션을 대상으로 한다. 파일 전체를 메모리와 DB JSON에 준비하고 외부 업로드/통지 동안에도 잠금 트랜잭션을 유지하므로 파일 크기와 provider timeout을 제한한다. 대규모 streaming export, 여러 DB의 분산 트랜잭션, 외부 시스템의 정확히 한 번 실행을 제공하지 않는다.

### 복구 payload 보존

업로드 전과 업로드 실패 시 `DataSubjectExecution.record.artifact.bodyBase64`에 원래 payload가 남는다. 업로드 결과가 DB에 확인되면 이 바이트를 같은 트랜잭션에서 `null`로 지우고 hash/key/상태를 남긴다. 성공 실행은 요청도 완료 상태로 바꾸며, 실패 증빙 업로드는 원래 요청의 실패 상태를 유지한다. 업로드 응답 후 DB commit이 불확실하면 바이트가 남을 수 있으며 다음 복구에서 동일 내용을 다시 확인한다.

복구 payload의 기본 TTL은 불변 `request.createdAt`부터 24시간이다. `artifactRetryTtlMs: { export, erase }`로 요청 종류별 밀리초를 지정한다. `expiresAt`을 실행 레코드에 저장하므로 프로세스 재시작이나 재시도로 TTL을 늘리지 않는다. 만료 후 재시도는 payload를 `null`로 지우고 `discardedAt`, `recovery: artifact_expired` 및 `data_subject.artifact_expired` 통지를 기록하며 다시 업로드하지 않는다. 이미 업로드한 파일의 별도 보존기간은 artifact 저장소 정책을 따른다.

실패한 export payload에는 개인정보가 포함될 수 있다. DB 접근 권한·암호화·보존기간과 정기적인 만료 정리 작업을 연결한다. 복구 가능한 payload를 지우면 원본 바이트 재업로드가 불가능하다. 실행 레코드 자체를 제거하면 그 key의 중복 방지 이력도 사라지므로 요청 재시도 허용 기간과 함께 관리한다. 단순히 TTL 값이 지났다는 이유만으로 DB 바이트가 즉시 사라지는 것은 아니며, 재시도 또는 호스트의 만료 정리 실행이 필요하다.

```ts
// 권한 있는 내부 worker에서 정기 실행한다. 공개 tenant 라우트로 노출하지 않는다.
const report = await service.expirePendingArtifacts(100);
if (report.failures.length > 0) {
  await hostOperations.recordCleanupFailures(report.failures);
}
```

이 API는 기본 최대 100건을 조회한 뒤 각 레코드를 잠그고 만료 여부를 다시 확인한다. `expired` 수와 요청 ID·tenant ID·오류 코드가 담긴 `failures`를 반환한다. 여러 tenant의 metadata를 처리하므로 호스트 관리자 작업으로만 사용한다. 스케줄러와 `hostOperations`는 호스트 구현 지점이며 DB 장애·실패 통지를 관찰하고 다음 주기에 다시 실행한다. 이 작업은 DB 안의 복구 바이트를 정리한다. S3 파일의 물리적 폐기는 별도 artifact 정리 작업으로 처리한다.

## 6. 증빙과 실패 상태를 읽는다 — R6·R7

새 삭제 증빙은 `data-subject.erasure-evidence.v2`, 요청의 `stats.evidence.schemaVersion`은 `data-subject.evidence.v2`다. 이전 v1 레코드를 새로 검증한 것으로 취급하지 않는다. v2는 `policyHash`, 실제 `effectiveRowStrategy`, 엔티티·필드별 확인 수와 `verified`/`unverified`/`failed` 상태, 전체 `verificationOverall`을 담는다. 요청의 `stats.verification`에도 결과를 저장한다. 원본 필드 값과 행 ID 목록은 증빙에 쓰지 않는다.

필드 검증 실패는 `state: failed`, `failureStage: data_execution`, `failureReason: dsr_verification_failed`로 기록한다. 실패한 실행을 성공 증빙으로 바꾸지 않는다. 검증 결과는 트랜잭션 안에서 관찰한 결과이므로 rollback 이후 DB의 최종 상태와 구분해야 한다. `dataOutcome: unknown`이면 실제 참여 범위와 DB 상태를 확인한다.

일반 경로는 정제한 검증 결과를 요청 stats에 남긴다. durable 경로는 추가로 `state: failed`, `verificationOverall: failed`, `failureStage: data_execution`의 원래 v2 증빙을 보존·업로드한다. 이 파일 업로드에 실패하면 원래 검증 실패를 덮어쓰지 않고 `stats.lifecycle.artifactFailure`에 추가 오류와 복구 방향을 남긴다. `retryCompletion`이 실패 증빙 업로드에 성공해도 삭제 요청을 `completed`로 바꾸지 않는다.

| 발생 위치 | 요청 의미 | 다음 작업 |
| --- | --- | --- |
| 검증 불가·정책/미리보기 불일치·데이터 검증 실패 | 데이터 실행 실패. 성공 완료가 아님 | 정책·executor·현재 DB 상태를 확인하고 새 실행 여부를 결정 |
| 데이터 commit 후 artifact 업로드 실패 | 일반적으로 `failed`, `dataOutcome: completed`, `failureStage: artifact_write` | `retryCompletion`으로 원래 바이트 업로드 |
| 완료 통지 실패 | `completed` 유지, `notificationFailures` 기록 | `retryCompletion`으로 미전달 통지만 전달 |
| 복구 payload TTL 만료 | `failed`, `artifactFailure`와 `recovery: artifact_expired`, 원본 바이트 폐기 | 만료 이력 확인. 원래 실행을 재호출해 증빙을 재생성하지 않음 |
| 저장·commit 결과 불확실 | `DataSubjectPersistenceError`와 요청 ID | 같은 ID의 DB/파일 상태를 조사한 뒤 복구 |

검증은 등록된 필드의 기술적 상태를 확인한다. 익명화의 재식별 불가능성, 법적 보존 근거의 충분성, 미등록 저장소·외부 시스템·backup 삭제를 판정하지 않는다. 완료와 검증 상태를 함께 표시한다.

## 7. 비공개 저장소와 애플리케이션 회귀 검증을 연결한다

[비공개 artifact 가이드](./private-artifacts.md)와 [예제 구현](https://github.com/nestarc/data-subject/tree/main/examples/private-artifacts)은 인증된 다운로드, 짧은 서명 링크, export/증빙별 보존기간, 같은 키 업로드 재시도, 만료·고아 객체 정리를 다룬다. 코어에 AWS 의존성을 추가하지 않으며 실제 bucket/IAM 환경은 호스트에서 검증한다. 내부 `artifactUrl`을 공개 다운로드 URL로 그대로 응답하지 않는다.

이전 시 signed preview 만료·변조·정책/대상 변경, 임의 신규 scalar 컬럼, 필수 필드 null 삭제, 관계 순서·보존 충돌, no-op executor, 보존 값 변경, subject 키 변경을 검증한다. 영구 실행은 같은 key의 동시 호출, 다른 payload 충돌, tenant/요청 종류별 격리, 실제 DB rollback, 업로드·통지 실패 후 새 프로세스 복구를 확인한다. [실제 패키지 소비자 fixture](https://github.com/nestarc/data-subject/blob/main/test/compatibility/p1.ts.in)와 [호환성 실행 안내](./compatibility.md)를 참고한다. 문서의 fixture 설명은 특정 배포 환경이나 원격 CI의 실행 완료를 뜻하지 않는다.
