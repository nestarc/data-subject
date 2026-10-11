# P0 호출·격리·완료 계약으로 이전

이 문서는 0.2.0의 기존 호출부를 P0 구현으로 옮기는 방법이다. 호환되지 않는 API 변경이 있으므로 기존 앱의 호출부와 custom executor/storage를 함께 수정해야 한다. 패키지 버전 번호와 실제 배포 여부는 `package.json` 및 릴리스 기록을 기준으로 한다.

## 1. 내보내기 필드를 별도로 지정한다

기존 동작은 executor가 반환한 행 전체를 ZIP에 넣었다. 이제 `PolicySpec.exportFields`에 명시한 최상위 필드만 내보낸다. 생략하거나 `[]`이면 해당 엔티티를 조회하지 않고 ZIP에서도 제외한다. 기존 삭제 정책의 `fields`를 자동으로 export 목록으로 사용하지 않는다.

```ts
registry.register({
  policy: {
    entityName: 'User',
    subjectField: 'userId',
    fields: { email: 'delete', passwordHash: 'delete', sessionToken: 'delete' },
    exportFields: ['email'],
  },
  executor: fromPrisma({
    delegate: prisma.user,
    subjectField: 'userId',
    tenantField: 'tenantId',
  }),
});
```

`passwordHash`나 `sessionToken`은 위 정책으로 삭제되지만 ZIP에 포함되지 않는다. 중복·빈 필드명은 정책 오류다. 허용한 JSON/관계 객체의 내부는 재귀 필터링하지 않으므로 필요한 필드만 직접 반환하는 custom executor를 사용하거나 별도의 평탄한 export 모델을 정의한다. allowlist에 있는 필드도 executor가 반환하지 않으면 출력에 없다. 필드명과 실제 스키마의 완전한 일치 검사는 후속 로드맵 범위다.

## 2. 실행기의 테넌트 범위를 선언한다

`fromPrisma`는 `tenantField` 또는 `singleTenantId` 중 정확히 하나를 요구한다. 둘 다 생략했던 기존 코드는 거절된다. multi-tenant가 서비스의 기본 모드다.

```ts
// Multi-tenant: select/update/delete 모두 두 조건을 사용한다.
fromPrisma({ delegate: prisma.user, subjectField: 'userId', tenantField: 'tenantId' });

// Single-tenant: 설치당 한 테넌트만 있는 DB에서 명시적으로 선택한다.
const singleTenantId = 'installation-a';
const executor = fromPrisma({ delegate: prisma.user, subjectField: 'userId', singleTenantId });
const service = new DataSubjectService({
  registry, requestStorage, artifactStorage, slaDays: 30, singleTenantId,
});
// registry에 등록한 executor의 singleTenantId도 같은 값이어야 한다.
```

single-tenant도 `service.export(subjectId, singleTenantId)`처럼 고정 ID를 전달한다. 다른 tenant ID는 거절된다. subject·tenant·request ID와 전달한 `requestedBy`는 비어 있거나 공백만 있는 문자열일 수 없다.

custom executor는 `scope: { mode: 'multi-tenant', tenantField: 'tenantId' }` 또는 `scope: { mode: 'single-tenant', tenantId: 'installation-a' }`를 선언하고 실제 쿼리에서 그 계약을 지켜야 한다. 서비스는 실행 전에 모든 등록 executor의 metadata와 모드 일치를 검사한다. metadata는 임의의 executor 구현이 올바르게 필터링한다는 증명은 아니다. 서비스와 adapter를 우회해서 runner를 직접 호출하는 경우 서비스의 입력·scope 검증도 우회하므로 외부 요청 진입점에는 `DataSubjectService`를 사용한다.

## 3. 요청 조회와 저장소 호출에 tenant ID를 전달한다

| 기존 호출 | 새 호출 |
| --- | --- |
| `service.getRequest(id)` | `service.getRequest(id, tenantId)` |
| 저장소 URL 직접 전달 | 권한 확인 후 `service.getArtifact(id, tenantId)`로 바이트 조회 |
| `storage.findById(id)` | `storage.findById(id, tenantId)` |
| `storage.update(id, patch)` | `storage.update(id, tenantId, patch)` |

기본 저장소는 tenant 조건을 조회·수정에 포함한다. 다른 tenant의 ID와 존재하지 않는 ID는 모두 찾을 수 없는 요청으로 처리한다. custom storage도 같은 계약을 구현해야 하며, `id`, `tenantId`, `subjectId`, `type`, `createdAt`을 patch로 바꾸는 동작은 거절해야 한다. 요청 ID의 전역 유일성은 그대로 유지한다.

`getArtifact`는 요청을 tenant 조건으로 확인한 뒤 tenant별 artifact key를 생성한다. tenant 안에서 누구의 요청을 볼 수 있는지는 호스트가 추가 검사해야 한다. `listByTenant`를 연결하는 관리자 경로에도 권한 검사가 필요하다. `listOverdue`는 모든 tenant를 다루므로 권한 있는 내부 작업에서만 사용한다.

기존 `DataSubjectRequest` 테이블에 컬럼을 추가할 필요는 없다. 새 실행 metadata는 기존 `stats` JSON의 `lifecycle`에 저장한다. custom serializer가 이 JSON을 손실 없이 보존하는지 검증한다. 과거 레코드에는 `lifecycle`이 없으며 이를 `not_started`로 간주하면 안 된다. 기존 artifact는 새 allowlist로 소급 변경되지 않으므로 이전 ZIP의 공개 범위와 보존·폐기를 별도로 검토한다.

## 4. 인증·권한·본인 확인을 호출 전에 연결한다

코어는 토큰을 인증하거나 요청자의 본인 확인을 대신하지 않는다. 호스트가 인증된 actor의 tenant 소속과 작업 권한을 검사하고 권위 있는 기록으로 subject를 확인한 뒤 호출한다.

```ts
await service.erase(verifiedSubjectId, authenticatedTenantId, {
  requestedBy: authenticatedActorId,
});
```

`requestedBy`는 감사용 actor를 기록하며 권한을 부여하는 값이 아니다. 선택 인수를 생략한 내부 호출은 이전처럼 `null`을 저장한다. 외부 HTTP body에서 tenant/subject/actor를 그대로 받아 실행하지 않는다. [NestJS 호스트 예제](https://github.com/nestarc/data-subject/tree/main/examples/tenant-safe)는 인증·작업별 권한·주체 확인을 분리하고 기본 구현은 모든 호출을 거절한다. 다운로드는 같은 tenant 안에서도 요청의 subject 일치를 검사하며 내부 `artifactUrl`을 응답 DTO에 노출하지 않는다.

## 5. failed를 “삭제되지 않음”으로 해석하지 않는다

DB 실행과 완료 후 artifact/통지 단계를 분리했다. `runInTransaction`이 성공적으로 resolve된 이후에 artifact를 업로드하고 완료 상태를 저장한다. 완료 상태 이후 outbox·audit 콜백은 각각 독립적으로 시도한다. 한 콜백의 실패가 이미 완료된 요청을 `failed`로 바꾸거나 데이터 삭제를 rollback하지 않는다.

| 발생 위치 | 요청 상태와 metadata | 운영 판단 |
| --- | --- | --- |
| 요청 저장 후 created 이벤트 또는 감사 콜백 | `failed`, `failureStage: request_created`, `dataOutcome: not_started`, `recovery: retry_request` | 생성 통지의 중복 가능성을 확인한 뒤 새 요청 실행 여부를 결정 |
| processing 저장 또는 감사 콜백 | `failed`, `failureStage: processing`, `dataOutcome: not_started`, `recovery: retry_request` | 실행 전 실패이며 저장소·콜백 상태를 확인 |
| 데이터 조회·변경·검증 또는 트랜잭션 처리 | `failed`, `failureStage: data_execution`, `dataOutcome: unknown`, `recovery: inspect_data` | 실제 DB와 트랜잭션 참여 범위를 확인. 자동으로 다시 삭제하지 않음 |
| 실행 성공 후 삭제 증빙 준비 또는 artifact 업로드 | `failed`, `failureStage: artifact_write`, `dataOutcome: completed`, `recovery: retry_artifact` | 원래 실행의 payload를 확보해 수동 복구를 검토. 증빙 재생성을 위해 삭제 전체를 재호출하지 않음 |
| 실행 결과 또는 완료 상태 저장 | 저장 가능한 경우 `failed`, `failureStage: completion_persistence`, `dataOutcome: completed`, `recovery: reconcile_request` | DB·요청·artifact의 실제 상태를 대조 |
| 완료 outbox 또는 audit 콜백 | `completed` 유지, `notificationFailures`에 채널·이벤트·오류 코드·`retry_notification` 기록 | 실패한 통지의 전달만 복구 대상으로 판단 |

이 값들은 `request.stats.lifecycle` 안에 있다. 실패 상태를 알리는 terminal 콜백도 독립적으로 시도하며 실패하면 `notificationFailures`에 기록한다. `failureReason`과 통지 오류는 패키지의 오류 코드 또는 `dsr_operation_failed`이고, DB/provider의 원문 오류 메시지는 공개 요청에 저장하지 않는다.

`dataOutcome: completed`는 등록된 코어 작업이 성공했다는 뜻이다. 등록하지 않은 저장소의 삭제, 법적 준수, 익명화 충분성, backup의 처리를 보증하지 않는다. `unknown`은 rollback이 안 됐다는 확정도 아니다. 사용자가 제공한 트랜잭션 콜백의 구현과 commit 결과를 코어가 독립적으로 확인할 수 없으므로 실제 데이터 확인이 필요하다는 의미다.

기본 `runInTransaction`은 작업을 그대로 호출한다. 트랜잭션을 제공하려면 모든 executor를 같은 transaction client에 연결하고, 콜백이 DB commit 이후 resolve되도록 해야 한다. 전역 Prisma client로 실행하는 executor를 `$transaction` 바깥에서 그대로 사용하면 원자성이 보장되지 않는다. 요청 상태·outbox·외부 저장소 전체가 하나의 원자적 트랜잭션이라는 보장도 추가되지 않았다.

`recovery`는 복구 방향을 알리는 metadata이며 재시도 API가 아니다. `retry_artifact`도 원래 실행의 payload를 확보하고 보존한 운영 경로가 있어야 가능한 수동 복구 지침이다. 코어는 그 payload의 영구 저장이나 복구 API를 제공하지 않는다. 증빙을 다시 만들기 위해 `erase`를 재호출하면 원래 실행 전후의 증거를 재현할 수 없고 삭제도 다시 실행되므로 그렇게 복구하지 않는다. 이 변경에는 idempotency key, 영구 실행 재개, artifact/통지 자동 재시도 기능이 없다. 기존의 “완료 콜백에서 예외를 던져 전체 삭제를 취소한다”는 구현은 작업 전에 검사하는 호스트 승인/검증 단계로 옮긴다.

요청 최초 저장의 성공 여부를 확인할 수 없거나, 상태·실패 metadata 저장 또는 실행 후 최종 요청 조회가 실패하면 `export`/`erase`는 `DataSubjectPersistenceError`를 던진다. 이 오류는 패키지에서 export하며 `code: 'dsr_request_persistence_failed'`, `requestId`, `tenantId`, `dataOutcome`, `recovery: 'reconcile_request'`를 제공한다. DB/provider의 원문 오류는 포함하지 않는다. `dataOutcome`은 해당 호출에서 확인한 결과이며 저장소에 마지막으로 남은 값과 다를 수 있다.

서비스는 데이터 실행 전에 `dataOutcome: unknown`을 먼저 저장한다. commit 이후 저장소가 계속 중단되면 영구 레코드는 `unknown`인 채 남아도 호출에서 받은 `DataSubjectPersistenceError.dataOutcome`은 `completed`일 수 있다. 최초 저장 실패 시에는 데이터 실행 전이므로 오류의 outcome은 `not_started`지만 요청 레코드의 존재 여부는 별도로 확인해야 한다. 저장소가 복구된 뒤 `service.getRequest(error.requestId, error.tenantId)`와 실제 DB·artifact·운영 기록을 대조하고, 그 전에는 새 삭제 요청을 자동으로 만들지 않는다. HTTP 경계에서는 원문 오류를 전달하지 말고 인증된 요청자에게 필요한 오류 코드와 요청 ID만 응답하도록 호스트의 예외 처리를 연결한다.

## 6. 애플리케이션의 회귀 테스트를 갱신한다

동일 subject ID를 가진 두 tenant로 행·요청·artifact 접근을 확인하고, 같은 tenant 안의 다른 subject 접근도 거절되는지 확인한다. ZIP의 정상 필드뿐 아니라 password hash·token·새로 추가한 미지정 컬럼이 없는지도 검사한다. 생성 이벤트 실패, DB 실행 실패, 업로드 실패, 완료 콜백 실패를 각각 주입해 위 상태 의미를 검증한다. DB rollback은 실제 transaction client에 연결한 executor와 PostgreSQL로 확인한다. 지원 조합과 tarball 검증 방법은 [호환성 문서](./compatibility.md)를 따른다.
