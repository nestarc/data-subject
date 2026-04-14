# @nestarc/data-subject — Compliance Guide

> **Not legal advice.** 이 문서는 개발자가 법무/보안 실사에 대응할 때 참고할 수 있는 **엔지니어링 관점의 가이드**다. 실제 DPA 서명·규제 대응은 반드시 자격 있는 변호사/DPO의 검토를 거쳐야 한다.

## 1. 핵심 입장: Pseudonymization is NOT erasure

이 라이브러리는 다음 오해를 **정면으로 거부한다.**

| 오해 | 실제 |
|---|---|
| "userId를 hash하면 삭제한 것이다" | ❌ Pseudonymized data는 GDPR상 여전히 개인정보 (WP29 Opinion 05/2014, Recital 26) |
| "Soft delete(`deletedAt`)는 GDPR 삭제 요구에 부합한다" | ❌ 원본이 복구 가능하면 삭제가 아님 |
| "Anonymization과 pseudonymization은 비슷한 것이다" | ❌ 진짜 익명화는 재식별 불가능해야 하며, 그래야 GDPR scope에서 완전히 벗어남 |

라이브러리가 제공하는 `pseudonymize: 'hmac'` 옵션은 **security measure(defense-in-depth)일 뿐이며, erasure를 만족시키지 않는다.** README와 런타임 경고에 명시되어 있다.

## 2. GDPR 조항 매핑

라이브러리가 어떤 조항의 이행을 돕는지, 또 **돕지 않는 영역**은 무엇인지 투명하게 정리한다.

| 조항 | 요구 사항 | 라이브러리가 하는 것 | 라이브러리가 하지 않는 것 |
|---|---|---|---|
| **Art. 5(1)(e)** Storage Limitation | 필요 이상 보관 금지 | `retain` 정책의 `until` 필드로 기간 모델링 | 자동 삭제 스케줄링 (v0.2) |
| **Art. 5(2)** Accountability | 준수 증빙 | `DataSubjectRequest` 테이블 + artifact hash | DPIA 작성 |
| **Art. 15** Right of Access | 사본 제공 | `export()` → JSON zip + hash | UI, 이메일 전달 |
| **Art. 17** Right to Erasure | 삭제 | `erase()` with `delete`/`anonymize` strategies | 백업·ML 모델 unlearning |
| **Art. 20** Data Portability | 기계 판독 포맷 | JSON export (CSV/NDJSON v0.2) | 직접 타 서비스 이전 |
| **Art. 25** Data Protection by Design | 기본값의 보호 | 기본 전략 `delete`, 엄격 validation | 전체 시스템 설계 |
| **Art. 30** Records of Processing | 처리 기록 | 엔티티 레지스트리가 일부 증거 | 공식 RoPA 문서 |
| **Art. 33** Breach Notification | 72시간 내 신고 | ❌ 해당 없음 | — |

## 3. DPA 실사 Q&A

법무·보안 실사에서 실제로 들어오는 질문과 엔지니어링 관점의 답.

### Q1. 삭제 요청을 받으면 모든 데이터가 지워집니까?

**A.** 아니오, 그리고 그래서는 안 됩니다.

`@nestarc/data-subject`는 엔티티를 세 가지 전략으로 분류합니다:
- `delete`: 물리 삭제
- `anonymize`: 정적 값으로 치환 (분석 목적)
- `retain`: 법적 근거와 함께 보존

예를 들어 인보이스는 세법상 5~7년 보존 의무가 있어 `retain`으로 선언됩니다. 삭제 요청 처리 시 `retain` 대상은 보존되며, **어떤 법적 근거로 보존되는지 `stats.retained[]`에 기록되어 DPA 증빙**이 됩니다.

### Q2. 삭제 후 정말 복구 불가능한가요?

**A.** 라이브러리 범위 내에서는 그렇습니다. 다만 다음은 범위 밖이며 consumer의 책임입니다:
- 데이터베이스 백업/스냅샷
- 애플리케이션 로그 파일
- CDN/캐시 레이어
- 외부 SaaS (Stripe, Intercom, 분석 툴) — outbox 이벤트로 fan-out 가능하나 실제 처리는 consumer 책임

### Q3. 요청 처리를 증빙할 수 있나요?

**A.** 예. 모든 요청은 `DataSubjectRequest` 테이블에 기록되며 다음 증빙을 포함합니다:
- `createdAt`, `completedAt` 타임스탬프
- `artifactHash`: export ZIP 또는 erase report의 sha256
- `stats`: 처리된 엔티티 목록, 행 개수, 보존된 행의 법적 근거
- `audit-log` 연동 시 상태 전환 이력

### Q4. 30일 deadline을 놓치면 어떻게 되나요?

**A.** 라이브러리는 `listOverdue()` API로 초과 요청을 조회할 수 있고, v0.2에서 자동 경고 이벤트를 발행합니다. **알림 전달·담당자 할당은 consumer가 구현**해야 합니다.

### Q5. 감사 로그에 있는 개인정보는 어떻게 처리되나요?

**A.** 감사 로그는 **`retain + legalBasis='accountability:gdpr-art-5-2'`**로 등록되어 보존됩니다. 이는 Article 5(2) accountability 원칙을 이행하기 위한 **합법적 근거 기반 보존**이며, Article 17 erasure의 예외에 해당합니다.

선택적으로 `pseudonymize: 'hmac'` 옵션을 사용해 linkability를 낮출 수 있으나, **이는 추가 보안조치이지 erasure가 아님**을 문서화합니다.

### Q6. 백업에서 어떻게 삭제하나요?

**A.** 라이브러리는 백업을 다루지 않습니다. 일반적 접근:
- 백업에 암호화 키 적용 → 삭제 시 키 폐기 (crypto-shredding)
- 보존기간 짧은 백업 사용 + 만료 후 자동 폐기
- 백업에 대한 retention policy를 DPA에 명시

### Q7. 서드파티 서비스(Stripe 등)의 데이터는?

**A.** Erase 실행 시 outbox에 tombstone 이벤트가 발행됩니다:
```json
{
  "type": "data_subject.erasure_requested",
  "subjectId": "user_123",
  "tenantId": "tenant_1",
  "requestId": "dsr_abc",
  "requestedAt": "2026-04-14T..."
}
```

Consumer는 이 이벤트를 구독해 Stripe Customer API, Intercom delete API 등을 호출하는 handler를 작성합니다. Sub-processor 목록은 consumer의 DPA에 명시되어야 합니다.

## 4. Legal Basis 템플릿

`retain` 전략 사용 시 `legalBasis` 문자열은 **`<scheme>:<jurisdiction>-<reference>`** 형식을 권장한다. 자주 쓰이는 값:

### Accountability & Security
| 문자열 | 근거 |
|---|---|
| `accountability:gdpr-art-5-2` | GDPR Article 5(2) |
| `security:iso-27001-a-12.4` | ISO/IEC 27001 감사 로깅 |
| `security:soc2-cc7.2` | SOC 2 모니터링 통제 |

### 세무/회계
| 문자열 | 근거 | 기본 기간 |
|---|---|---|
| `tax:EU-directive-2006-112` | EU VAT Directive | 10y (국가별 상이) |
| `tax:US-irs-6001` | IRS Rules | 7y |
| `tax:KR-basic-law-§85` | 국세기본법 §85의3 | 5~10y |
| `tax:JP-corporate-tax-law` | 일본 법인세법 | 7y |

### 금융·지불
| 문자열 | 근거 |
|---|---|
| `finance:pci-dss-10.7` | PCI-DSS 로그 보존 (1y) |
| `finance:psd2-art-96` | PSD2 거래 로그 |
| `aml:EU-directive-2015-849` | EU AML 5년 보존 |

### 분쟁·청구
| 문자열 | 근거 |
|---|---|
| `dispute:statute-of-limitations` | 소멸시효 방어 목적 (국가별 상이) |
| `dispute:pending-litigation` | 진행 중인 소송/중재 |

### 동의 기반
| 문자열 | 근거 |
|---|---|
| `consent:explicit-opt-in` | 명시적 동의 (철회 시 삭제 트리거 필요) |
| `legitimate-interest:art-6-1-f` | GDPR Art. 6(1)(f) — DPIA 필요 |

⚠️ **동의 기반 보존은 consumer가 동의 철회 이벤트를 별도로 수신해 `delete` 전략으로 전환해야 한다.** 라이브러리는 동의 관리를 하지 않는다.

## 5. 이 라이브러리가 커버하지 않는 영역

DPA 실사에서 질문받을 수 있으나 **라이브러리 범위 밖**인 것들. 별도 정책이 필요하다.

- **데이터베이스 백업/스냅샷**: 인프라·DBA 영역
- **애플리케이션 로그 파일(`stdout`, Cloudwatch 등)**: 로깅 파이프라인 정책
- **ML 모델 weight**: 훈련 데이터 제거 ≠ 모델에서 제거. Unlearning 연구 영역
- **Consent 수집/철회 UI**: 별도 consent management platform
- **DPIA(Data Protection Impact Assessment)**: 문서 작업
- **Sub-processor 목록 관리**: 계약·운영 영역
- **Breach notification(Art. 33)**: 보안 운영 영역
- **Cross-border transfer(Art. 44~)**: SCC, adequacy decision 등 계약 영역

## 6. Sample DPA 문구

Consumer가 DPA 부속 문서에 사용할 수 있는 샘플 문장. **반드시 법무 검토 후 사용.**

> **데이터 주체 권리 이행(Data Subject Rights Fulfillment).**
> 처리자(Processor)는 `@nestarc/data-subject` 기반의 레지스트리와 라이프사이클 시스템을 통해 GDPR Article 15, 17, 20에 따른 요청을 처리한다. 각 요청은 `DataSubjectRequest` 레코드로 기록되며, 처리 완료 시 sha256 해시로 서명된 아티팩트를 생성한다. 요청 접수일로부터 30일 이내 처리를 목표로 하며, 지연 시 관리자에게 알림이 발송된다.
>
> **보존 의무(Retention Obligations).**
> 세무·회계·분쟁 대응 등 법적 근거를 가진 데이터는 erasure 요청에도 불구하고 해당 근거(`legalBasis`)와 기간에 따라 보존된다. 보존된 행은 각 요청의 `stats.retained[]`에 법적 근거와 함께 기록된다.
>
> **가명처리(Pseudonymization).**
> 당사는 감사 로그 등 계정책임(Article 5(2)) 목적 보존 데이터에 대해 가명처리를 추가 보안조치로 적용할 수 있다. **이는 erasure를 대체하지 않으며**, 가명처리된 데이터는 여전히 개인정보로 취급된다.
>
> **서드파티 처리자에의 전파(Propagation to Sub-processors).**
> Erasure 요청은 transactional outbox 메커니즘을 통해 등록된 sub-processor에게 tombstone event로 전파된다. Sub-processor 목록과 각 sub-processor의 처리 범위는 부속서 A에 명시한다.

## 7. 한국 PIPA 대응 메모

GDPR과 유사하나 세부 차이가 있어 별도 정리:

- **삭제 요청 처리 기한**: 개인정보 보호법 §36(2)에 따라 **10일 이내** (GDPR의 30일보다 짧음)
  - v0.2에서 `slaDays` 옵션으로 지역별 조정 가능
- **법적 근거 문자열**: `pipa:KR-§15`, `pipa:KR-§21(1)` 등
- **정보주체(data subject) 용어 일치**: 패키지 이름 `data-subject`가 한국어 "정보주체"에 직접 대응
- **파기 방법 문서화 의무**: PIPA §21(2). `stats`의 엔티티별 처리 방식이 이 증빙에 활용 가능

## 8. 변경 이력

| 날짜 | 변경 |
|---|---|
| 2026-04-14 | 초안 작성. v0.1 스펙과 일치 |
