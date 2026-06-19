# nestarc/data-subject 0.2.0 기능 제안서

조사일: 2026-06-19  
조사 방식: 로컬 코드베이스 직접 조사 + 외부 제품/규제/커뮤니티 근거 확인 + 7개 서브에이전트 병렬 리서치  
주의: 이 문서는 법률 자문이 아니라 제품/기술 리서치다. 법령 해석, 보존 근거, 신원 확인 수준, 관할권별 SLA는 모두 법무 검토 필요 영역으로 표시한다.

## 1. Executive Summary

- `@nestarc/data-subject`의 한 줄 정의: NestJS/Prisma 애플리케이션에서 data subject export/erase 요청을 정책 기반으로 실행하고, 처리 결과와 증빙 해시를 남기는 headless privacy workflow core.
- nestarc 내 포지션: `tenancy`, `audit-log`, `outbox`, `jobs`, `soft-delete` 위에 올라가는 privacy/compliance orchestration layer. foundation utility보다는 DPA/SOC2/enterprise readiness 단계의 capstone 패키지에 가깝다.
- 핵심 사용자 가치: 개발자가 직접 SQL/runbook으로 처리하던 export/erase를 엔티티 정책, tenant scope, retained legal basis, artifact hash, outbox event로 일관되게 처리한다.
- 가장 중요한 경쟁 구도: OneTrust, Transcend, DataGrail, Osano, Securiti, BigID 같은 상용 privacy operations platform은 request intake, verification, data discovery, dashboard, integrations를 제공한다. `data-subject`는 그보다 작지만 NestJS/Prisma 코드 내부에서 테스트 가능한 실행 코어를 제공할 수 있다.
- 0.1.0 강점: programmatic registry, `delete/anonymize/retain` 정책, legalBasis validation, ZIP export, erase stats, retained/residual stats, storage interfaces, Prisma adapter, NestJS module, outbox/audit hooks.
- 0.1.0 약점: persistent storage adapter 부재, erase report artifact 미저장, subject identity mapping 부재, subject existence/verification 부재, full audit lifecycle 부재, schema lint/registry completeness 검증 부재, async/job workflow 미흡, 문서 일부 stale.
- 0.2.0에서 가장 먼저 추가해야 할 기능 3개:
  1. Production persistence adapters: `PrismaRequestStorage` + durable artifact storage recipe/adapter.
  2. Pre-scan + erasure evidence artifact: erase 전후 집계, retained legalBasis, residual verification, hashable report 저장.
  3. Schema/policy lint + registry validation: Prisma schema와 registry 간 누락 PII 후보, tenantField 누락, policy 누락을 CI에서 검출.

## 2. Current State

### 저장소 구조

- `src/`: 실행 코어, service, registry, policy compiler, storage interfaces, Prisma adapter.
- `test/`: integration/contract tests.
- `docs/`: PRD/spec/compliance/code review notes.
- `prisma/schema.example.prisma`: consumer가 복사할 `DataSubjectRequest` 예시.
- `bench/`: benchmark scaffold.
- `.github/workflows`: CI/release workflow.

### 주요 모듈과 공개 API

`src/index.ts`는 다음을 공개한다.

- `DataSubjectService`, `DataSubjectModule`, `DATA_SUBJECT_REGISTRY`
- `Registry`, `compilePolicy`, `validateLegalBasis`, `fromPrisma`
- `RequestStorage`, `ArtifactStorage`
- `InMemoryRequestStorage`, `InMemoryArtifactStorage`
- public types와 typed errors

핵심 타입은 `src/types.ts`의 `Strategy = delete | anonymize | retain`, `EntityPolicy`, `ErasePlan`, `EntityExecutor`, `RequestType = export | erase`, `RequestState = created | validating | processing | completed | failed`, `DataSubjectRequest`, `RequestStats`다.

### 핵심 기능

- `DataSubjectService.export(subjectId, tenantId)`: request 생성, state `processing`, entity별 `select`, ZIP 생성, `artifactHash`, `artifactUrl`, stats 저장, completed/failed outbox event 발행.
- `DataSubjectService.erase(subjectId, tenantId)`: request 생성, `data_subject.erasure_requested` event, 정책별 erase/anonymize/retain 실행, erase report JSON hash 저장, completed/failed event 발행.
- `Registry`: 중복 entityName 방지, 등록 시 policy compilation.
- `compilePolicy`: shorthand delete normalization, `rowLevel` 기본값 `delete-fields`, dynamic anonymize replacement 거부, retain legalBasis 필수화.
- `fromPrisma`: `findMany`, `deleteMany`, `updateMany`만 요구하는 thin Prisma adapter. `tenantField`가 있으면 `where`에 추가한다.
- storage abstraction: `RequestStorage`와 `ArtifactStorage` 인터페이스는 있지만 기본 구현은 in-memory뿐이다.

### 설정 방식과 확장 포인트

`DataSubjectModule.forRoot(...)`는 `requestStorage`, `artifactStorage`, `slaDays`, `strictLegalBasis`, `entities`, `publishOutbox`, `publishAudit`, `runInTransaction`을 받는다. 확장 포인트는 `EntityExecutor`, storage adapter, outbox/audit hooks, transaction hook이다.

### 테스트 상태

테스트 파일은 policy/compiler, legal basis, registry, errors, Prisma adapter, export/erase runner, data subject service, in-memory storage contract를 다룬다. 특히 mixed `delete + retain`이 field update로 downgrade되는 테스트와 transaction hook 테스트가 있다.

실행 검증은 이 환경에서 완료하지 못했다. `npm test -- --runInBand`와 `npm run build`를 시도했지만 PowerShell PATH에 `npm`이 없었고, `node_modules`도 없어 테스트를 돌릴 수 없었다.

### 문서 상태

README와 실제 코드는 대체로 일치한다. README는 decorators, auto discovery, CLI, persistent request/artifact storage, schema-aware Prisma deletion이 없음을 명시한다. 반면 `docs/prd.md`와 `docs/spec.md`에는 v0.1에 decorators, CLI lint, S3 adapter, registry introspection 등이 포함된 오래된 목표가 남아 있다. 0.2.0 전에 README를 source of truth로 삼거나 docs를 현재 구현 기준으로 정리해야 한다.

### Data Subject 관리 기능 구현 수준

구현됨:

- subjectId + tenantId 기반 execution scope
- request record model
- export/erase request type
- request state 일부
- export artifact hash/url
- erase stats, retained legalBasis, residual verification
- outbox hooks
- audit hook 일부
- storage adapter abstraction

미구현:

- Data Subject 자체 모델 또는 subject identity/alias mapping
- subject existence check
- request verification flow
- access/export/delete 외 rectification/restriction/objection/opt-out request type
- full audit lifecycle
- persistent storage adapter
- schema completeness/lint
- decorator/auto discovery
- async job queue/scheduler
- connector receipt
- retention scheduler, erasure/anonymization verification beyond row residual

### 개인정보 처리 관점의 강점

- `retain`은 legalBasis를 요구해 삭제/보존 충돌을 코드상 표현한다.
- dynamic anonymize replacement를 거부해 추적 가능한 pseudonym 형태의 오용을 일부 막는다.
- mixed `delete + retain`은 row 삭제가 아니라 field update로 downgrade되어 보존 필드 손실 위험을 줄인다.
- event payload는 현재 README 기준 subjectId/tenantId/requestId 중심이며 PII를 과하게 싣지 않는 방향이다.
- tenantId가 모든 executor call에 전달된다.

### 개인정보 처리 관점의 약점

- subjectId는 평문 저장이며, request retention policy와 보존 근거는 구현으로 강제되지 않는다. 법무 검토 필요.
- erase report는 hash만 저장되고 artifact storage에 업로드되지 않는다.
- field-level delete는 `null` assignment로 동작하므로 schema nullability나 non-null 대체값을 모른다.
- verification은 `delete-row` 후 residual rows 중심이며, field delete/anonymize가 실제로 PII를 제거했는지는 검증하지 않는다.
- audit hook은 request created 중심이라 complete/fail/status transition audit trail이 부족하다.
- subject verification이 없어 export를 잘못 호출하면 개인정보 과다 제공 위험이 있다.

### 기술적 강점

- 런타임 dependency가 작고 adapter boundary가 얕다.
- NestJS peer dependency 구조와 `forRoot` 설정이 단순하다.
- policy compiler/runner/storage가 분리되어 테스트 가능한 구조다.
- Prisma adapter는 minimal delegate contract로 구현되어 ORM 결합도가 낮다.

### 기술적 약점

- `DataSubjectService`가 runner를 직접 생성해 runner factory/DI 교체성이 낮다.
- `RequestState`에 `validating`이 있지만 실제 전이는 `created -> processing -> completed|failed`에 가깝다.
- persistent adapter가 없어 프로덕션 예제가 약하다.
- CLI/lint가 없고 package manifest의 `lint` script는 ESLint 용도라 product lint와 혼동될 수 있다.
- `ErasePlan`은 schema-aware deletion, non-null fallback, pseudonymization, per-field verification을 표현하기에 좁다.

## 3. Position in Nestarc

### nestarc 생태계 내 역할

`data-subject`는 core model이나 일반 utility가 아니라 privacy/compliance layer다. 특히 tenant isolation, audit, outbox, job execution, soft-delete 정책을 이미 갖춘 SaaS에서 data subject request fulfillment를 실행 가능한 패키지로 묶는 역할이다.

### 다른 nestarc 패키지와의 관계

- `@nestarc/tenancy`: subject lookup과 request execution이 tenant boundary를 넘지 않도록 보장해야 한다.
- `@nestarc/audit-log`: request created/processing/completed/failed lifecycle과 operator/requester history를 append-only로 남기는 자연스러운 통합 대상이다.
- `@nestarc/outbox`: `data_subject.erasure_requested`, `request_completed`, `request_failed`, `request_overdue` 같은 event를 external processor로 fan-out하는 경계다.
- `@nestarc/jobs`: export/erase가 오래 걸릴 때 async worker, retry, SLA scheduler, overdue event를 담당할 수 있다.
- `@nestarc/soft-delete`: operational soft delete와 privacy erasure/anonymization의 차이를 명확히 연결할 수 있다.
- `@nestarc/webhook`: sub-processor 또는 customer endpoint로 request/receipt event를 전달하는 외부 통합 표면이 될 수 있다.

### 계층 분류

- Primary: privacy layer + compliance layer
- Secondary: domain model layer + infrastructure orchestration layer
- Not primary: auth/identity provider, general ORM utility, consent management platform, UI portal

### 전략적 중요도

상용 privacy platform이 제공하는 넓은 운영 기능과 달리, nestarc 생태계에서는 “앱 내부 데이터의 실제 export/erase 실행과 증거 생성”을 맡을 수 있다. 장기적으로는 developer-native DSR engine이 되는 것이 가장 선명하다.

### 0.2.0에서 강화할 생태계 포지션

0.2.0은 “실행 코어”에서 “운영 도입 가능한 최소 신뢰층”으로 이동해야 한다. 즉 persistent storage, evidence artifact, registry lint, audit event stream, outbox event schema를 공식화하는 것이 생태계 관점의 핵심이다.

## 4. Privacy & Compliance Context

### 핵심 도메인 개념

- Data Subject: 개인정보와 연결되는 주체. 앱 계정과 항상 1:1이 아니다.
- Subject Identifier: `userId`, `customerId`, `email`, `phone`, `auth.sub`, device id, payment customer id 등 subject를 찾기 위한 식별자.
- Canonical Subject ID: 패키지가 실행 범위로 사용하는 기준 ID.
- Request: data subject right를 행사하는 단위.
- Verification: 요청자가 해당 subject인지 확인하는 과정.
- Execution Policy: entity/field별 `delete`, `anonymize`, `retain`.
- Evidence: request record, artifact hash, stats, audit event, connector receipt.
- Retention Legal Basis: 삭제 요청에도 보존하는 데이터의 근거. 법무 검토 필요.

### 일반적으로 필요한 요청 유형

GDPR은 access, rectification, erasure, restriction, portability, objection 등 data subject rights를 다룬다. GDPR Art. 15는 access와 처리 정보 제공 및 copy 제공을 요구하고, Art. 17은 erasure와 예외, Art. 20은 structured/commonly used/machine-readable portability를 다룬다. CCPA/CPRA는 know/delete/opt-out/correct/limit sensitive information 같은 권리를 제시한다. 출처: [GDPR Art. 15](https://gdpr-info.eu/art-15-gdpr/), [GDPR Art. 17](https://gdpr-info.eu/art-17-gdpr/), [GDPR Art. 20](https://gdpr-info.eu/art-20-gdpr/), [California DOJ CCPA FAQ](https://oag.ca.gov/privacy/ccpa).

### 데이터 주체 식별과 계정 식별의 차이

계정 삭제는 identity provider의 `deleteUser` 호출로 끝날 수 있지만, data subject request는 앱 DB, 결제 고객, CRM lead, analytics id, support ticket, audit log, external processors까지 연결된다. Firebase와 Supabase도 user management/delete API를 제공하지만 이는 auth/user store 중심이다. 출처: [Firebase Admin manage users](https://firebase.google.com/docs/auth/admin/manage-users), [Supabase users](https://supabase.com/docs/guides/auth/users), [Supabase deleteUser](https://supabase.com/docs/reference/javascript/auth-admin-deleteuser).

### 요청 상태 관리의 필요성

요청은 접수, 검증, 처리, 완료/거절/실패, SLA 초과 가능성을 가진다. 현재 `RequestState`에는 `validating`이 있지만 실제 전이는 단순하다. 0.2.0은 full async workflow까지 욕심내기보다 status transition guard와 audit event stream을 먼저 잡는 것이 좋다.

### 감사 로그와 처리 이력의 필요성

요청 처리에서는 “삭제했다”는 결과보다 누가, 언제, 어떤 범위에서, 어떤 근거로 삭제/보존했는지 증명하는 것이 중요하다. GDPR Recital 64는 access request 맥락에서 reasonable identity verification을 언급한다. 출처: [GDPR Recital 64](https://gdpr-info.eu/recitals/no-64/).

### 삭제, 익명화, export, 정정 요청과의 관계

- 삭제: row delete 또는 field delete.
- 익명화: 재식별 불가능성을 목표로 하는 static replacement. 충분성은 법무/보안 검토 필요.
- 가명처리: erasure가 아니라 보안 조치로 취급해야 한다.
- export: JSON ZIP은 현재 구현. portability 관점에서는 CSV/NDJSON과 manifest가 유용하다.
- 정정/제한/opt-out: 0.2.0에서는 request type/event/audit abstraction까지가 현실적이며 실제 execution은 후속 버전이 적절하다.

### 법무 검토가 필요한 영역

- 관할권별 request type, SLA, 연장 조건
- request verification 수준
- retain legalBasis와 보존 기간
- request record와 subjectId 평문 저장 근거
- erase report/audit log retention
- anonymization/de-identification 충분성
- sub-processor notification/receipt 내용
- backup/search/ML/index deletion responsibility boundary

### 0.2.0에서 기술적으로 제공 가능한 최소 범위

- persistent request/artifact storage
- erase evidence artifact
- registry completeness lint
- audit event stream
- typed outbox event schema
- subject identity resolver interface, 단 구현은 minimal/opt-in
- overdue query/event hook
- docs에 legal boundary와 consumer responsibility 명시

## 5. User Pain & Value

### 주요 페르소나

1. 초기 B2B SaaS 백엔드 리드: DPA/security questionnaire에서 export/delete 가능성을 증명해야 한다.
2. 멀티테넌트 플랫폼 엔지니어: user data가 여러 tenant/entity/external system에 흩어져 있고 tenant boundary를 보장해야 한다.
3. 보안/컴플라이언스 담당을 겸하는 개발자: DPO나 고가 privacy platform 없이 증빙 가능한 처리 흐름이 필요하다.
4. account deletion/export API 담당자: self-serve delete/export를 만들되 billing/audit/legal retention을 깨뜨리면 안 된다.

### 해결하는 사용자 문제

- 어떤 테이블과 필드가 subject와 관련 있는지 누락하기 쉽다.
- soft delete만으로는 PII가 남는다.
- hard delete는 FK, billing, audit, tax records를 깨뜨릴 수 있다.
- request 처리 결과와 증거를 남기기 어렵다.
- 외부 processor fan-out이 누락되기 쉽다.
- 여러 ID가 한 사람을 가리키는 상황을 관리하기 어렵다.

### 기존 방식의 한계

- 수동 SQL/runbook: 빠르지만 누락과 증빙 부재.
- 일반 job queue/outbox: 재시도는 가능하지만 privacy semantics는 직접 구현해야 한다.
- auth provider delete: account store 중심이며 앱 데이터/외부 데이터까지 커버하지 않는다.
- 상용 privacy platform: 기능은 넓지만 비용, 도입 범위, 코드 내부 정책 표현, 테스트 가능성이 부담.

### `data-subject`가 제공하는 가치

- entity policy를 코드로 선언한다.
- export/erase execution을 같은 registry에서 처리한다.
- retained legalBasis와 residual stats를 남긴다.
- artifact hash로 증빙 가능성을 제공한다.
- NestJS/Prisma 친화적인 채택 경로를 제공한다.

### 아직 충분히 해결하지 못한 사용자 불편함

- 프로덕션 저장소가 없다.
- erase evidence artifact가 없다.
- schema completeness를 검증하지 못한다.
- subject identity alias mapping이 없다.
- full audit trail이 없다.
- async workflow/retry/SLA notification이 없다.

### 0.2.0에서 먼저 개선해야 할 사용자 경험

`DataSubjectModule.forRoot(...)`에 in-memory가 아닌 persistent adapter를 연결하고, `data-subject lint`로 누락 정책을 잡으며, erase 완료 시 hashable evidence artifact를 얻는 경험이 가장 큰 activation point다.

## 6. Competitor & Community Signals

### Competitor Landscape

| 경쟁 패키지/대체 방식 | 주요 기능 | 지원 환경 | 강점 | 약점 | `data-subject`와의 차이 | 차별화 기회 | 근거 |
|---|---|---|---|---|---|---|---|
| OneTrust Privacy Automation | DSR fulfillment, data retrieval/deletion, secure communication, data map | 상용 SaaS platform | privacy operations 전체 | 비용/도입 부담, 앱 코드 내부 정책은 별도 | 운영 플랫폼 vs code-native execution core | NestJS/Prisma 내부 실행과 CI 검증 | [OneTrust Privacy Automation](https://www.onetrust.com/solutions/privacy-automation/) |
| Transcend DSR Automation | access/deletion/opt-out workflow, data systems/datasets across stack, security gateway | 상용 SaaS + gateway | 자동화와 보안 아키텍처 | 엔터프라이즈 도입 모델 | data-use platform vs package | lightweight self-hosted adapters, typed outbox | [Transcend DSR Automation](https://transcend.io/platform/dsr-automation) |
| DataGrail Request Manager | request forms, identity verification, access/deletion/opt-out orchestration, dashboard | 상용 SaaS | privacy team workflow | code-level policy/testability 약함 | dashboard/workflow vs headless core | evidence artifact + schema lint | [DataGrail Request Manager](https://www.datagrail.io/platform/request-manager/) |
| Osano Subject Rights Management | DSAR workflow, summaries/deletions automation, data mapping | 상용 SaaS | all-in-one privacy platform | 내부 DB 실행 세부 제어는 연결 품질 의존 | platform vs library | developer-owned execution | [Osano homepage](https://www.osano.com/) |
| Securiti PrivacyOps | DSR lifecycle, data mapping, consent, privacy center | 상용 SaaS | broad PrivacyOps | 무겁고 platform 중심 | enterprise PrivacyOps vs focused NestJS package | minimal identity resolver | [Securiti homepage](https://securiti.ai/) |
| BigID | data rights automation, deletion, retention, discovery/classification | 상용 enterprise DSPM | data discovery/classification 강함 | 도입 복잡 | DSPM vs app-local execution | Prisma schema lint as small discovery | [BigID homepage](https://bigid.com/) |
| Firebase/Supabase/Auth provider delete | user lookup/delete | Firebase/Supabase/Auth0/Clerk 등 | identity store 삭제는 쉬움 | 앱 DB/외부 processor는 별도 | 계정 삭제 vs data subject workflow | identity alias resolver와 connector receipt | [Firebase](https://firebase.google.com/docs/auth/admin/manage-users), [Supabase](https://supabase.com/docs/reference/javascript/auth-admin-deleteuser) |
| 직접 구현(SQL + queue + outbox) | 앱 맞춤 삭제/export | 모든 환경 | 완전 제어 | 누락/증빙/검증/보존 정책이 약함 | bespoke code vs reusable policy engine | policy compiler + lint + evidence | 코드/커뮤니티 분석 |

### Community Demand

| 사용자 문제 | 발견 위치 | 요약 | 수요 강도 | 신뢰도 | 0.2.0 반영 가능성 |
|---|---|---|---|---|---|
| export 대상 데이터가 여러 entity에 흩어짐 | GDPR Art. 15/20, GitHub issue/search 신호, DSAR 연구 | 단순 user row export로는 부족 | High | Medium | manifest + CSV/NDJSON 후보 |
| erasure가 FK/보존/audit과 충돌 | Stack Overflow, GitHub issue, RTBF 연구 | hard delete/anonymize/retain 구분 필요 | High | High | pre-scan + evidence artifact + retain report |
| subject identifier mapping이 어렵다 | Firebase path/UID deletion pattern, OIDC/Firebase/Supabase docs, community issues | UID/email/customerId/external IDs가 분산 | High | Medium | P1 minimal identity alias resolver |
| SLA/status/audit가 없다 | GDPR/CCPA/CPRA context, GitHub workflow signals | 처리 기한과 상태 추적 필요 | High | High | P1 async lifecycle + audit event |
| 외부 processor fan-out이 누락됨 | 상용 platform product pages, community issues | Stripe/analytics/support/CDP 처리 결과 추적 필요 | Medium-High | Medium | P2 connector receipt + typed outbox |
| tenant boundary 누락 위험 | Supabase RLS docs, multi-tenant privacy issues | cross-tenant export/delete는 치명적 | Medium-High | Medium | registry validation + tenant tests |

추가 신호:

- 2025 DSAR 연구는 주요 온라인 서비스의 DSAR 응답 품질이 일관되지 않고 완전 충족이 어렵다고 보고한다. 출처: [Qualitative In-Depth Analysis of GDPR DSAR Responses](https://arxiv.org/abs/2503.04259).
- 2026 RTBF 연구는 구현상 anti-pattern과 violation risk를 다룬다. 출처: [Faults and Pitfalls in Implementing the Right to be Forgotten](https://arxiv.org/abs/2605.27171).
- CCPA/CPRA 맥락에서는 delete/correct/opt-out/limit sensitive information 같은 권리가 제품 요구로 나타난다. 출처: [California DOJ CCPA FAQ](https://oag.ca.gov/privacy/ccpa).

### 차별화 포지션

`data-subject`는 “privacy operations dashboard”가 아니라 “developer-native, testable DSR execution core”로 차별화해야 한다. 상용 플랫폼이 잘하는 request intake, verification UI, dashboard, broad integrations를 0.2.0에서 따라가지 말고, 코드 내부 policy completeness, evidence artifact, tenant-safe execution, outbox-ready events를 강화해야 한다.

## 7. Feature Opportunities

| 기회 | 요약 | 해결 문제 | 근거 | 0.2.0 가능성 | 효과 | 개인정보/보안 주의점 | 법무 검토 |
|---|---|---|---|---|---|---|---|
| 기능적 기회 | erase pre-scan/post-scan과 report 저장 | 삭제 증빙 부족 | current code, community | High | DPA/SOC2 대응력 상승 | row sample 포함 금지 | 필요 |
| 컴플라이언스 개선 | legalBasis/retention report 강화 | retain 이유 설명 부족 | GDPR Art.17 exceptions context | Medium | 보존 예외 투명성 | 법적 근거 단정 금지 | 필요 |
| DX 개선 | PrismaRequestStorage, S3/R2 artifact adapter | 운영 도입 불가 | current in-memory only | High | 프로덕션 신뢰도 | subjectId/stats 보존 기간 | 필요 |
| 문서 개선 | README/spec/PRD 정합성 정리 | stale docs 혼란 | local docs mismatch | High | adoption 혼란 감소 | 법률 문구 주의 | 일부 |
| 테스트/안정성 | storage contract 확대, tenant leakage fixture | adapter 신뢰도 | current contract tests | High | 회귀 방지 | test fixture PII 최소화 | 낮음 |
| NestJS 통합 | audit/outbox typed hook, optional job adapter | ecosystem 연결 | nestarc docs/PRD | Medium | 생태계 결합 강화 | event payload PII 금지 | 필요 |
| DB/Repository | Prisma request storage, schema lint | 누락/영속성 | current structure | High | CI 가치 상승 | schema scan false positives | 낮음 |
| Subject identifier mapping | minimal alias resolver interface | 여러 ID 분산 | community, auth docs | Medium | 삭제/export 완전성 | raw email/phone 저장 지양 | 필요 |
| Privacy request workflow | request lifecycle contract | long-running request | GDPR/CCPA context | Medium | 운영성 상승 | status misrepresentation 방지 | 일부 |
| Audit trail | full status transition audit | created-only audit | current code | High | accountability 강화 | failureReason sanitization | 필요 |
| Retention/erasure/anonymization | `retain.until` validation, report | 보존 기한 불명확 | docs roadmap | Medium | 보존 정책 투명화 | legal basis templates 주의 | 필요 |
| Multi-tenant boundary | tenantField validation/test helper | cross-tenant leakage | code/community | High | 보안 기본값 강화 | tenant ID 노출 최소화 | 낮음 |
| Event-driven | typed outbox event schema | external fan-out 불명확 | product/competitor | Medium | connector 생태계 준비 | subjectId 외 PII 금지 | 필요 |
| 운영 편의성 | overdue event/query 강화 | SLA 놓침 | current listOverdue | Medium | 운영 감시 | SLA 법률 문구 검토 | 필요 |
| 경쟁 차별화 | schema lint + code-level evidence | 상용 플랫폼 대비 작은 차별점 | competitor analysis | High | developer-native positioning | 과도한 compliance claim 금지 | 필요 |
| nestarc 확장 | tenancy/audit/outbox/jobs integration recipe | 생태계 내 접착 | nestarc docs | Medium | adoption path 강화 | 책임 경계 명시 | 일부 |

## 8. Recommended 0.2.0 Features

| 우선순위 | 기능명 | 기능 요약 | 사용자 문제 | 기대 효과 | 구현 난이도 | 제품 임팩트 | 개인정보/컴플라이언스 임팩트 | 근거 | 성공 지표 |
|---|---|---|---|---|---|---|---|---|---|
| P0 | Production Persistence Adapters | `PrismaRequestStorage` + durable artifact adapter/recipe | in-memory로는 운영/감사 불가 | 운영 도입 가능 | Medium | High | High | storage interfaces, community, roadmap | adapter contract 100% 통과, restart 후 request 조회 가능 |
| P0 | Pre-scan + Erasure Evidence Artifact | erase 전후 count, retained, residual, hashable report 저장 | 삭제 증빙 부족 | DPA/SOC2 답변 가능 | Medium | High | High | current erase hash-only gap | 완료 erase 100% artifact hash/url 보유 |
| P0 | Schema/Policy Lint + Registry Validation | Prisma schema PII 후보와 registry/policy/tenant 누락 검출 | 누락 entity/field 위험 | completeness 차별화 | Medium-High | High | High | docs roadmap, competitor gap | CI non-zero exit, suppression reason 지원 |
| P1 | Complete Audit Event Stream | 모든 state transition audit/outbox schema 정렬 | 감사 추적 부족 | accountability 강화 | Low-Medium | Medium | High | current created-only audit | created/processing/completed/failed audit 100% |
| P1 | Async Request Lifecycle Contract | create/process 분리, retry/idempotency/overdue hooks | long-running DSR 운영 어려움 | 운영성 상승 | High | High | Medium | GDPR/CCPA SLA context | request create p95 < 100ms, retry 가능 |
| P1 | Minimal Identity Alias Resolver | subjectId와 auth/customer/emailHash/external IDs 매핑 interface | 단일 subjectId 한계 | export/erase 완전성 증가 | High | High | High | community, Firebase/Supabase docs | cross-tenant alias leakage 0 |
| P2 | Decorator-based Registration | NestJS decorator/ignore metadata | programmatic registry 반복 | DX 개선 | Medium | Medium | Medium | docs/spec old goal | 5개 entity 등록 10분 내 예제 |
| P2 | Connector Receipt Abstraction | 외부 processor 처리 결과 receipt attach | fan-out 증빙 부족 | connector 없이 증빙 가능 | Medium | Medium | Medium-High | competitor/community | receipt dedupe/hash/status 테스트 |
| P2 | CSV/NDJSON Export + Manifest | ZIP 내부 manifest와 optional formats | JSON만으로 portability 설명 약함 | export 품질 개선 | Medium | Medium | Medium | GDPR Art.20, community | manifest schema snapshot, large export memory guard |
| P2 | Documentation Source-of-Truth Cleanup | README/spec/PRD current scope 정렬 | 문서 혼란 | adoption 신뢰도 | Low | Medium | Medium | local docs mismatch | stale v0.1 claims 제거 |
| P3 | Admin/End-user Portal | request UI/portal | 운영 UI 없음 | 사용성 가능 | High | Medium | Medium | competitor has UI | 0.3+ API 안정 후 검토 |
| P3 | Full SaaS Connectors | Stripe/Intercom/Segment 직접 connector | external fan-out | 확장성 | High | Medium | High | competitor/community | receipt abstraction adoption 후 |
| P3 | Backup/Search/ML Unlearning Automation | backups/index/ML deletion 자동화 | 범위 밖 삭제 | 고급 대응 | Very High | Low-Medium | High | RTBF research | 별도 패키지/문서로 분리 |

### Production Persistence Adapters

- 우선순위: P0
- 기능 요약: `RequestStorage`용 `PrismaRequestStorage`와 durable artifact storage adapter 또는 S3/R2/GCS recipe를 제공한다.
- 해결하는 사용자 문제: in-memory storage만으로는 재시작, 감사, SLA 추적, production adoption이 불가능하다.
- 왜 0.2.0에서 필요한가: 0.2.0을 운영 도입 가능 릴리스로 만들 핵심이다.
- 예상 사용자 가치: README 예제를 production path로 전환할 수 있다.
- 구현 난이도: Medium
- 제품 임팩트: High
- 개인정보/컴플라이언스 임팩트: High
- 기술 리스크: Prisma schema drift, JSON stats serialization, artifact key management.
- 개인정보/보안 리스크: request record에 subjectId/stats/artifactUrl이 남는다. 보존 기간과 access control 필요.
- 법무 검토 필요 여부: 필요.
- 경쟁 대비 차별화 효과: 상용 platform이 아닌 code-native persistent evidence path.
- 관련 코드 위치: `src/storage/request-storage.interface.ts`, `src/storage/artifact-storage.interface.ts`, `prisma/schema.example.prisma`, `src/data-subject.module.ts`
- 필요한 테스트: storage contract, restart simulation, tenant/state/dueAt index query, artifact hash consistency.
- 성공 지표: adapter contract 100% 통과, `listOverdue` production adapter 동작, request/artifact 유실 0.
- 근거:
  - 코드 근거: 기본 adapter는 in-memory뿐.
  - 사용자 문제 근거: 운영/감사 증거 필요.
  - 개인정보 요구사항 근거: request history와 evidence retention 필요.
  - 경쟁 분석 근거: 상용 플랫폼은 persistent workflow/dashboard를 기본 제공.
  - 커뮤니티 수요 근거: SLA/status/evidence 반복 수요.

### Pre-scan + Erasure Evidence Artifact

- 우선순위: P0
- 기능 요약: erase 전 영향 범위 pre-scan, 실행 후 stats, retained fields, residual verification, outbox summary를 JSON report로 만들어 `ArtifactStorage`에 저장한다.
- 해결하는 사용자 문제: erase는 현재 hash만 남고 실제 report artifact가 없다.
- 왜 0.2.0에서 필요한가: DPA/SOC2에서 “무엇을 삭제/보존했는가”에 답하는 직접 증거다.
- 예상 사용자 가치: 처리 증빙을 다운로드/보관/감사할 수 있다.
- 구현 난이도: Medium
- 제품 임팩트: High
- 개인정보/컴플라이언스 임팩트: High
- 기술 리스크: report schema 안정성, PII 포함 방지, runner stats 확장.
- 개인정보/보안 리스크: report에 row sample이나 원문 PII를 넣으면 안 된다.
- 법무 검토 필요 여부: 필요. report 문구와 retained legalBasis 표현 검토.
- 경쟁 대비 차별화 효과: 상용 플랫폼의 dashboard evidence를 code artifact로 축소 제공.
- 관련 코드 위치: `src/erase-runner.ts`, `src/data-subject.service.ts`, `src/types.ts`, `src/storage/artifact-storage.interface.ts`
- 필요한 테스트: pre/post count, hash match, report PII snapshot, residual failure, retained legalBasis.
- 성공 지표: completed erase request 100%가 evidence artifact key/hash를 보유.

### Schema/Policy Lint + Registry Validation

- 우선순위: P0
- 기능 요약: Prisma schema를 읽어 PII 후보 field/model을 찾고 registry policy 누락, `tenantField` 누락, `DataSubjectIgnore`/suppression reason 누락을 경고 또는 실패한다.
- 해결하는 사용자 문제: entity 등록 누락이 가장 큰 삭제/내보내기 완전성 리스크다.
- 왜 0.2.0에서 필요한가: 상용 data discovery를 developer-native CI lint로 작게 대체할 수 있다.
- 예상 사용자 가치: `npx data-subject lint`가 “놓친 PII 후보”를 보여준다.
- 구현 난이도: Medium-High
- 제품 임팩트: High
- 개인정보/컴플라이언스 임팩트: High
- 기술 리스크: false positive/negative, Prisma parser 선택.
- 개인정보/보안 리스크: schema scan 결과에 민감 field명이 포함될 수 있다.
- 법무 검토 필요 여부: 낮음. taxonomy와 문구 정도.
- 경쟁 대비 차별화 효과: codebase CI에 들어가는 privacy completeness check.
- 관련 코드 위치: `src/registry.ts`, `src/policy-compiler.ts`, `src/prisma/from-prisma.ts`, `package.json`
- 필요한 테스트: fixture schemas, suppression reason, non-zero exit, tenantField warning.
- 성공 지표: 100개 model 기준 수초 내 실행, CI-friendly output, 주요 PII naming pattern 탐지.

### Complete Audit Event Stream

- 우선순위: P1
- 기능 요약: request created/validating/processing/completed/failed 모든 transition에서 audit hook과 typed outbox event를 발행한다.
- 해결하는 사용자 문제: 현재 audit은 `request_created` 중심이라 lifecycle 추적이 부족하다.
- 왜 0.2.0에서 필요한가: 개인정보 workflow에서는 accountability가 핵심이다.
- 구현 난이도: Low-Medium
- 제품 임팩트: Medium
- 개인정보/컴플라이언스 임팩트: High
- 기술 리스크: event schema compatibility, failureReason sanitization.
- 개인정보/보안 리스크: audit payload에 subjectId 외 PII 금지.
- 법무 검토 필요 여부: 필요.
- 관련 코드 위치: `src/data-subject.service.ts`
- 필요한 테스트: event order, no PII payload, failed path, transaction hook interaction.
- 성공 지표: 모든 transition 100% audit event 발행.

### Async Request Lifecycle Contract

- 우선순위: P1
- 기능 요약: `createRequest`, `processRequest`, `retry`, `markOverdue` 같은 분리 가능한 lifecycle contract를 제공하고, NestJS jobs/BullMQ는 optional integration으로 둔다.
- 해결하는 사용자 문제: export/erase가 오래 걸릴 때 HTTP request 안에서 실행하기 어렵다.
- 왜 0.2.0에서 필요한가: SLA와 retry를 지원하는 운영 workflow의 기반이다.
- 구현 난이도: High
- 제품 임팩트: High
- 개인정보/컴플라이언스 임팩트: Medium
- 법무 검토 필요 여부: SLA 문구와 상태 의미 일부.
- 관련 코드 위치: `src/data-subject.service.ts`, `src/types.ts`, storage interfaces.
- 필요한 테스트: idempotency, state transition guard, overdue event duplicate prevention.
- 성공 지표: request creation p95 <100ms, retry/resume 가능.

### Minimal Identity Alias Resolver

- 우선순위: P1
- 기능 요약: `SubjectIdentityResolver` interface를 추가해 canonical subjectId와 `authSub`, `customerId`, `emailHash`, `externalIds`를 tenant scope 안에서 해석한다.
- 해결하는 사용자 문제: 단일 subjectId만으로는 여러 시스템에 흩어진 데이터를 찾기 어렵다.
- 왜 0.2.0에서 필요한가: deletion/export completeness의 핵심 구멍이다.
- 구현 난이도: High
- 제품 임팩트: High
- 개인정보/컴플라이언스 임팩트: High
- 기술 리스크: executor contract 확장, multiple identifiers per entity.
- 개인정보/보안 리스크: raw email/phone 저장 지양, alias lookup cross-tenant leakage 방지.
- 법무 검토 필요 여부: 필요.
- 관련 코드 위치: `src/types.ts`, `src/prisma/from-prisma.ts`, `src/data-subject.service.ts`
- 필요한 테스트: alias mapping, missing alias, tenant boundary, hash identifiers.
- 성공 지표: custom executor 없이 다중 subject field를 표현 가능.

### Connector Receipt Abstraction

- 우선순위: P2
- 기능 요약: 외부 processor에서 처리한 deletion/export/opt-out 결과를 request에 receipt로 attach하는 model/API를 제공한다.
- 해결하는 사용자 문제: outbox fan-out 뒤 외부 처리 결과를 증빙으로 연결할 수 없다.
- 왜 0.2.0에서 필요한가: direct connector보다 작고 안전한 중간 단계다.
- 구현 난이도: Medium
- 제품 임팩트: Medium
- 개인정보/컴플라이언스 임팩트: Medium-High
- 법무 검토 필요 여부: 필요.
- 관련 코드 위치: `src/types.ts`, `src/data-subject.service.ts`
- 필요한 테스트: attach/dedupe/failed receipt/hash validation.
- 성공 지표: Stripe/analytics/support 처리 결과를 connector 없이 request stats에 연결.

## 9. Suggested 0.2.0 Scope

### 반드시 포함할 것

- `PrismaRequestStorage`와 durable artifact storage adapter/recipe.
- erase evidence artifact 저장.
- pre-scan/post-scan stats schema.
- registry/schema lint CLI.
- tenantField/tenant boundary validation.
- full audit event stream 또는 최소한 completed/failed audit hook.
- README/spec/PRD 정합성 정리.

### 포함하면 좋은 것

- async lifecycle contract skeleton.
- typed outbox event schema.
- minimal identity resolver interface.
- CSV/NDJSON export option과 manifest.
- connector receipt abstraction.
- decorators/ignore metadata.
- nestarc integration recipe: tenancy + audit-log + outbox + jobs + data-subject.

### 이번 버전에서는 제외할 것

- Admin/end-user portal: UI auth, artifact download auth, tenant isolation, i18n, accessibility까지 범위가 커진다. API 안정화 후 v0.3+ 재검토.
- Stripe/Intercom/Segment 등 full SaaS connectors: vendor별 sandbox, credentials, retry, legal responsibility가 크다. receipt abstraction과 outbox schema를 먼저 축적한 뒤 검토.
- Backup erasure automation: infrastructure/DBA responsibility가 강하고 법무/보안 정책이 필요하다. 0.2.0은 docs와 boundary statement만 제공.
- ML/search/index unlearning automation: RTBF 연구상 중요하지만 패키지 범위를 넘는다. search index hook/docs 정도만 가능.
- Full identity graph: probabilistic matching과 household/authorized agent는 고위험이다. minimal resolver interface까지만.
- Legal basis template catalog의 강제 사용: 법률 해석처럼 보일 수 있다. 예제와 warning만 제공하고 법무 검토 필요로 표시.

## 10. Risks & Open Questions

- 기술적 리스크: `ErasePlan`이 schema-aware deletion에 부족하다. runner factory/DI가 약하다. ZIP export는 메모리에 적재된다.
- 제품적 리스크: 너무 빨리 platform/portal/connector로 확장하면 headless core의 강점이 흐려진다.
- API 안정성 리스크: request type/state를 확장하면 0.1.0 consumer와 호환성 검토가 필요하다.
- 개인정보/보안 리스크: subjectId 평문 저장, artifactUrl 접근제어, failureReason PII leakage, audit payload PII leakage.
- 법무 검토 필요 영역: request retention, legalBasis, verification, jurisdiction SLA, anonymization sufficiency, sub-processor receipt contents.
- 데이터 주체 식별 모델 리스크: account와 subject가 다대다일 수 있다. alias resolver가 raw PII 저장소가 되면 안 된다.
- multi-tenant 리스크: `tenantField` optional이므로 adapter 등록 실수 시 cross-tenant leakage 가능성이 있다.
- subject identifier mapping 리스크: email/name을 stable unique ID로 취급하면 안 된다. hash/normalized alias 정책 필요.
- 요청 상태 관리 리스크: `validating` state가 타입에만 있고 실제 전이가 없으면 운영자가 오해할 수 있다.
- audit/history 리스크: audit log 자체가 retain 대상이므로 보존 근거와 기간이 필요하다.
- retention/erasure/anonymization 리스크: `retain.until`은 현재 validation이 약하고, field-level delete는 nullability를 모른다.
- event-driven 리스크: outbox hook이 transactional guarantee를 자동 제공하지 않는다.
- backward compatibility 리스크: `RequestStats`, `RequestState`, storage schema 확장 시 migration 필요.
- 확인하지 못한 부분: npm publish metadata, nestarc packages의 최신 실제 구현, GitHub community issue count의 noise level.
- 추가 질문:
  - 0.2.0은 breaking changes를 허용하는가?
  - `PrismaRequestStorage`를 core에 포함할지 optional subpath export로 둘지?
  - artifact encryption은 0.2.0 필수인가, recipe인가?
  - legalBasis/retention templates를 어느 수준까지 제공할 것인가?
  - `subjectId` 평문 저장을 유지할 것인가, HMAC option을 request table에도 제공할 것인가?

## 11. Final Recommendation

| 순위 | 기능명 | 추천 이유 | 기대 효과 | 구현 난이도 | 개인정보/컴플라이언스 임팩트 |
|---|---|---|---|---|---|
| 1 | Production Persistence Adapters | in-memory만으로는 운영 도입이 불가능 | 프로덕션 adoption, SLA/audit retention | Medium | High |
| 2 | Pre-scan + Erasure Evidence Artifact | 삭제 증빙과 retained legalBasis 설명이 핵심 가치 | DPA/SOC2 대응력, trust 상승 | Medium | High |
| 3 | Schema/Policy Lint + Registry Validation | 누락 entity/field가 가장 큰 실무 위험 | CI 기반 completeness, 차별화 | Medium-High | High |

0.2.0의 핵심 방향은 “권리 종류를 넓히는 릴리스”가 아니라 “운영 도입 가능한 최소 신뢰층을 만드는 릴리스”여야 한다.

가장 먼저 구현해야 할 기능은 `PrismaRequestStorage`와 erase evidence artifact다. 이 둘이 있어야 request lifecycle과 감사 증거가 실제로 남는다. 그 다음 schema/policy lint를 붙이면 `data-subject`만의 developer-native 차별점이 살아난다.

이번 버전에서 제외해야 할 기능은 admin/end-user portal, full SaaS connectors, backup/ML/search deletion automation, full identity graph다. 필요하지만 0.2.0의 시간과 책임 경계를 넘는다.

장기적으로 이 패키지는 상용 privacy platform의 축소판이 아니라, NestJS/Prisma 생태계에서 “privacy workflow, subject identity mapping, auditability를 코드와 테스트로 보장하는 headless DSR execution infrastructure” 포지션을 가져가야 한다.

## Sources

### Local code and docs

- `package.json`
- `README.md`
- `CHANGELOG.md`
- `src/types.ts`
- `src/data-subject.service.ts`
- `src/erase-runner.ts`
- `src/export-runner.ts`
- `src/prisma/from-prisma.ts`
- `src/storage/request-storage.interface.ts`
- `src/storage/artifact-storage.interface.ts`
- `docs/prd.md`
- `docs/spec.md`
- `docs/compliance.md`
- `prisma/schema.example.prisma`
- `test/integration/data-subject.service.test.ts`
- `test/integration/erase-runner.test.ts`

### External sources

- [GDPR Art. 15 - Right of access](https://gdpr-info.eu/art-15-gdpr/)
- [GDPR Art. 17 - Right to erasure](https://gdpr-info.eu/art-17-gdpr/)
- [GDPR Art. 20 - Data portability](https://gdpr-info.eu/art-20-gdpr/)
- [GDPR Recital 64 - Identity verification](https://gdpr-info.eu/recitals/no-64/)
- [California DOJ CCPA FAQ](https://oag.ca.gov/privacy/ccpa)
- [OneTrust Privacy Automation](https://www.onetrust.com/solutions/privacy-automation/)
- [Transcend DSR Automation](https://transcend.io/platform/dsr-automation)
- [DataGrail Request Manager](https://www.datagrail.io/platform/request-manager/)
- [Osano data privacy platform](https://www.osano.com/)
- [Securiti PrivacyOps platform](https://securiti.ai/)
- [BigID platform](https://bigid.com/)
- [Firebase Admin manage users](https://firebase.google.com/docs/auth/admin/manage-users)
- [Firebase web manage users](https://firebase.google.com/docs/auth/web/manage-users)
- [Supabase users](https://supabase.com/docs/guides/auth/users)
- [Supabase auth admin deleteUser](https://supabase.com/docs/reference/javascript/auth-admin-deleteuser)
- [Qualitative In-Depth Analysis of GDPR DSAR Responses](https://arxiv.org/abs/2503.04259)
- [Faults and Pitfalls in Implementing the Right to be Forgotten](https://arxiv.org/abs/2605.27171)
- [Streamlining personal data access requests](https://arxiv.org/abs/2305.03471)
