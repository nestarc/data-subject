# 인증된 사용자 자신의 요청만 처리하는 NestJS 예제

`privacy.module.ts`는 호스트 앱의 인증·권한·주체 확인 서비스와 실행 코어를 연결하는 예제다. 인증 서버 구현이나 즉시 공개 가능한 서버가 아니다. 저장소 소스 기준의 상대 import는 앱에 복사할 때 `@nestarc/data-subject`로 바꾼다.

`TenantSafePrivacyModule.forRoot(options, hostAccessService)`에 실제 구현을 주입한다. 생략하면 모든 요청을 거절하는 `DenyAllHostAccessService`를 사용한다. 호스트 서비스의 책임은 다음과 같다.

1. `authenticateBearer`: 실제 인증 시스템으로 토큰의 서명/세션·만료·폐기를 확인하고, 현재 유효한 테넌트 소속을 확인한 `actorId`, `tenantId`를 반환한다. 토큰을 단순 decode한 값을 신뢰하지 않는다.
2. `isAllowed`: `export`, `erase`, `read` 각각에 대해 권한을 검사한다. 삭제에 추가 확인이나 승인 절차가 필요하면 이 경계에서 검사한다.
3. `verifyOwnSubject`: 인증된 actor의 주체 ID를 해당 테넌트의 권위 있는 신원 기록에서 확인하고, 유효한 본인 확인의 만료 시각을 반환한다. HTTP body의 `subjectId` 또는 `tenantId`를 전달하지 않는다.

Guard는 모든 경로에서 세 단계를 검사한다. 기본 경로는 `POST /me/privacy/exports`, `POST /me/privacy/erasure`, `GET /me/privacy/requests/:id`, `GET /me/privacy/requests/:id/artifact`다. 요청 body의 ID는 사용하지 않는다. 다른 사용자의 요청 ID를 아는 경우에도 같은 테넌트 내 `subjectId` 일치를 추가로 확인한다. 관리자가 타인을 대신하는 흐름은 별도 권한·주체 확인 절차를 구현해야 한다.

`policy.ts`의 `tenantUserEntity(prisma.user)`는 tenant와 subject를 함께 필터링한다. `passwordHash`, `sessionToken`은 삭제 정책에 있어도 export allowlist에 없으므로 내보내지 않는다. 이 예제에서 `delete`로 지정한 네 컬럼 모두 nullable이어야 필드 삭제가 가능하다. JSON 컬럼을 export에 추가하면 그 내부 내용까지 공개된다는 점을 검토한다.

명시적 single-tenant 앱은 아래 두 설정에 같은 고정 ID를 사용한다. 사용자 입력으로 설치 ID를 선택하지 않는다.

```ts
const singleTenantId = 'my-installation';
TenantSafePrivacyModule.forRoot({
  singleTenantId,
  requestStorage,
  artifactStorage,
  entities: [singleTenantUserEntity(prisma.user, singleTenantId)],
}, hostAccessService);
```

실제 앱에서는 DB를 사용하는 `RequestStorage`와 비공개 `ArtifactStorage`를 주입하고 트랜잭션에 참여하는 executor를 연결한다. 기본 실행은 트랜잭션이 아니다. `runInTransaction`만 감싸고 executor가 전역 Prisma client를 사용하면 rollback을 보장하지 못한다. 실제 PostgreSQL과 npm tarball 검증은 별도 호환성 예제를 참조한다.

응답 DTO는 저장소 내부 `artifactUrl`을 노출하지 않는다. 다운로드는 주체·테넌트 권한 확인 뒤 `getArtifact(id, tenantId)`에서 받은 바이트를 전달하고 `Cache-Control: no-store`를 설정한다. 저장소 URL 자체가 공개되어 있으면 이 컨트롤러의 권한 검사를 우회할 수 있으므로 저장소는 반드시 비공개여야 한다. `listOverdue`는 전체 테넌트를 보는 운영용 API이므로 이 사용자 경로에는 연결하지 않는다.

예제의 테스트는 저장소 루트에서 `npm test -- --runInBand test/integration/host-boundary.test.ts`로 실행한다. 외부 인증 공급자의 토큰 검증 구현은 호스트 앱에서 별도로 검증해야 한다.
