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
 *   +2  고평점 상품 클릭 (평점 4.7 이상 — 브랜드 신뢰도 직접 신호)
 *   +1  시장 평균가 이상 상품 클릭 (보조 신호)
 *
 * [용량파 신호]
 *   +1  대용량 상품 클릭 (다나와 상품 대부분이 대용량이라 가중치 낮춤)
 *   +2  저단가 상품 선택 (시장 평균 단가의 80% 이하)
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
 *   @param {number}   highRatingClicks    - 고평점(4.7+) 상품 클릭 수 (다나와 HTML에서 평점 수집 확인됨)
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
    highRatingClicks = 0,
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
    highRatingClicks * 2 +   // 고평점 상품 클릭 (강한 신호 — 평점 수집 복원)
    avgAboveClicks * 1;      // 평균가 이상 클릭 (보조 신호)

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

  // GPT에 전달할 핵심 지표만 추출 (토큰 절약)
  const productSummaries = products.map((p, i) => ({
    index: i,
    name: p.name,
    brand: p.brand,
    price: p.price,
    pricePerUnit: p.pricePerUnit,
    unit: p.volume?.unit,
    rating: p.rating || 0,      // 다나와 .text__score 에서 수집됨
    reviews: p.reviews || 0,    // 다나와 .text__review .text__number 에서 수집됨
    minPrice3M: p.priceHistory ? Math.min(...p.priceHistory.map((h) => h.price)) : p.price,  // 3달 최저가
    maxPrice3M: p.priceHistory ? Math.max(...p.priceHistory.map((h) => h.price)) : p.price,  // 3달 최고가
    marketAvgPrice: p.marketAvgPrice,
    marketAvgPricePerUnit: p.marketAvgPricePerUnit,
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

  const prompt = `당신은 한국 이커머스 가성비 분석 전문가입니다.

${personaContext}

점수 규칙 (반드시 준수):
- 0~99점 범위 사용
- 상품 간 점수 차이 최소 5점 이상 필수 (전부 95점대 절대 금지)
- 진짜 가성비 좋은 상품 1~2개만 80점 이상
- 가격이 3달 최고가에 가까운 상품 → 35점 이하 가능
- 시장 평균보다 단가 비싼 상품 → 45점 이하
- 점수 분포 예시: 12, 28, 45, 61, 74, 88

상품 데이터:
${JSON.stringify(productSummaries, null, 2)}

반드시 아래 JSON만 응답 (마크다운 없이):
{"scores":[{"index":0,"score":74,"tooltip":"최저가 대비 3% · 리뷰 1.2만개"}]}

tooltip 규칙: 25자 이내, 핵심 수치 2개 포함 (예: "최저가 대비 5%" + "100g당 20% 저렴").`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      // temperature 0.3: 점수가 매번 크게 달라지면 신뢰성이 떨어지므로 낮게 설정
      // max_tokens 900: 상품 10개 × {"index":i,"score":nn,"tooltip":"..."} ≈ 60토큰 여유 포함
      temperature: 0.3,
      max_tokens: 900,
    });

    // GPT 응답에서 JSON 부분만 추출해 파싱
    const raw = completion.choices[0].message.content.trim().replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(raw);

    // GPT가 반환한 점수를 원래 상품 배열에 매핑
    const scoredProducts = products.map((p, i) => {
      const s = parsed.scores.find((s) => s.index === i);
      return { ...p, valueScore: s?.score ?? null, scoreTooltip: s?.tooltip || null };
    });

    return { products: scoredProducts, scoreSource: "gpt" };

  } catch (err) {
    console.error("GPT 점수 산출 실패, 로컬 폴백:", err.message);
    const scoredProducts = products.map((p) => ({
      ...p,
      valueScore: calcLocalScore(p, personaType),
      scoreTooltip: getLocalTooltip(p, personaType),
    }));
    return { products: scoredProducts, scoreSource: "local" };
  }
}

/**
 * GPT 실패 시 로컬 점수 계산
 *
 * 브랜드파/mixed:
 *   가격 타이밍 점수(70%) + 리뷰/평점 신뢰도(30%) 합산
 *
 * 용량파:
 *   단가 절약률 점수(70%) + 리뷰 신뢰도(30%) 합산
 */
function calcLocalScore(product, personaType) {
  // 리뷰/평점 신뢰도 점수 (0~20점)
  // log10 스케일 사용: 리뷰 100개→10점, 1000개→15점, 30000개→15점처럼 수확 체감 반영
  // 30000을 기준으로 정규화: 다나와 최다 리뷰 상품(아리엘 등)이 대략 2만~3만개 수준
  const reviewScore = Math.min(20, Math.round((Math.log10(product.reviews + 1) / Math.log10(30000)) * 15));
  const ratingBonus = product.rating >= 4.7 ? 5 : product.rating >= 4.0 ? 2 : 0;
  const trustScore = reviewScore + ratingBonus;

  if (personaType === "brand" || personaType === "mixed") {
    const history = product.priceHistory || [];
    if (!history.length) return Math.min(99, 50 + trustScore);

    const prices = history.map((h) => h.price);
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const range = maxPrice - minPrice || 1; // 0 나눗셈 방지 (가격 변동 없으면 1로 처리)
    // position: 0이면 현재가 = 3달 최저가(구매 최적 타이밍), 1이면 3달 최고가
    const position = (product.price - minPrice) / range;
    // (1 - position) * 79: 최저가일수록 79점에 가깝게, 최고가일수록 0점에 가깝게
    // 79를 상한으로 두는 이유: trustScore(0~20)를 더해도 합계 99를 넘지 않도록
    const timingScore = Math.round((1 - position) * 79);
    return Math.min(99, Math.max(0, timingScore + trustScore));

  } else {
    // 용량파
    if (!product.pricePerUnit || !product.marketAvgPricePerUnit) {
      return Math.min(99, 50 + trustScore);
    }
    // ratio: 시장 평균 단가 / 이 상품 단가 → 1이면 평균, 2이면 절반 가격
    // ratio * 55: 평균(ratio=1)이면 55점, 절반 가격(ratio=2)이면 110 → cap 79
    // 79를 상한으로 두는 이유: trustScore(0~20)를 더해도 합계 99를 넘지 않도록
    const ratio = product.marketAvgPricePerUnit / product.pricePerUnit;
    const valueScore = Math.round(Math.min(ratio * 55, 79));
    return Math.min(99, Math.max(0, valueScore + trustScore));
  }
}

/**
 * 로컬 점수에 대한 툴팁 생성
 * 브랜드파: 가격 타이밍 + 리뷰 수 표시
 * 용량파: 단가 절약률 + 리뷰 수 표시
 */
function getLocalTooltip(product, personaType) {
  const reviewStr = product.reviews > 1000
    ? `리뷰 ${(product.reviews / 1000).toFixed(1)}만개`
    : `리뷰 ${product.reviews}개`;

  if (personaType === "brand" || personaType === "mixed") {
    const history = product.priceHistory || [];
    if (!history.length) return `가격 정보 없음 · ${reviewStr}`;
    const minPrice = Math.min(...history.map((h) => h.price));
    const diff = Math.round(((product.price - minPrice) / minPrice) * 100);
    const priceStr = diff <= 2 ? "3달 최저가" : `최저가 대비 +${diff}%`;
    return `${priceStr} · ${reviewStr}`;
  } else {
    if (!product.pricePerUnit || !product.marketAvgPricePerUnit) {
      return `단가 정보 없음 · ${reviewStr}`;
    }
    const saving = Math.round(
      ((product.marketAvgPricePerUnit - product.pricePerUnit) / product.marketAvgPricePerUnit) * 100
    );
    const priceStr = saving > 0
      ? `평균 대비 단가 ${saving}% 저렴`
      : saving < 0 ? `평균 대비 단가 ${Math.abs(saving)}% 비쌈`
      : "시장 평균 단가";
    return `${priceStr} · ${reviewStr}`;
  }
}

module.exports = { detectPersonaType, scoreProductsWithGPT };
