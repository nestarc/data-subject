# @nestarc/data-subject — PRD

## 1. 문제 정의

B2B SaaS가 엔터프라이즈 계약 실사에서 막히는 항목 TOP 3 안에 **GDPR/CCPA 대응**이 포함된다. 대부분의 팀은 요청이 들어온 후 엔지니어가 수작업 SQL을 돌린다. 그 결과:

- 여러 테이블 중 한두 개를 빠뜨려 "완전 삭제" 진술이 거짓이 된다
- Stripe·Intercom·분석 툴 등 외부 시스템은 손도 못 댄다
- 세금/회계 기록 같은 법적 보존 의무 테이블을 실수로 지운다
- 감사 로그가 PII를 보관해 "삭제" 약속과 충돌한다
- 30일 deadline 추적이 없다
- DPA 실사 때 증빙을 제출하지 못한다

상용 SaaS(Transcend, DataGrail, Osano)는 월 수천 달러로 초기~중기 SaaS에 과하다. OSS 영역은 abandoned 수준. 공백이 크다.

### 흔한 오해들 (이 패키지가 피해야 할 함정)

- **"Hashing PII satisfies erasure"** — 틀림. Pseudonymized data는 GDPR상 여전히 개인정보.
- **"Anonymization과 pseudonymization은 같다"** — 틀림. 재식별 불가능해야 진짜 익명화.
- **"Soft delete가 GDPR을 만족한다"** — 틀림. `deletedAt`만 찍는 건 어떤 법적 기준도 만족하지 않는다.

## 2. 해결 방향

**정책 엔진 + 요청 라이프사이클 + 외부 fan-out**을 Prisma 기반으로 패키징한다. 기존 nestarc 패키지 네 개가 이 패키지에서 비로소 한 세트가 된다:

- `@nestarc/tenancy` → 요청 격리
- `@nestarc/audit-log` → 요청 이력
- `@nestarc/outbox` → 외부 전파(tombstone event)
- `@nestarc/soft-delete` → anonymization hook

한 줄 포지셔닝: **"DPA-ready GDPR/CCPA toolkit for NestJS + Prisma."**

## 3. 타깃 사용자

- 유럽/미국 고객과 계약 중인 B2B SaaS (DPA 첨부 요구받는 단계)
- Series A~B에서 SOC2·보안 실사를 준비하는 팀
- 이미 `@nestarc/tenancy`를 쓰는 사용자 (가장 자연스러운 upsell)
- 한국·일본 등 현지 개인정보법 대응이 필요한 팀 (data subject는 PIPA·APPI도 공통 용어)

## 4. 성공 기준

- **도입 마찰**: 엔티티 5개 등록 → export/erase API 노출까지 1시간 이내
- **법적 방어**: 모든 요청에 타임스탬프 + 해시 아티팩트 → DPA 실사 시 증빙
- **완전성**: PII 의심 컬럼(email/name/address)에 정책 미지정 시 **빌드타임 경고**
- **외부 fan-out**: Stripe/Intercom/분석 도구 정리가 outbox 리스너 하나로

## 5. 범위

### 포함 (v0.1)
- 엔티티 레지스트리 (데코레이터 + 프로그래밍 API)
- 필드 단위 전략: `delete`(기본), `anonymize`, `retain`
- Export: JSON 묶음 + sha256 증빙
- Erase: 트랜잭션 배치 + 완료 후 검증 스캔
- `DataSubjectRequest` 테이블 (라이프사이클 + 증빙)
- Outbox 이벤트 발행 (PII 없는 tombstone 페이로드)
- 30일 SLA 추적, overdue 조회 API
- 빌드타임 PII 컬럼 린트

### 제외
- 외부 시스템 직접 통합(Stripe/Intercom 커넥터) — consumer가 outbox 리스너로 구현
- 백업·스냅샷 삭제 — 인프라 영역, 문서로만 가이드
- 관리 UI — headless 유지
- Consent 관리, cookie banner — 별도 도메인
- ML 모델에서 개인정보 unlearning — v1.x 이후 검토

## 6. 경쟁/비교

| 항목 | Transcend | DataGrail | 수작업 SQL | `@nestarc/data-subject` |
|---|---|---|---|---|
| 가격 | $$$$ | $$$ | 인력 비용 | OSS |
| 셀프호스트 | ✗ | ✗ | ✓ | ✓ |
| Prisma/NestJS 네이티브 | ✗ | ✗ | 수동 | ✓ |
| 법적 보존 모델링 | ✓ | ✓ | ✗ | ✓ (legalBasis 필수) |
| 외부 fan-out | ✓ | ✓ | ✗ | ✓ (outbox) |
| 증빙 아티팩트 | ✓ | ✓ | ✗ | ✓ (sha256) |
| 빌드타임 완전성 검증 | ✗ | ✗ | ✗ | ✓ |

## 7. 핵심 개념

### 세 가지 전략

| 전략 | 의미 | 사용처 |
|---|---|---|
| `delete` (기본) | 행 또는 PII 필드 물리 삭제 | 대부분의 operational PII |
| `anonymize` | 정적 값(`[REDACTED]`)으로 덮어쓰기. 매핑 저장 금지 → 진짜 익명화 | 행 구조가 분석·통계에 필요할 때 |
| `retain` | 보존. `legalBasis` + 기간 필수 | 세금·회계·분쟁 기록 등 |

### 요청 라이프사이클

```
created ─▶ validating ─▶ processing ─▶ completed
                │             │
                └──▶ failed ◀─┘
```

모든 전환은 `DataSubjectRequest` 테이블에 기록. 완료 시:
- **Export**: ZIP의 sha256, 엔티티 목록, 행 개수
- **Erase**: 삭제·익명화된 행 개수, 보존 행의 legalBasis 목록, 검증 스캔 결과

### 오해 방지 설계

- `retain` 사용 시 `legalBasis` 문자열 필수. 빈 문자열 허용 안 함
- `anonymize` 선언 시 정적 치환값 필수. 동적 생성(`crypto.randomUUID()` 등) 금지
- pseudonymization(해시)는 별도 옵션(`pseudonymize: 'hmac'`)으로만 제공되며, README에 **"이는 erasure를 만족하지 않으며 security measure일 뿐"** 명시

## 8. 다른 nestarc 패키지와의 결합

| 패키지 | 역할 |
|---|---|
| `@nestarc/tenancy` | `subjectId` 조회를 tenant scope 안으로 제한. RLS로 자동 보호 |
| `@nestarc/audit-log` | 요청/처리/완료 이벤트 자동 기록. audit 엔티티 자체도 `retain + legalBasis='accountability'`로 등록 |
| `@nestarc/soft-delete` | `deletedAt`만 찍지 말고 PII 컬럼까지 익명화하도록 hook |
| `@nestarc/outbox` | `data_subject.erasure_requested` tombstone event 발행 (subjectId + tenantId + requestId만) |

## 9. 잠금된 설계 결정 (리서치 검증 완료)

- **기본 erase 전략**: `delete`. `anonymize`는 명시 opt-in.
- **외부 fan-out**: outbox 전용, tombstone event(PII 없는 최소 페이로드). Bull adapter는 v0.2.
- **Audit paradox**: audit log는 `retain + legalBasis='accountability:gdpr-art-5-2'`. 해시 옵션은 defense-in-depth이지 erasure가 아님을 문서화.

리서치 근거는 `docs/compliance.md`(후속 작성)에 소스와 함께 정리.

## 10. 비기능 요건

- **정확성**: 등록된 엔티티는 하나도 빠뜨리지 않고 export/erase 파이프라인을 통과해야 함
- **감사성**: 모든 요청에 immutable audit trail (타임스탬프, 처리자, 아티팩트 해시)
- **성능**: 1000개 엔티티·100만 행 규모 tenant에서 export 10분 이내 (v0.2 목표, v0.1은 기능 우선)
- **확장성**: Prisma 외 ORM 지원은 v1.x. v0.1은 Prisma 전용
- **관찰성**: `request.state_changed`, `request.overdue`, `entity.scan_mismatch` 이벤트 publish

## 11. 로드맵

**v0.1** (MVP, 3~4주)
- 엔티티 레지스트리 + 데코레이터
- Export (JSON zip + sha256)
- Erase (delete 기본, anonymize 옵션, retain+legalBasis)
- `DataSubjectRequest` 테이블 + 라이프사이클
- tenancy/audit-log/outbox 기본 통합
- 완료 후 검증 스캔
- 빌드타임 PII 컬럼 린트

**v0.2**
- Retention DSL (`until: '+7y'`, `until: 'end-of-fiscal-year'`)
- CSV/NDJSON 포맷
- 30일 SLA 스케줄러 + overdue 알림
- Bull adapter
- `soft-delete` 패키지 hook 통합

**v0.3**
- Encrypted export (consumer 공개키)
- Scheduled re-scan (미등록 PII 컬럼 자동 탐지)
- DPA sub-processor 트래킹 테이블
- 다국어 대응(한국 PIPA, 일본 APPI legal basis 템플릿)

## 12. 리스크와 대응

| 리스크 | 대응 |
|---|---|
| consumer가 엔티티 등록을 빠뜨림 | 빌드타임 린트 (PII 의심 컬럼 자동 탐지) + 요청 처리 시 unregistered_entity 경고 |
| 법적 보존 기간 설정 오류 | `legalBasis` 문자열 필수. 런타임 validator로 형식 검증 (e.g. `scheme:jurisdiction-reference`) |
| Erase 도중 실패 → 일부만 삭제 | 트랜잭션 + 배치 단위 idempotency key. resume 지원 |
| 외부 시스템 처리 실패 | outbox 재시도 + dead letter. consumer 책임 경계는 README에 명시 |
| "해시도 삭제"라고 오해한 consumer가 compliance 주장 후 분쟁 | 문서 전면에 **"pseudonymization is not erasure"** 경고. DPA 템플릿 제공 |
| 빌드타임 린트가 false positive 과다 → 사용자가 무시 | `@DataSubjectIgnore` 데코레이터로 명시적 제외 경로 제공 |
