# 비공개 export·삭제 증빙 저장소 예제

`examples/private-artifacts/`는 `ArtifactStorage`를 구현하는 실행 가능한 참조 예제다. export ZIP과 삭제 증빙 JSON을 S3 객체로 저장하고, 별도 보존기간·인증된 다운로드·짧은 서명 링크·만료 및 고아 객체 정리를 연결한다. 코어 패키지에 AWS 의존성을 추가하지 않는다. 예제 파일을 애플리케이션으로 복사할 때 `../../src/...` import를 `@nestarc/data-subject` 공개 export로 변경한다.

`artifactUrl`에 저장하는 `s3://bucket/key`는 저장 위치다. 브라우저에 공개할 다운로드 주소가 아니다. 실제 다운로드는 요청 소유권을 다시 확인한 다음 바이트를 전달하거나 1~300초짜리 링크를 발급한다.

## 저장소 연결

호스트 애플리케이션에 `@aws-sdk/client-s3`와 `@aws-sdk/s3-request-presigner`를 설치한다. 버전과 자격 증명은 호스트가 관리한다. 예제는 기본 credential provider chain을 사용하며 자격 증명을 코드에 저장하지 않는다.

```ts
import * as s3 from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PrivateS3ArtifactStorage } from './private-artifacts/private-s3-storage';
// The .cjs bridge is executable JavaScript; copy it alongside these files.
const { createAwsS3Transport } = require('./private-artifacts/aws-sdk-v3.cjs');

const client = new s3.S3Client({ region: process.env.AWS_REGION });
const artifactStorage = new PrivateS3ArtifactStorage({
  bucket: process.env.PRIVACY_ARTIFACT_BUCKET!,
  prefix: 'privacy-artifacts/',
  transport: createAwsS3Transport({ client, sdk: s3, getSignedUrl }),
  // Illustrative values. Select each period from your actual business policy.
  retentionDays: { export: 7, evidence: 365 },
  createdAt: async ({ tenantId, requestId }) => {
    const request = await requestStorage.findById(requestId, tenantId);
    if (!request) throw new Error('Unknown artifact request');
    return request.createdAt;
  },
});
await artifactStorage.initialize();
// Pass artifactStorage to DataSubjectModule.forRoot / DataSubjectService.
```

보존기간의 기준은 DB에 저장한 불변 `request.createdAt`이다. 파일 업로드 재시도가 만료 시점을 연장하지 않는다. 이미 정리된 파일도 요청 보존기간이 끝난 뒤에는 같은 키로 다시 만들 수 없다. 객체에 저장한 만료 시점은 설정을 바꿔도 자동 변경되지 않으므로, 기존 객체의 보존 정책 변경은 별도 마이그레이션으로 처리한다. 원본 업무 데이터의 보존기간과 이 설정을 연결하지 않는다.

초기화는 bucket-level Block Public Access의 네 설정, `BucketOwnerEnforced`, versioning 미사용을 조회한다. 하나라도 확인하지 못하면 업로드·다운로드·정리를 시작하지 않는다. ACL을 비활성화한 S3 버킷에는 객체 ACL을 보내지 않는 것이 정상이다. 초기화 뒤 설정 변경을 막는 IAM 및 운영 모니터링은 호스트가 관리한다. [AWS Object Ownership](https://docs.aws.amazon.com/AmazonS3/latest/userguide/about-object-ownership.html)

이 예제는 **versioning을 한 번도 활성화하지 않은 일반 버킷**을 지원한다. Enabled와 Suspended 모두 거절한다. versioned bucket의 단순 DeleteObject는 과거 버전을 남길 수 있으므로 이 예제가 영구 삭제를 완료했다고 표시해서는 안 된다. Object Lock, 복제본, 백업, 접근 로그의 보존 정책은 범위 밖이다. [AWS DeleteObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteObject.html)

S3 호환 제품은 명령 이름이 같다는 이유만으로 지원 판정을 내리지 않는다. 특히 bucket inspection, atomic conditional PUT, conditional GET/DELETE, SHA-256 checksum, AES256 서버 암호화 및 presigning 동작을 자체 검증해야 한다. AWS 전용 bucket 설정 API가 없는 제품에는 `S3Transport.inspectBucket()`의 동등한 검증을 구현한다. 무조건 `true`를 반환하는 대체 함수는 사용하지 않는다.

## 인증된 조회와 링크

```ts
import { AuthorizedArtifactDownloads } from './private-artifacts/authorized-downloads';

const downloads = new AuthorizedArtifactDownloads(dataSubjectService, artifactStorage);

// This principal comes from the host's authenticated session, authorization,
// and subject-verification flow. Do not construct it from request.body/query.
const actor = {
  actorId: verifiedPrincipal.actorId,
  tenantId: verifiedPrincipal.tenantId,
  subjectId: verifiedPrincipal.verifiedSubjectId,
  permissions: ['export:download'] as const,
};
const artifact = await downloads.download(requestId, actor); // null when expired
const signedUrl = await downloads.link(requestId, actor, 60); // null when expired
```

`getRequest(requestId, tenantId)` 조회 후 tenant·subject·완료 상태·artifact hash·파일 종류별 권한을 확인한다. 증빙 다운로드에는 별도의 `evidence:download` 권한이 필요하다. 파일 키는 검증한 요청에서 재구성하며 클라이언트가 보낸 키와 저장된 `artifactUrl`을 신뢰하지 않는다. 권한이 없는 요청에는 호스트 라우트에서 일반적인 404 응답을 사용하고 상세 오류나 요청 존재 여부를 노출하지 않는다. HTTP 프록시로 바이트를 전달할 때 `Cache-Control: no-store`, 다운로드 전용 `Content-Disposition`을 설정한다.

서명 링크는 발급 후 소유한 사람이 사용할 수 있는 bearer credential이다. 링크 생성 시 인증을 거쳐도 링크 공유를 막을 수는 없다. 기본 유효시간은 60초이며 객체의 남은 보존기간보다 길게 발급하지 않는다. 서명 시작 시각을 고정해 자격 증명 조회 등 비동기 지연이 만료 시각을 늘리지 않도록 하고, 서명이 끝났을 때 링크가 이미 만료됐다면 반환하지 않는다. 이미 발급된 링크의 즉시 회수·요청마다 다시 인증이 필요하면 링크 대신 `download()`를 통한 서버 전달을 사용한다. IAM session 종료로 링크가 더 일찍 만료될 수도 있다. [AWS presigned URL](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)

## 실패 업로드와 재시도

- 키는 `prefix/data-subject/{encoded tenant}/{encoded request}/export.zip` 또는 `erase-evidence.json`으로 고정한다. 비정규 인코딩·경로 이동·다른 파일 이름을 거절한다.
- `PutObject`는 `IfNoneMatch: '*'`를 사용한다. 같은 키/같은 SHA-256의 재시도는 기존 객체를 사용하며 다른 내용으로 덮어쓰지 않는다. exporter는 재시도 때 원래 payload를 사용해야 한다.
- 업로드 응답을 잃어도 객체가 존재하고 metadata의 SHA-256·생성 시각·content type이 일치하면 성공으로 복구한다. HEAD도 실패하면 오류를 반환하여 다음 시도에서 다시 확인한다. 불확실한 객체를 즉시 지우지 않는다.
- 요청 DB 기록 실패 등으로 연결되지 않은 객체는 아래 정리 작업이 처리한다. 재시도 가능한 failed 요청을 고아로 분류하면 안 된다.

조건부 업로드는 이를 지원하는 저장소의 원자적 동작에 의존한다. 운영 IAM/bucket policy에서 해당 prefix의 무조건 덮어쓰기를 거절한다. [AWS conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)

단일 `PutObject`만 사용하므로 이 예제는 multipart upload를 시작하지 않는다. 호스트가 별도 multipart uploader를 추가하면 incomplete multipart abort lifecycle과 실패 시 abort를 별도로 구현해야 한다. 메모리에 전체 파일을 읽는 `ArtifactStorage` 계약에 따라 기본 64 MiB를 초과하는 파일은 거절한다.

## 만료·고아 객체 정리

```ts
const report = await artifactStorage.cleanup({
  orphanGraceMs: 24 * 60 * 60 * 1000,
  classify: async ({ tenantId, requestId }) => {
    // Read the authoritative DB, including the host's durable abandonment record.
    const status = await lifecycleRepository.lookupForCleanup(tenantId, requestId);
    if (status.kind === 'permanently-abandoned') return 'orphaned';
    if (status.kind === 'completed') return 'referenced';
    if (status.kind === 'running' || status.kind === 'retry-pending') return 'active';
    return 'unknown'; // Missing rows, stale reads, uncertainty: keep the artifact.
  },
});
if (report.failed.length) await operationsLogger.recordArtifactCleanupFailure(report);
```

`lifecycleRepository`와 `operationsLogger`는 호스트 구현 지점이다. 코어의 `failed` 값만으로 영구 포기를 판정할 수 없다. `classify`를 생략하면 보존기간이 끝난 객체만 정리한다. 고아 분류는 최소 5분의 유예를 강제하고 기본 24시간을 사용한다. DB 장애나 불명확한 상태는 보존한다.

정리는 고정 prefix를 페이지 단위로 조회하고 키 형식과 소유 metadata를 다시 검사한다. 만료 객체와 명확히 포기된 객체만 HEAD에서 확인한 ETag를 조건으로 삭제한다. 원본 데이터·다른 prefix·알 수 없는 metadata의 객체는 지우지 않는다. 분류·삭제 오류는 `failed`에 남기며 다음 주기에 재시도한다. 목록 조회 자체가 실패하면 작업을 reject하여 전체 정리 성공으로 오인하지 않게 한다. [AWS conditional deletes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-deletes.html)

이 정리 함수를 정기 실행하는 스케줄러는 호스트가 제공한다. 만료가 되면 get/link는 정리 작업 전에 접근을 막지만, 물리적 삭제는 성공한 정리 작업 시점에 완료된다. 실행 주기를 보존 정책에 맞추고 실패 보고를 관찰한다. 고아 분류와 재시도 승인 사이의 경쟁을 막으려면 호스트에서 영구 포기 상태를 불변으로 유지한다.

## 검증 범위

`npm test -- --runInBand test/integration/private-artifacts.test.ts`는 fake object transport와 SDK command bridge를 검증한다. 별도 보존기간, 같은 키 재시도, 응답 유실, 만료 후 접근/재생성 차단, 페이지별 정리, 삭제/DB 분류 오류 재시도, 다른 namespace 보호, tenant/subject/권한 검사, 무결성 검사, unsafe/versioned bucket 거절을 포함한다.

이 테스트는 실제 AWS 계정의 IAM, 버킷 정책, KMS, S3 호환 제품의 조건부 연산과 물리적 영구 삭제를 증명하지 않는다. 해당 환경을 검증하기 전에는 운영 S3 호환성 완료로 표시하지 않는다.
