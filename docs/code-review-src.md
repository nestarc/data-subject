# src/ 코드 리뷰 및 보완 계획

리뷰 범위: `src/` 전체 (약 1,181 LOC, 테스트 포함)  
리뷰 일자: 2026-04-15  
관련 문서: `docs/spec.md`

---

## 문서 목적

이 문서는 `src/` 코드 리뷰 결과를 단순 메모가 아니라 **수정 착수용 작업 문서**로 정리한 것이다.  
핵심 목표는 다음 세 가지다.

- v0.1 출시 전 반드시 막아야 할 컴플라이언스 결함을 식별한다.
- 각 결함이 어떤 spec 계약을 깨는지 연결한다.
- 수정 방향, 예상 변경 파일, 완료 기준, 테스트 항목을 한 번에 정리한다.

---

## 결론 요약

현재 코드베이스에는 출시 차단 이슈가 2건 있다.

1. `delete`와 `retain`이 같은 row에서 섞일 때, 현재 로직은 row 전체를 삭제할 수 있다.
2. `delete-fields` 경로가 어댑터 계약에 표현되지 않아 Prisma 구현에서 사실상 no-op이다.

두 이슈 모두 "테스트가 일부 통과하더라도 법적 의무를 어길 수 있는" 종류의 결함이다.  
따라서 v0.1에서는 아래 방향을 권장한다.

- `retain`이 하나라도 있으면 row-level delete를 금지하고 field-level update로 강등한다.
- `delete-fields` 의미론은 유지하되, 내부 구현은 "필드 업데이트 계획"을 어댑터에 전달하는 방식으로 재설계한다.
- 이번 라운드의 구현 범위는 최소 `#1`, `#2`, `#3`, `#4`까지 포함한다.
- `#5`, `#6`, Nits는 후속 라운드로 분리하되, 문서에는 리스크와 권고를 남긴다.

---

## 핵심 설계 긴장

이 라이브러리의 본질적인 설계 긴장은 **삭제(delete)와 보존(retain)이 같은 row에서 공존**할 수 있다는 점이다.  
GDPR/개인정보보호법에서 세금 영수증처럼 일부 필드는 법적 보관 의무가 있고, 다른 필드는 즉시 삭제 의무가 있을 수 있다. 이 충돌을 어떻게 해소하느냐가 컴플라이언스 정확도를 결정한다.

Prisma delegate 래핑 패턴(`findMany`/`deleteMany`/`updateMany`만 요구)은 ORM 결합도를 얕게 유지하는 좋은 포트/어댑터 경계다. 다만 현재 인터페이스에는 "필드 수준 삭제"를 안전하게 표현할 정보가 부족하다.

---

## 출시 차단 이슈

### 1. `erase-runner.ts:105-109` — retain 필드가 포함된 row를 통째로 삭제함

```ts
const rowStrategy: Strategy = strategies.has('delete')
  ? 'delete'
  : strategies.has('anonymize') ? 'anonymize' : 'retain';
```

한 엔티티의 fields에 `delete`와 `retain`이 섞여 있으면 `delete`가 승리하고, 그 결과 `executor.erase(...)`가 **전체 row 삭제**로 내려간다. 이렇게 되면 retain 대상 필드까지 함께 삭제된다.

### 왜 위험한가

- 법정보관 의무가 있는 데이터를 디폴트 경로에서 함께 삭제할 수 있다.
- spec 상 `retain`은 삭제 대상이 아니라 건너뛰고 근거를 기록해야 한다.
- 현재 동작은 "row delete보다 field delete가 우선"이어야 하는 도메인 의미와 반대로 움직인다.

### 관련 spec

- `docs/spec.md` §2.1 `delete`
- `docs/spec.md` §2.3 `retain`
- `docs/spec.md` §6 Erase 플로우

### 권장 결정

- `retain`이 하나라도 있으면 row delete를 금지한다.
- mixed strategy row는 `anonymize/update-fields` 경로로 강등한다.
- `delete` 대상 필드는 null 또는 빈값으로 업데이트하고, `retain` 대상 필드는 그대로 둔다.
- 컴파일 단계에서 `delete + retain` 조합을 허용하되, 실행 단계에서 row delete로 내려가지 않게 보장한다.

### 예상 수정 파일

- `src/erase-runner.ts`
- `src/policy-compiler.ts`
- `src/types.ts` 또는 정책/실행 계획 타입 정의 파일

### 완료 기준

- `retain` 필드가 하나라도 있는 엔티티는 row delete를 실행하지 않는다.
- mixed strategy row에서 `delete` 필드만 제거되고 `retain` 필드는 남는다.
- `stats.retained` 또는 동등한 결과 구조에 retain 근거가 남는다.

### 필요한 테스트

- `delete + retain` 혼합 정책에서 retain 필드 보존 검증
- `delete-only` 정책에서만 row delete 또는 field delete가 동작하는지 검증
- `anonymize + retain` 혼합 정책에서 retain 필드 비변경 검증

---

### 2. `prisma/from-prisma.ts:48-52` — `delete-fields` 분기가 사실상 no-op

```ts
const result = await delegate.updateMany({
  where: whereFor(subjectId, tenantId),
  data: {},
});
```

`rowLevel === 'delete-fields'`일 때 어떤 필드를 null 또는 빈값으로 만들어야 하는지 정보가 어댑터로 전달되지 않는다. 현재 `EntityExecutor.erase(subjectId, tenantId, rowLevel)` 시그니처만으로는 구현자가 지울 필드를 알 수 없다. Prisma는 빈 `data`를 받은 `updateMany`에서 실제 데이터를 바꾸지 않는다.

### 왜 위험한가

- spec에서 기본값으로 선언된 `delete-fields`가 실제로는 동작하지 않는다.
- FK 안정성을 위해 row delete를 피하려는 엔티티에서 삭제가 수행되지 않을 수 있다.
- "삭제가 수행되었다"고 집계되더라도 실제 데이터는 남아 있을 수 있다.

### 관련 spec

- `docs/spec.md` §2.1 `delete`
- `docs/spec.md` §6 Erase 플로우
- `docs/spec.md` §7 공개 API 표면

### 권장 결정

공개 의미론은 유지하되, 내부 어댑터 계약을 확장한다.

- `delete-fields`를 유지한다. 이 의미는 spec에 이미 명시되어 있으므로 v0.1에서 폐기하지 않는다.
- 대신 실행기는 어댑터에 `rowLevel`만 넘기지 말고, 실제 업데이트 계획을 함께 넘긴다.
- 예시:
  - `erase(subjectId, tenantId, { rowLevel, deleteFields, replacements })`
  - 또는 `applyPlan(subjectId, tenantId, plan)`
- Prisma 어댑터는 이 계획을 `updateMany({ data })`로 그대로 번역한다.
- 내부 구현에서는 `delete-fields`와 `anonymize`를 같은 update 경로로 처리하되, 도메인 의미는 구분해 유지한다.

### 비권장 대안

- `delete-fields` 자체를 제거하고 spec를 축소하는 선택은 가능하지만, 현재 spec와 어긋나므로 v0.1에서는 권장하지 않는다.

### 예상 수정 파일

- `src/prisma/from-prisma.ts`
- `src/ports/entity-executor.ts` 또는 동등한 인터페이스 파일
- `src/erase-runner.ts`
- 관련 테스트 파일

### 완료 기준

- `delete-fields` 경로에서 실제 변경 대상 필드가 `updateMany.data`에 채워진다.
- nullable / non-nullable 필드에 대한 삭제 대체값 정책이 일관된다.
- 집계 수치와 실제 DB 상태가 일치한다.

### 필요한 테스트

- `delete-fields` 요청 시 지정 필드만 null 또는 빈값 처리되는지 검증
- Prisma 어댑터가 빈 `data`를 만들지 않는지 검증
- row delete가 금지된 엔티티에서 field delete가 정상 동작하는지 통합 검증

---

## 이번 라운드 포함 권장 이슈

### 3. `export-runner.ts:35` — export stats에 `strategy: 'delete'`가 박혀 있음

Export는 삭제가 아니라 데이터 전달이다. export 통계에 `strategy: 'delete'`가 들어가면 감사 로그와 운영 지표 해석이 틀어진다.

권장 조치:

- export 통계에서 `strategy` 필드를 제거하거나 `'export'` 같은 별도 라벨로 바꾼다.
- `docs/spec.md` §5 Export 플로우, §9 Outbox 이벤트와 맞는 용어를 사용한다.

완료 기준:

- export 통계가 erase 의미를 재사용하지 않는다.
- 운영자 입장에서 export/erase 로그가 혼동되지 않는다.

### 4. `data-subject.service.ts` — export/erase outbox 이벤트 비대칭

현재 `erase()`는 `erasure_requested`, `request_completed`, `request_failed`를 발행하지만, `export()`는 생성 시점 `request_created`만 발행한다. 이 상태에서는 다운스트림이 export 완료/실패를 감지할 수 없다.

권장 조치:

- export도 완료 시 `request_completed`, 실패 시 `request_failed`를 발행한다.
- 이벤트 의미는 `request.type`으로 구분하고, 성공/실패 이벤트 이름은 공통으로 유지한다.

관련 spec:

- `docs/spec.md` §4 라이프사이클
- `docs/spec.md` §5 Export 플로우
- `docs/spec.md` §9 Outbox 이벤트 스펙

완료 기준:

- export와 erase 모두 생성/완료/실패의 생애주기 이벤트가 대칭적으로 발행된다.
- 다운스트림이 type 기반으로 후처리할 수 있다.

---

## 후속 라운드 권장 이슈

### 5. `erase-runner.ts:64-71` — 검증 실패 시 DB 롤백 없음

현재는 삭제/익명화 DML 이후 verification scan이 실패해도 이미 변경된 데이터는 되돌릴 수 없다.

권장 조치:

- 최소한 `README` 또는 `LIMITATIONS`에 현재 보장 범위를 명시한다.
- 가능하면 runner에 Unit-of-Work 또는 transaction hook을 주입해 롤백 가능 구조로 확장한다.

### 6. `data-subject.service.ts:108, 178, 185` — 에러 핸들링이 느슨

현재는 비-`Error` 예외, 라이브러리 내부 `new Error(...)`, `failureReason` 누락 가능성이 섞여 있어 호출자가 안정적으로 분기하기 어렵다.

권장 조치:

- 라이브러리 내부 예외를 `DataSubjectError` 계열로 통일한다.
- `unknown` 예외를 문자열화하는 공통 유틸을 둔다.
- `errors.ts`와 API 문서의 기대 상태 코드를 함께 맞춘다.

---

## Spec 정합성 매핑

| 이슈 | 현재 문제 | 깨지는 spec | 필요한 결과 |
|---|---|---|---|
| #1 mixed `delete + retain` | retain 포함 row가 통째로 삭제될 수 있음 | §2.1, §2.3, §6 | retain 우선, row delete 금지 |
| #2 `delete-fields` no-op | 필드 삭제 정보가 어댑터에 전달되지 않음 | §2.1, §6, §7 | 필드 업데이트 계획 전달 |
| #3 export stats label | export 결과가 erase처럼 기록됨 | §5, §9 | export 의미에 맞는 통계 라벨 |
| #4 outbox 비대칭 | export 완료/실패를 감지할 수 없음 | §4, §5, §9 | 공통 생애주기 이벤트 정렬 |
| #5 rollback 부재 | 실패 후 부분 적용 가능 | §4, §6 | 보장 범위 문서화 또는 트랜잭션 훅 |
| #6 에러 타입 불일치 | 호출자 분기 어려움 | §10 | 에러 코드 체계 통일 |

---

## 구현 순서 제안

1. `erase-runner`에서 mixed strategy 분류 로직을 재설계한다.
2. 어댑터 계약을 "rowLevel" 중심에서 "실행 계획" 중심으로 확장한다.
3. Prisma 어댑터가 field delete를 실제 `updateMany.data`로 번역하도록 바꾼다.
4. export 통계 라벨과 outbox 이벤트를 spec에 맞게 정렬한다.
5. 테스트를 보강해 mixed strategy, `delete-fields`, export 완료/실패 이벤트를 먼저 잠근다.
6. 후속 라운드에서 롤백 보장과 에러 타입 통일을 진행한다.

---

## 테스트 계획

### 단위 테스트

- mixed strategy 분류 함수: `delete + retain`이면 row delete 금지
- 정책 컴파일 결과: `rowLevel` 기본값과 필드 업데이트 계획 검증
- 에러 변환 유틸: `unknown` 예외 문자열화 검증

### 통합 테스트

- InMemory Prisma-like 환경에서 `delete-fields`가 실제 필드 값을 변경하는지 검증
- mixed strategy 엔티티에서 retain 필드 보존 + delete 필드 제거 검증
- export 완료/실패 시 request state와 outbox 이벤트가 함께 맞는지 검증

### 계약 테스트

- `EntityExecutor` 구현이 field update plan을 누락 없이 적용하는지 검증
- Prisma adapter가 빈 `data`를 허용하지 않도록 검증

### 회귀 테스트

- `delete-only` 엔티티의 기존 erase 동작 유지
- `anonymize-only` 엔티티의 대체값 적용 유지
- retain 엔티티의 `stats.retained` 기록 유지

---

## 비목표 및 메모

이번 라운드의 비목표:

- ZIP 스트리밍 최적화
- DI 구조 전면 개편
- 상태 전이 가드 전면 도입
- `retain.until` 포맷 파서 추가

다만 위 항목들은 모두 남겨둘 가치가 있는 후속 과제다. 특히 상태 전이 가드, export manifest, public API 과노출 문제는 v0.2 전에 한 번 더 검토하는 것이 좋다.

---

## Nits

- `legal-basis.ts:20` — `value.split(':', 2)` 블록은 regex 검증과 중복되므로 단순화 가능
- `policy-compiler.ts:60` — `(entry as { legalBasis?: string })` 캐스팅 제거 가능
- `policy-compiler.ts` — `retain.until` 포맷 파서/밸리데이션 부재
- `erase-runner.ts:26, 39` — fallback 및 `select` 호출 중복
- `data-subject.service.ts` — 요청마다 runner를 직접 생성, 테스트 주입성 낮음
- `data-subject.service.ts:170` — 상태 전이 가드 없음
- `export-runner.ts` — ZIP 전체를 `nodebuffer`로 메모리에 적재
- export artifact manifest 없음
- `errors.ts` — `InvalidPolicy`의 런타임/프로그래머 에러 경계 문서화 필요
- `index.ts` — `Registry` public 노출 범위 재검토 필요
