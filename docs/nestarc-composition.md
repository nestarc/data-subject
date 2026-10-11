# Nestarc 조합 예제와 검증 범위

2026-10-11 기준. 이 예제는 P2 R10의 **기술 조합 검증**이다. 고객 도입, 유료 계약, 공식 제휴 또는 다른 버전까지의 호환성을 뜻하지 않는다. data-subject 실행 코어는 아래 패키지 없이도 사용할 수 있다.

## 고정한 조합

| 구성요소 | 검증 버전 | 역할 |
| --- | --- | --- |
| Node.js | 24.11.1 | 소비자 실행 환경 |
| NestJS common/core/testing | 11.2.7 | 실제 Nest provider 초기화 |
| Prisma CLI/client/adapter-pg | 7.10.0 | 생성된 클라이언트와 PostgreSQL |
| PostgreSQL | 16.15 | 임시 DB, 독립 schema, RLS |
| @nestarc/tenancy | 0.16.1 | 인증 후 tenant context, transaction-local DB setting |
| @nestarc/audit-log | 0.7.0 | 수동 요청 lifecycle 감사 기록 |
| @nestarc/outbox | 0.4.0 | 요청 lifecycle 이벤트의 영구 저장 |
| @nestjs/schedule | 5.0.1 | outbox가 요구하는 peer |
| @opentelemetry/api | 1.9.0 | tenancy의 공개 선언 파일을 엄격하게 검사하기 위한 타입 peer |
| pg / TypeScript | 8.16.3 / 5.9.3 | PostgreSQL 드라이버 / `strict`, `skipLibCheck: false` |

Nestarc 버전은 공개 npm registry에서 확인하고 설치했다. data-subject는 작업 트리에서 `npm pack`한 artifact를 설치한다. [tenancy npm](https://www.npmjs.com/package/@nestarc/tenancy), [audit-log npm](https://www.npmjs.com/package/@nestarc/audit-log), [outbox npm](https://www.npmjs.com/package/@nestarc/outbox)의 공개 배포물과 [테스트 lockfile](https://github.com/nestarc/data-subject/blob/main/test/composition/package-lock.json)이 버전·integrity 근거다. sibling 저장소나 `src` 경로를 consumer에서 직접 import하지 않는다. peer 충돌을 `--force`나 `--legacy-peer-deps`로 우회하지 않는다.

## 실행과 전달 경계

[composition.ts](https://github.com/nestarc/data-subject/blob/main/examples/nestarc-composition/composition.ts)는 Prisma 7의 생성된 클라이언트 옆에 복사하는 예제다. `profile` 모델 이름과 registry를 자신의 schema에 맞게 바꾸고, Nest provider factory에서 반환된 service들을 등록한다. [검증 fixture](https://github.com/nestarc/data-subject/blob/main/test/composition/smoke.ts.in)는 실제 Nest container 등록과 정책·executor 연결을 보여 준다.

1. 호스트가 인증한 principal의 tenant membership과 요청 subject/action 권한을 확인한다. 예제의 `runForTenant`는 전달받은 principal의 tenant 목록만 검사한다. 이것 자체가 토큰 검증이나 subject 소유권 검증은 아니다. HTTP header를 그대로 principal로 변환하면 안 된다.
2. `TenancyContext`와 `AuditContext`를 설정한다. 프로세스 밖 작업도 호스트가 허용한 tenant/actor로 context를 복원해야 한다. 조회·미리보기는 tenancy extension을 통하고, 실행은 `tenancyTransaction`이 DB setting을 설정한 callback client만 사용한다.
3. `PrismaExecutionStore`가 같은 PostgreSQL transaction 안에서 업무 데이터, 요청 상태, 원래 artifact bytes와 전달할 통지 목록을 기록한다. 모든 executor는 예제의 `AsyncLocalStorage`가 제공하는 transaction client를 사용한다.
4. 데이터 commit과 artifact 처리가 끝난 후 별도 전달 transaction에서 `AuditService.log(input, tx)`와 `OutboxEmitter.emit(tx, event, options)`를 호출한다. 각 행과 data-subject의 전달 완료 표시는 이 전달 transaction에 함께 참여한다. audit/outbox 행은 원래 업무 데이터 transaction에 직접 삽입되는 것이 아니다.
5. outbox consumer나 broker publisher는 호스트가 별도로 설정한다. 여기서 outbox 행의 저장 성공은 외부 소비자의 처리 완료를 뜻하지 않는다. 외부 전달은 중복 가능하므로 소비자는 전달 ID로 중복을 처리해야 한다.

기본 이벤트 payload는 request ID와 notification ID만 포함한다. subject ID, artifact URL, 원본 field 값은 외부 이벤트나 감사 metadata로 복제하지 않는다. 감사 actor는 **전달 시 실행한 인증된 actor**다. 최초 요청자의 식별자는 data-subject 요청의 `requestedBy`로 따로 보존한다. `VerifiedPrincipal.actorType`은 audit-log 0.7.0의 공개 `AuditActor` 타입을 따르며 생략하면 기존 호출과 같이 `user`다. 호스트가 인증한 내부 worker에는 `system`, API key 주체에는 `api_key`를 명시한다. actor 종류와 tenant 목록을 HTTP header/body에서 그대로 받지 않는다.

```ts
// 호스트가 worker 자격과 tenant 접근 권한을 확인한 뒤 구성한다.
await composition.runForTenant({
  actorId: 'completion-worker',
  actorType: 'system',
  tenantIds: [authorizedTenantId],
}, authorizedTenantId, () => composition.service.retryCompletion(requestId, authorizedTenantId));
```

이미 전달된 감사 행의 actor는 유지되며, worker가 재전달한 행은 worker 자신의 ID와 종류를 기록한다. `requestedBy`는 원래 요청자의 식별자를 유지한다.

## 중복 전달과 실패 처리

outbox 0.4.0의 `idempotencyKey`는 저장되는 메타데이터다. 그 값만으로 중복 INSERT를 막는다고 가정하지 않는다. 예제는 [delivery-receipts.sql](https://github.com/nestarc/data-subject/blob/main/examples/nestarc-composition/delivery-receipts.sql)의 `(tenantId, notificationId)` 기본 키로 중복을 판단한다. receipt와 대상 audit/outbox 쓰기를 같은 transaction에 묶는다.

각 callback은 savepoint를 만든다. 대상 저장이 성공한 다음 callback이 오류를 던져도 receipt와 대상 쓰기를 함께 되돌리고 오류를 data-subject에 넘긴다. 따라서 이미 완료된 삭제를 다시 실행하지 않고 `retryCompletion`으로 전달만 재시도할 수 있다. 이 경로는 **같은 PostgreSQL transaction에 참여하는 sink**를 위한 예제다. 네트워크 전송·다른 DB의 쓰기는 savepoint로 취소할 수 없다. 그런 adapter는 원격 시스템의 idempotency 계약을 사용해야 한다.

receipt의 수명은 요청의 재시도 가능 수명과 맞춘다. 재전달 가능한 요청의 receipt만 먼저 지우면 중복이 생길 수 있다. 예제 FK는 해당 요청의 명시적 삭제 때 receipt를 함께 제거한다. 요청/감사/outbox 보존 정책은 각각 호스트가 정해야 하며, 이 예제는 자동 정리 작업을 만들지 않는다.

## DB 설정과 권한

- `DataSubjectRequest`, `DataSubjectExecution`, 업무 모델, `audit_logs`, `outbox_events`, delivery receipt에 tenant RLS를 적용한다. 기본 setting key는 `app.current_tenant`다. 호스트가 이를 변경하면 모든 정책과 runtime 설정도 일치시킨다.
- 애플리케이션 DB role은 테이블 소유자가 아니며 `NOSUPERUSER NOBYPASSRLS`여야 한다. raw Prisma client는 provider 내부에만 보관한다. 미리보기와 요청 조회에도 tenant context가 필요하다.
- `schemaName`은 실제 Prisma 모델 schema, `PrismaPg`의 schema, raw SQL의 `search_path`와 일치해야 한다. outbox의 SQL은 `outbox_events` 이름을 사용한다. 여러 schema를 쓰는 애플리케이션은 connection의 `search_path`를 명시한다.
- 일반 애플리케이션 role은 schema/role 생성 권한을 갖지 않는다. 테스트의 관리자 연결은 임시 schema와 제한된 role 준비·삭제에만 사용한다.

## 재현

아래 명령은 DB가 존재하고 연결 계정에 해당 임시 schema와 role을 생성할 권한이 있을 때 실행한다. 운영 DB에는 실행하지 않는다.

```sh
DATABASE_URL=postgresql://USER:PASSWORD@127.0.0.1:5432/DISPOSABLE_DB \
  node test/composition/run.cjs
```

runner는 고유 schema를 만들고 종료 시 자신이 생성한 schema와 role만 제거한다. npm cache는 OS 임시 디렉터리를 사용한다. 진단을 위해 임시 consumer를 남기려면 `KEEP_COMPOSITION_WORKSPACE=1`을 지정한다.

검증하는 동작은 엄격한 타입 검사, Nest provider 초기화, 실제 RLS가 있는 두 tenant의 같은 subject export/erase 처리, export 허용 목록, 읽기 전용 미리보기, 다른 tenant의 요청 조회 거절, 데이터 변경의 롤백, lifecycle 감사·outbox 행, 감사·outbox 삽입 직후 callback 실패의 savepoint 롤백, service actor의 전달만 재시도와 원래 `requestedBy` 보존, 동일 요청 반복 및 저장된 통지 ID 재전달 시 실행/통지 중복 방지, pooled connection의 tenant context 누출 방지다. 2026-10-11 로컬 임시 PostgreSQL에서 이 경로를 통과했다. artifact 저장소는 이 fixture에서 메모리 구현을 사용하므로 실제 S3 연결 검증은 포함하지 않는다.

outbox poller, broker, webhook delivery, audit 자동 모델 추적, managed pooler, Prisma 5/6, Nest 10/12의 **이 세 패키지 조합**은 이 fixture의 검증 범위에 포함하지 않는다. 개별 data-subject 지원표는 [compatibility.md](compatibility.md)를 따른다. 실제 고객 schema의 검증은 별도 도입 단계다.
