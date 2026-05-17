/**
 * scorer.js
 *
 * 유저 성향 판별 + GPT 가성비 점수 산출 모듈
 *
 * ── 고도화된 성향 판별 알고리즘 ──
 *
 *
 * 행동 신호를 가중치로 합산
 *
 * [브랜드파 신호]
 *   +2  동일 브랜드 반복 클릭 (같은 브랜드 상품 2회 이상)
 *   +2  프리미엄 상품 클릭 (시장 평균가 130% 이상 상품)
 *   +1  시장 평균가 이상 상품 클릭 (보조 신호)
 *
 * [용량파 신호]
 *   +1  대용량 상품 클릭 (다나와 상품 대부분이 대용량이라 가중치 낮춤)
 *   +2  저단가 상품 선택 (시장 평균 단가의 80% 이하)
 *
 * 평점(highRating) 신호는 성향 판별에서 제외:
 *   저단가 + 고평점 상품(자취생 인기템 등)이 흔해, 평점을 브랜드 신호로 쓰면
 *   용량파 유저까지 brandScore가 쌓여 mixed/brand로 오분류됨.
 *   평점은 scoreProductsWithGPT의 입력으로만 활용.
 *
 * Cold Start: totalClicks 3 미만 → "unknown" (가중치 합 아닌 실제 클릭 수 기준)
 *
 * ── GPT 점수 산출 ──
 * 성향별로 다른 평가 기준 프롬프트 + 리뷰 수 + 평점까지 반영
 * GPT 실패 시 로컬 알고리즘으로 자동 폴백
 */

const OpenAI = require("openai");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * 고도화된 유저 성향 판별 함수
 *
 * 각 클릭 이벤트에서 수집한 상품 특성(isPremium, isBulk, rating, pricePerUnit 등)을
 * 가중치 기반으로 합산해 브랜드파/용량파/복합형을 판별합니다.
 *
 * @param {Object} userLog - 클라이언트에서 누적된 행동 로그
 *   @param {string[]} clickedBrands       - 클릭한 브랜드 목록
 *   @param {Object}   brandClickCounts    - { [brand]: clickCount } 브랜드별 클릭 횟수
 *   @param {number}   premiumClicks       - 프리미엄 상품(시장 평균 130% 이상) 클릭 수
 *   @param {number}   avgAboveClicks      - 시장 평균가 이상 상품 클릭 수 (보조 신호)
 *   @param {number}   bulkClicks          - 대용량 상품 클릭 수
 *   @param {number}   lowUnitPriceClicks  - 저단가(평균 80% 이하) 상품 클릭 수
 * @returns {"brand"|"volume"|"mixed"|"unknown"}
 */
function detectPersonaType(userLog) {
  const {
    clickedBrands = [],
    brandClickCounts = {},
    premiumClicks = 0,
    avgAboveClicks = 0,
    bulkClicks = 0,
    lowUnitPriceClicks = 0,
    totalClicks = 0,
  } = userLog;

  // Cold Start: 클릭 횟수 3회 미만이면 무조건 미판별
  // (가중치만 보면 1클릭에 프리미엄+벌크가 겹쳐 즉시 활성화되는 문제 방지)
  if (totalClicks < 3) return "unknown";

  // ── 브랜드파 점수 계산 ──
  // 동일 브랜드 반복 클릭: 같은 브랜드를 2번 이상 클릭했으면 강한 브랜드 선호 신호
  const repeatBrandClicks = Object.values(brandClickCounts).filter((c) => c >= 2).length;
  const brandScore =
    repeatBrandClicks * 2 +  // 브랜드 반복 클릭 (강한 신호)
    premiumClicks * 2 +      // 프리미엄 상품 클릭 (강한 신호)
    avgAboveClicks * 1;      // 평균가 이상 클릭 (보조 신호)
  // 평점(highRating)은 의도적으로 제외 — 저단가 + 고평점 케이스에서 오분류 유발

  // ── 용량파 점수 계산 ──
  // bulkClicks는 다나와 상품 대부분이 대용량이라 가중치 1로 평탄화 (자동 쏠림 방지)
  const volumeScore =
    bulkClicks * 1 +              // 대용량 클릭 (보조 신호)
    lowUnitPriceClicks * 2;       // 저단가 선택 (강한 신호)

  const total = brandScore + volumeScore;
  if (total === 0) return "mixed"; // 신호 없으면 중립으로

  // 브랜드 신호 비율로 성향 결정
  // 0.6 이상: 브랜드 신호가 우세 → 브랜드파
  // 0.4 이하: 브랜드 신호가 미미 → 용량파
  // 그 사이: 둘 다 섞임          → 복합형
  const ratio = brandScore / total;
  if (ratio >= 0.6) return "brand";
  if (ratio <= 0.4) return "volume";
  return "mixed";
}

/**
 * GPT-4o-mini로 가성비 점수를 산출합니다.
 *
 * 성향별 평가 기준:
 * - brand:  현재가 vs 3달 최저가 타이밍 + 브랜드 신뢰도(평점/리뷰수)
 * - volume: 단위당 단가 vs 시장 평균 + 리뷰 신뢰도
 * - mixed:  위 두 기준을 균형 있게 반영
 *
 * @param {Array}  products    - 상품 배열 (priceHistory, marketAvgPricePerUnit 등 포함)
 * @param {Object} userLog     - 유저 행동 로그
 * @param {string} personaType - 판별된 성향 타입
 * @returns {{ products: Array, scoreSource: "gpt"|"local"|"none" }}
 */
async function scoreProductsWithGPT(products, userLog, personaType) {
  // Cold Start인 경우 GPT 점수 산출 없이 null 반환
  if (personaType === "unknown") {
    return {
      products: products.map((p) => ({ ...p, valueScore: null, scoreTooltip: null })),
      scoreSource: "none",
    };
  }

  // ── GPT 입력 데이터 슬림화 ──
  // 원본 상품 객체에는 image, source, id 등 점수 산출과 무관한 필드가 많음
  // → 평가에 필요한 핵심 지표만 추려서 토큰 사용량과 GPT 혼란을 줄임
  // index를 함께 보내는 이유: GPT 응답이 순서를 섞을 수 있으므로 index로 매핑 복원
  const productSummaries = products.map((p, i) => ({
    index: i,                     // GPT 응답 매핑 키 — 0~9
    name: p.name,
    brand: p.brand,
    price: p.price,
    pricePerUnit: p.pricePerUnit, // 단가 (없으면 null → GPT가 단가 비교에서 제외 판단)
    unit: p.volume?.unit,         // "g"|"ml"|"롤" 등 — 툴팁에서 단가 단위 표기 시 사용
    rating: p.rating || 0,        // 다나와 .text__score 에서 수집
    reviews: p.reviews || 0,      // 다나와 .text__review .text__number 에서 수집
    // 3달 최저/최고가를 미리 계산해서 GPT에게 직접 제공
    // → GPT가 priceHistory 배열을 받아 직접 min/max 계산하는 것보다 토큰 절약 + 정확
    minPrice3M: p.priceHistory ? Math.min(...p.priceHistory.map((h) => h.price)) : p.price,
    maxPrice3M: p.priceHistory ? Math.max(...p.priceHistory.map((h) => h.price)) : p.price,
    marketAvgPrice: p.marketAvgPrice,             // 검색 결과 내 평균가
    marketAvgPricePerUnit: p.marketAvgPricePerUnit, // 검색 결과 내 평균 단가
    isPremium: p.isPremium,
    isBulk: p.isBulk,
  }));

  // 성향별 평가 기준 프롬프트 구성
  const personaContext = {
    brand: `유저는 브랜드 가치파입니다.
평가 기준 (중요도 순):
1. 가격 타이밍: 현재가가 3달 최저가에 가까울수록 높은 점수 (핵심)
2. 브랜드 신뢰도: rating(4.7+) 및 reviews(1000+)이 높을수록 가점
3. 프리미엄 여부: isPremium=true이거나 시장 평균가 이상 상품은 타이밍이 좋으면 더 높은 점수 가능
선호 브랜드: ${userLog.clickedBrands?.join(", ") || "미확인"}`,

    volume: `유저는 실속 용량파입니다.
평가 기준 (중요도 순):
1. 단위당 단가: 시장 평균(marketAvgPricePerUnit) 대비 저렴할수록 높은 점수 (핵심)
2. 대용량 여부: isBulk=true이면 가점 (대용량 선호)
3. 리뷰 신뢰도: reviews 수가 많을수록 가점 (저단가에도 실패 확률이 낮은 상품 선호)`,

    mixed: `유저는 브랜드와 가격을 모두 고려하는 복합형입니다.
평가 기준:
1. 가격 타이밍 (30%): 현재가 vs 3달 최저가
2. 단위당 단가 (30%): 시장 평균 대비 저렴함
3. 브랜드 신뢰도 (20%): rating, reviews, isPremium 종합
4. 가성비 종합 (20%): 위 세 기준의 균형`,
  }[personaType];

  // ── GPT 프롬프트 구성 ──
  // 점수 규칙을 명시적으로 강제하는 이유:
  //   GPT는 기본적으로 "긍정 편향"이 있어 자유롭게 점수를 매기게 두면 대부분 80~95점에 몰림
  //   → 상품 간 변별력 확보를 위해 점수 분포 가이드와 상·하한 룰을 박아넣음
  //
  // "전부 채점" 강제 + 다중 예시:
  //   초기에는 예시가 1개 객체뿐이라 GPT가 "한 개만 답하면 되겠구나"로 잘못 해석해
  //   첫 상품만 점수 매기고 나머지를 빠뜨리는 버그가 있었음.
  //   → expected_count 명시 + 예시에 여러 개 보여줘서 누락 방지.
  const productCount = productSummaries.length;
  const prompt = `당신은 한국 이커머스 가성비 분석 전문가입니다.

${personaContext}

점수 규칙 (반드시 준수):
- 0~99점 범위 사용
- 상품 간 점수 차이 최소 5점 이상 필수 (전부 95점대 절대 금지)
- 진짜 가성비 좋은 상품 1~2개만 80점 이상
- 가격이 3달 최고가에 가까운 상품 → 35점 이하 가능
- 시장 평균보다 단가 비싼 상품 → 45점 이하
- 점수 분포 예시: 12, 28, 45, 61, 74, 88

★ 매우 중요: 반드시 ${productCount}개 상품 전부에 대해 점수를 매겨야 합니다.
   누락된 index가 하나라도 있으면 안 됩니다. (index 0부터 ${productCount - 1}까지 모두 포함)

상품 데이터:
${JSON.stringify(productSummaries, null, 2)}

반드시 아래 JSON만 응답 (마크다운 없이, scores 배열에 정확히 ${productCount}개 객체 포함):
{"scores":[
  {"index":0,"score":74,"tooltip":"최저가 대비 3% · 리뷰 1.2만"},
  {"index":1,"score":52,"tooltip":"평균 단가 · 평점 4.5"},
  {"index":2,"score":28,"tooltip":"최고가 +12% · 리뷰 적음"}
]}

tooltip 규칙: 25자 이내, 핵심 수치 2개 포함 (예: "최저가 대비 5%" + "단가 20% 저렴").`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",   // 가성비/속도 균형 (4o보다 ~10배 저렴하면서 이 정도 평가는 충분)
      messages: [{ role: "user", content: prompt }],
      // temperature 0.3:
      //   너무 낮으면(0.0) 같은 입력에 너무 결정론적이라 다양성 부족
      //   너무 높으면(0.7+) 같은 상품인데 새로고침마다 점수가 크게 달라져 신뢰 깨짐
      //   0.3은 OpenAI 권장 "분류·평가 작업" 수준
      temperature: 0.3,
      // max_tokens 1500:
      //   한국어 툴팁은 영어보다 토큰을 더 많이 먹음 (한 글자 ≈ 1.5~2 토큰)
      //   25자 한국어 툴팁 = ~50토큰, 상품 10개면 800+ 토큰
      //   여유 있게 1500으로 두어 응답 잘림 방지
      max_tokens: 1500,
      // JSON 모드 강제: gpt-4o-mini는 response_format을 지원해 응답을 항상 JSON으로 강제 가능
      // → 코드 펜스(```json)나 자유 텍스트 섞일 일이 없어짐
      response_format: { type: "json_object" },
    });

    // ── GPT 응답 파싱 ──
    // GPT가 가끔 ```json ... ``` 코드 펜스를 붙이는 경우가 있어 제거 (안전망)
    const raw = completion.choices[0].message.content.trim().replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(raw);

    // 누락 감지: GPT가 일부 인덱스를 빼먹은 경우 서버 로그로 추적 가능하게
    const returnedIndexes = new Set((parsed.scores || []).map((s) => s.index));
    const missingIndexes = [];
    for (let i = 0; i < productCount; i++) {
      if (!returnedIndexes.has(i)) missingIndexes.push(i);
    }
    if (missingIndexes.length > 0) {
      console.warn(`[GPT 응답 누락] 채점되지 않은 index: ${missingIndexes.join(", ")} / 전체 ${productCount}개 중 ${returnedIndexes.size}개만 반환`);
    }

    // GPT가 반환한 점수를 원래 상품 배열의 순서대로 매핑
    // .find()로 인덱스 매칭하는 이유: GPT가 순서를 바꿔서 반환할 수도 있어 안전
    const scoredProducts = products.map((p, i) => {
      const s = parsed.scores.find((s) => s.index === i);
      // GPT가 일부 인덱스를 누락한 경우 → null로 처리해 프론트에서 "🔒 점수 대기중" 표시
      return { ...p, valueScore: s?.score ?? null, scoreTooltip: s?.tooltip || null };
    });

    return { products: scoredProducts, scoreSource: "gpt" };

  } catch (err) {
    // ── GPT 실패 시 로컬 폴백 ──
    // OpenAI API 실패 케이스(잘못된 키, 잔액 부족, Rate limit, 타임아웃 등) 발생 시
    // calcLocalScore로 자동 전환. 점수가 안 나오면 유저가 아예 비교를 못 하므로
    // "정확하진 않더라도 일단 가성비 신호는 주자"는 방향.
    // scoreSource: "local"로 표시해 디버깅에서 GPT 실패 여부 추적 가능.
    console.error("GPT 점수 산출 실패, 로컬 폴백:", err.message);
    const scoredProducts = products.map((p) => ({
      ...p,
      valueScore: calcLocalScore(p, personaType),
      scoreTooltip: getLocalTooltip(p, personaType),
    }));
    return { products: scoredProducts, scoreSource: "local" };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 로컬 폴백 점수 — 직관적 합산 방식
// ─────────────────────────────────────────────────────────────────────────────
//
// 설계 원칙: "누가 봐도 점수 분해가 가능하게."
//
// 3가지 항목, 각 0~33점, 합산 후 99로 cap:
//   1. 평점 점수   — 평점이 좋은가?
//   2. 리뷰 점수   — 신뢰할 만큼 리뷰가 많은가?
//   3. 가격 점수   — 가격이 합리적인가? (성향별 기준 다름)
//
// 총점 예시:
//   "평점 25 + 리뷰 28 + 가격 22 = 75점"
//   → 어느 항목이 점수에 기여했는지 한눈에 보임 (검증·디버깅 쉬움)
//
// 이전 알고리즘(가중치 비율 + isPremium 보너스 + 추세 보정 등)은 복잡해서
// "왜 이 점수?"에 답하기 어려웠음. 단순 합산으로 회귀.

/**
 * 로컬 폴백 메인 함수 — 3개 항목을 합산
 */
function calcLocalScore(product, personaType) {
  const ratingScore = calcRatingScore(product);          // 0~33
  const reviewScore = calcReviewScore(product);          // 0~33
  const priceScore = calcPriceScore(product, personaType); // 0~33
  return Math.min(99, ratingScore + reviewScore + priceScore);
}

/**
 * 평점 점수 (0~33)
 * 4.0 → 0점, 5.0 → 33점 선형 매핑.
 * 4.0 미만은 0점 (다나와 상품 거의 모두 4.0 이상이라 사실상 4.0~5.0 구간만 사용).
 */
function calcRatingScore(product) {
  if (!product.rating) return 0;
  return Math.max(0, Math.min(33, Math.round((product.rating - 4.0) * 33)));
}

/**
 * 리뷰 점수 (0~33) — log10 스케일
 * 0개 → 0점, 100개 → ~16점, 1000개 → ~25점, 10000개 → 33점.
 * log를 쓰는 이유: 리뷰 100→1000은 의미 크지만 1만→10만은 의미가 적어 평탄화.
 */
function calcReviewScore(product) {
  if (!product.reviews) return 0;
  return Math.min(33, Math.round((Math.log10(product.reviews + 1) / 4) * 33));
}

/**
 * 가격 점수 (0~33) — 성향별로 기준만 다름
 * - brand:  3개월 최저가 대비 (지금이 살 타이밍인가)
 * - volume: 단가 vs 시장 평균 단가 (단위당 가격 합리적인가)
 * - mixed:  현재가 vs 시장 평균가 (전체 가격이 합리적인가)
 */
function calcPriceScore(product, personaType) {
  if (personaType === "brand") return calcTimingScore(product);
  if (personaType === "volume") return calcUnitPriceScore(product);
  return calcMarketPriceScore(product);
}

// brand — 가격 타이밍 점수: 3개월 최저가에 가까울수록 만점
function calcTimingScore(product) {
  const history = product.priceHistory || [];
  if (history.length < 2) return 17; // 정보 부족 → 중간 점수

  const prices = history.map((h) => h.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  if (max === min) return 17; // 변동 없음 → 중간

  // position 0 = 최저가, 1 = 최고가 → 뒤집어서 점수화
  const position = (product.price - min) / (max - min);
  return Math.max(0, Math.min(33, Math.round((1 - position) * 33)));
}

// volume — 단가 점수: 시장 평균 단가 대비 비율
function calcUnitPriceScore(product) {
  if (!product.pricePerUnit || !product.marketAvgPricePerUnit) return 17;
  // ratio = 시장 평균 단가 / 이 상품 단가
  //   ratio = 1 (평균과 동일) → 17점
  //   ratio = 2 (절반 가격)   → 33점 (cap)
  //   ratio = 0.5 (2배 비쌈)  → 0점 근처
  const ratio = product.marketAvgPricePerUnit / product.pricePerUnit;
  return Math.max(0, Math.min(33, Math.round(17 + (ratio - 1) * 16)));
}

// mixed — 시장 평균가 대비 점수
function calcMarketPriceScore(product) {
  if (!product.marketAvgPrice) return 17;
  // ratio = 시장 평균가 / 현재가
  //   ratio = 1 (평균과 동일) → 17점
  //   ratio = 1.3 (평균보다 30% 저렴) → 33점
  //   ratio = 0.7 (평균보다 30% 비쌈) → 0점 근처
  const ratio = product.marketAvgPrice / product.price;
  return Math.max(0, Math.min(33, Math.round(17 + (ratio - 1) * 53)));
}

/**
 * 로컬 점수 툴팁 — 가장 직관적인 항목 2~3개를 사람 친화적으로 표시
 *
 * 형태: "{가격 정보} · {평점} · {리뷰 수}"
 * 예시: "최저가 +3% · 평점 4.7 · 리뷰 1.2만"
 */
function getLocalTooltip(product, personaType) {
  const parts = [];

  // 가격 정보 (성향별로 다름)
  const priceStr = formatPriceInsight(product, personaType);
  if (priceStr) parts.push(priceStr);

  // 평점
  if (product.rating) parts.push(`평점 ${product.rating.toFixed(1)}`);

  // 리뷰 수
  if (product.reviews) parts.push(formatReviewCount(product.reviews));

  return parts.join(" · ") || "정보 부족";
}

function formatPriceInsight(product, personaType) {
  if (personaType === "brand") {
    const history = product.priceHistory || [];
    if (history.length < 2) return "";
    const min = Math.min(...history.map((h) => h.price));
    const diff = Math.round(((product.price - min) / min) * 100);
    return diff <= 2 ? "3달 최저가" : `최저가 +${diff}%`;
  }
  if (personaType === "volume") {
    if (!product.pricePerUnit || !product.marketAvgPricePerUnit) return "";
    const saving = Math.round(
      ((product.marketAvgPricePerUnit - product.pricePerUnit) / product.marketAvgPricePerUnit) * 100
    );
    if (saving > 0) return `단가 ${saving}% 저렴`;
    if (saving < 0) return `단가 ${Math.abs(saving)}% 비쌈`;
    return "평균 단가";
  }
  // mixed
  if (!product.marketAvgPrice) return "";
  const saving = Math.round(((product.marketAvgPrice - product.price) / product.marketAvgPrice) * 100);
  if (saving > 0) return `평균보다 ${saving}% 저렴`;
  if (saving < 0) return `평균보다 ${Math.abs(saving)}% 비쌈`;
  return "시장 평균가";
}

function formatReviewCount(reviews) {
  if (reviews >= 10000) return `리뷰 ${(reviews / 10000).toFixed(1)}만`;
  if (reviews >= 1000) return `리뷰 ${(reviews / 1000).toFixed(1)}천`;
  return `리뷰 ${reviews}`;
}

module.exports = { detectPersonaType, scoreProductsWithGPT };
