# P2 작업 큐와 배치 실행

P2는 선택 기능이다. [P1](p1-migration.md)의 한 요청 전체 트랜잭션과 원본 artifact 복구를 유지하면서 별도의 PostgreSQL 작업 큐와 배치 경로를 제공한다. 기존 `DataSubjectService.export()`는 ZIP을 생성하며, 새 배치 export는 NDJSON을 생성한다. 두 API의 완료 의미와 파일 형식을 혼용하지 않는다.

## 경로 선택

| 목적 | 경로 | 트랜잭션·결과 범위 |
| --- | --- | --- |
| 관계가 있는 모델, 서명된 삭제 미리보기, 한 요청 전체 rollback | P1 `DataSubjectService` + `PrismaExecutionStore` | 같은 DB에 참여한 전체 요청, 원본 artifact 복구 |
| 독립 모델의 많은 행, 배치 단위 재개·취소 | `PostgresJobStore` + `createPagedPrivacyHandler` | 한 배치와 checkpoint가 원자적으로 commit. 이전 배치는 유지 |
| Transcend 삭제 요청 접수·회신 | [Transcend 어댑터](platform-integration.md) | 큐 진행과 P1 실행은 별도 트랜잭션. P1의 영구 key와 provider nonce로 재전송 처리 |

배치 경로는 검토한 독립 모델만 지원한다. 등록 모델에 연결된 Prisma 관계가 하나라도 있으면 거절한다. 관계가 있는 모델을 schema에서 숨겨 이 검사를 우회하지 않는다. 분산 트랜잭션, 전체 작업의 snapshot 일관성, 임의 관계 그래프 삭제, streaming ZIP은 제공하지 않는다.

## 설치와 트랜잭션 연결

[p2-jobs.sql](../prisma/p2-jobs.sql)을 업무 테이블과 **같은 PostgreSQL 데이터베이스**에 애플리케이션 마이그레이션으로 적용한다. `DataSubjectJob`과 `DataSubjectJobChunk`, key 유일 제약, ready/expiry 부분 인덱스가 필요하다. Prisma 모델이 필요한 경우 [schema 예제](../prisma/schema.example.prisma)를 참고하되 SQL의 CHECK 제약과 부분 인덱스도 유지한다. 이 저장소는 매개변수화한 SQL을 사용하므로 생성 client에 job delegate가 없어도 동작한다.

```ts
import { AsyncLocalStorage } from 'node:async_hooks';
import { Prisma, PrismaClient } from '@prisma/client';
import { PostgresJobStore, pagedFromPrisma } from '@nestarc/data-subject';

const prisma = new PrismaClient();
const context = new AsyncLocalStorage<Prisma.TransactionClient>();
const profile = new Proxy(prisma.profile, {
  get(_target, key) {
    const delegate = (context.getStore() ?? prisma).profile;
    const value = Reflect.get(delegate, key);
    return typeof value === 'function' ? value.bind(delegate) : value;
  },
});

const jobs = new PostgresJobStore({
  client: prisma,
  bindTransaction: (tx, work) => context.run(tx, work),
  retentionMs: 7 * 24 * 60 * 60 * 1000,
});
const pagedProfile = pagedFromPrisma({
  delegate: profile,
  subjectField: 'subjectId',
  tenantField: 'tenantId',
  stableIdField: 'id',
});
```

이 예제는 `profile` 모델이 있는 Prisma 5 호스트의 연결 형태다. Prisma 7의 generator/adapter 초기화는 [호환성 안내](compatibility.md)를 따른다. 모든 업무 delegate가 `context`의 실제 transaction client를 읽어야 한다. `bindTransaction`만 선언하고 전역 client로 쓰면 배치 rollback과 checkpoint 원자성이 성립하지 않는다. custom schema는 datasource/driver 설정과 저장소의 `schemaName`을 함께 맞춘다. `tableName`, `chunkTableName`은 모델의 실제 SQL 이름으로 설정한다.

## 정책과 작업 등록

P1의 `definePolicy`와 `registerDefinition`으로 만든 registry, 실제 Prisma schema 원문, 별도 paged executor를 전달한다. handler 생성 시 strict scalar coverage와 안정적인 ID, nullability, 관계 유무를 검사한다. 등록하지 않는 운영 모델은 `excludedModels: { DataSubjectJob: '작업의 별도 만료·정리 정책 적용' }`처럼 모델별 구체적인 사유로 제외한다. 해당 schema에 있는 미등록 모델마다 사유가 필요하며, 등록 모델 제외·없는 모델 이름·빈 사유는 거절한다. 제외 모델에서 등록 모델로 연결되는 관계도 검사한다. ID는 유일하고 변경되지 않는 단일 String 또는 Int primary key다. 복합 ID와 BigInt ID는 이 경로에서 지원하지 않는다.

```ts
import { randomUUID } from 'node:crypto';
import {
  PAGED_PRIVACY_JOB_KIND, createPagedPrivacyHandler, createPagedPrivacyPayload,
} from '@nestarc/data-subject';

const handler = createPagedPrivacyHandler({
  registry, // registerDefinition으로 등록한 검토된 정책
  schemaSource, // 실제 모델/관계를 포함한 Prisma schema 텍스트
  executors: { Profile: pagedProfile },
  batchSize: 500,
  maxChunkBytes: 1024 * 1024,
});

const { job, created } = await jobs.submit({
  id: randomUUID(),
  tenantId: authenticatedTenantId,
  kind: PAGED_PRIVACY_JOB_KIND,
  idempotencyKey: approvedOperationKey,
  payload: createPagedPrivacyPayload({ type: 'erase', subjectId: verifiedSubjectId, registry }),
});
```

`tenantId`, subject 검증, 업무 승인과 operation key는 호스트가 결정한다. 임의 HTTP body를 그대로 `submit()`에 전달하지 않는다. `(tenantId, kind, idempotencyKey)`가 같은 요청은 같은 작업을 반환한다. payload가 다르면 충돌한다. export와 erase는 같은 kind를 사용하므로 각각 다른 업무 key를 발급한다. P1의 서명된 preview는 전체 요청 snapshot용이며 이 배치 API의 실행 승인으로 사용할 수 없다.

payload의 정책 hash와 현재 registry가 다르면 변경 전에 실패한다. 기존 작업 도중 정책을 바꾸면 원래 정책의 worker로 재개하거나 부분 완료 상태를 조사한 뒤 새 작업을 승인한다. 저장된 checkpoint를 직접 편집해 cursor나 정책을 바꾸지 않는다.

## Worker와 재시도

```ts
// 스케줄러 또는 worker loop가 한 번 호출할 때 최대 한 배치를 처리한다.
const current = await jobs.runNext(handler, { kind: PAGED_PRIVACY_JOB_KIND });
// current === null이면 지금 처리할 준비가 된 작업이 없다.
```

worker가 row lock을 잡고 `FOR UPDATE SKIP LOCKED`로 준비된 작업을 선택한다. 다른 worker는 잠긴 작업을 건너뛰고 다른 작업을 처리한다. handler는 한 배치의 업무 변경, 검증, 최대 한 chunk, 다음 checkpoint를 같은 Serializable 트랜잭션에서 저장한다. 프로세스가 commit 전에 종료되면 모두 rollback되고, commit 뒤 종료되면 저장된 cursor부터 진행한다. 한 작업의 여러 배치를 동시에 실행하지 않는다.

기본 transaction timeout은 30초이며 작업 크기에 맞춰 `transactionOptions`로 제한한다. `maxAttempts` 기본 5회는 연속 실패 기준이고, 성공한 배치는 횟수를 초기화한다. 기본 1초부터 증가하는 재시도 간격과 `availableAt`을 사용한다. 알려진 DB serialization abort만 별도로 제한 재시도한다. commit 응답이 불확실한 경우 오류를 반환하며, DB의 작업 상태와 checkpoint를 조회해 판단한다.

`runNext()`가 반환했다고 항상 성공한 것은 아니다. `state`, `attempts`, `lastError`, `partial`, `result`를 확인한다. `lastError`에는 정제한 코드만 저장한다. 외부 API 호출이나 다른 DB의 변경은 이 트랜잭션으로 취소할 수 없다. custom handler는 그런 호출에 별도의 영구 중복 방지·응답 대조 방식을 제공해야 한다. Transcend handler는 이 경계가 다른 전용 경로다.

## 범위와 검증 의미

첫 배치에서 엔티티별 최대 ID를 저장하고 이후 `cursor < id <= upperBound` 범위를 정렬해 조회한다. 페이지 크기는 1~1000행이다. 문자열 정렬은 DB의 순서를 따른다. 모든 쓰기는 해당 페이지의 안정적인 ID와 tenant로 제한하며, subject 키를 치환해도 원래 ID로 결과를 검증한다.

삭제 배치는 수행 전에 ID 조회가 작동하는지 확인하고, 수행 후 null·정적 치환·보존값·행 삭제를 확인한다. no-op executor나 보존값 손상은 해당 배치를 rollback한다. 증빙 chunk에는 정책 hash, 행 수, 전략, 필드 검증 상태를 기록하며 원본 값과 ID 목록은 넣지 않는다. 이 증빙은 `data-subject.paged-evidence.v1`이고 P1의 전체 요청 v2 증빙과 다르다.

여러 배치는 같은 시점의 DB snapshot이 아니다. cursor 이전에 새로 들어온 행, 실행 중 subject를 바꾼 행, 검증 후 다시 변경된 값은 전체 작업의 검증 범위 밖일 수 있다. 전체 subject의 정적인 삭제 완료가 필요한 호스트는 새 쓰기와 재유입을 차단하거나 별도의 조정 절차를 제공해야 한다. 완료 결과는 저장된 범위와 각 배치에서 확인한 상태를 뜻한다. 미등록 저장소나 백업의 삭제를 주장하지 않는다.

## 취소와 부분 완료

```ts
const cancelled = await jobs.cancel(jobId, authenticatedTenantId);
// 기존 데이터 변경을 조사·승인한 뒤 실패/취소한 작업을 같은 cursor에서 재개한다.
const resumed = await jobs.retry(jobId, authenticatedTenantId);
```

취소는 현재 배치의 row lock이 풀린 뒤 적용된다. 이미 commit된 삭제를 되돌리지 않으며 다음 배치를 막는다. 실패/취소 작업에 업무 변경이 있으면 `hasCommittedChanges`와 `partial`이 true다. export와 retain-only 작업은 업무 데이터를 바꾸지 않으므로 처리한 행이 있어도 이 flag가 false일 수 있다. `processedRows`와 `pagesCommitted`도 함께 표시한다. Transcend처럼 별도 트랜잭션에서 실행하는 adapter는 실행 전 변경 가능성을 보수적으로 표시한다. 해당 경로의 true는 실제 변경의 증명 대신 P1 요청 상태를 대조해야 한다는 뜻이며, 결과의 `dataOutcome`도 확인한다.

재개는 원래 checkpoint를 유지한다. 완료 작업, 만료 작업, chunk를 폐기한 작업은 재개할 수 없다. 새 key로 다시 등록하면 새로운 업무 실행이므로 자동 복구 수단으로 사용하지 않는다. job에는 P1 요청의 `RequestState`와 별개의 상태 모델을 사용한다.

## NDJSON 내보내기와 보존기간

export는 조회에 필요한 ID·tenant·subject와 `exportFields`만 선택하고, 파일에는 허용 목록의 값만 넣어 다음 모양의 NDJSON chunk를 저장한다. 허용 목록이 비어 있는 엔티티는 조회하지 않는다. 저장소 내부에는 페이지 단위 bytea가 남고 다운로드 시 한 chunk씩 읽는다.

```json
{"entityName":"Profile","data":{"email":"example@example.test","displayName":"Example"}}
```

인증된 tenant와 subject에 대한 조회 권한을 확인한 뒤 완료 작업의 chunk만 스트리밍한다.

```ts
import { Readable } from 'node:stream';

// 호스트에서 job payload.subjectId까지 권한을 확인한 후 사용한다.
const stream = Readable.from((async function* () {
  for await (const chunk of jobs.readChunks(jobId, authenticatedTenantId)) yield chunk.body;
})());
// Content-Type: application/x-ndjson; 호스트 HTTP 응답에 backpressure를 유지해 연결한다.
```

전체 chunk를 배열에 모으거나 `Buffer.concat`해 스트리밍의 메모리 제한을 없애지 않는다. handler는 기본 1 MiB, 저장소는 기본 8 MiB의 chunk 제한을 두며 더 작은 제한이 적용된다. 행 수와 저장 byte 수의 제한이며, DB driver가 materialize하는 개별 큰 값의 메모리까지 절대적으로 제한하지는 않는다. 크기가 제한되지 않은 LOB는 이 경로에서 제외하고 호스트에서 필드 크기 제한을 적용한다. NDJSON은 JSON 직렬화를 따르며 BigInt 값은 10진 문자열, Date는 ISO 문자열로 기록한다. BigInt 값의 export와 BigInt ID 지원은 별개다. 파일을 ZIP으로 표시하지 않는다.

job의 기본 보존기간은 생성 시점부터 7일이다. `retentionMs`는 1밀리초~365일이며 생성 시 `expiresAt`에 고정된다. 재시도·재시작으로 연장하지 않는다. 만료되면 chunk 읽기와 작업 재개를 거절한다. 페이지 도중 만료되면 해당 페이지를 commit하지 않는다.

```ts
// 권한 있는 내부 관리 worker에서 정기 호출한다.
const purged = await jobs.purgeExpiredChunks(100);
```

이 정리는 최대 100개 만료 작업을 잠그고 작업마다 최대 1,000 chunk를 삭제하며, 개인정보를 포함할 수 있는 payload/checkpoint/result도 지운다. chunk가 더 남으면 다음 주기에 이어서 정리한다. 반환값은 이번에 처리한 작업 수이고 완전 삭제가 끝난 작업 수는 아니다. queued 작업은 failed로 바뀌며, identity·hash·처리 건수는 중복 방지 이력으로 남긴다. 물리적 삭제는 정리 worker의 반복 실행이 필요하다. `deleteChunks(id, tenantId)`는 완료/실패/취소 작업의 파일을 1,000개씩 별도 트랜잭션으로 모두 폐기하는 API이며 첫 정리부터 재개를 차단한다. 원격 S3 파일 정리와 P1 retry payload 정리는 각각 별도 API다. metadata 자체를 삭제하면 key의 중복 방지 이력도 사라지므로 호스트의 업무 재시도 기간과 함께 관리한다.

## 검증과 남은 도입 조건

[실제 패키지 소비자 fixture](https://github.com/nestarc/data-subject/blob/main/test/compatibility/p2.ts.in)는 합성 데이터를 사용해 동시 worker, 중복 요청, 배치 rollback, 프로세스 종료·재개, 부분 취소, 필드 검증, NDJSON 허용 목록과 페이지 제한을 검사한다. 정확한 실행 버전과 결과는 [호환성 문서](compatibility.md)를 따른다. [nestarc 조합 검증](nestarc-composition.md)은 별도 고정 조합이다.

실제 고객 데이터 분포의 부하·메모리·시간 제한, live Transcend 계정, 운영 환경의 접근 권한과 보존 작업, 고객 채택과 유료 지원 계약은 이 합성 검증에 포함되지 않는다. [지원 제안서](p2-support-proposal.md)는 검증할 가설과 제공 범위를 구분한다.
