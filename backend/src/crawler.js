/**
 * crawler.js
 *
 * 다나와 가격비교 크롤링 모듈
 *
 * 다나와를 선택한 이유:
 * - 정적 HTML 렌더링으로 axios+cheerio 크롤링 안정적
 * - 여러 쇼핑몰 최저가를 한 번에 비교 제공
 * - 별도 API 키 불필요
 *
 * 크롤링 실패 시 카테고리별 목 데이터로 자동 폴백
 */

const axios = require("axios");
const cheerio = require("cheerio");

/**
 * 다나와에서 상품 목록을 크롤링합니다.
 *
 * @param {string} keyword - 검색 키워드
 * @returns {Array} 파싱된 상품 배열. 실패 시 빈 배열.
 */
async function crawlDanawa(keyword) {
  const url = `https://search.danawa.com/dsearch.php?query=${encodeURIComponent(keyword)}&originalQuery=${encodeURIComponent(keyword)}&checkedInfo=N&volumeType=allvs&page=1&limit=10&sort=savePriceDesc&list=list&boost=true&tab=goods`;

  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ko-KR,ko;q=0.9",
    Referer: "https://www.danawa.com/",
  };

  try {
    // timeout 10초: 다나와 응답이 늦으면 목 데이터 폴백이 더 나으므로 빠르게 포기
    const response = await axios.get(url, { headers, timeout: 10000 });
    const $ = cheerio.load(response.data);
    const products = [];

    // 다나와 상품 리스트 파싱
    $("li.prod_item").each((i, el) => {
      // 10개 이상은 GPT 토큰 낭비 + 유저가 스크롤로 다 보지 않으므로 제한
      if (i >= 10) return false;

      // 상품명
      const name = $(el).find(".prod_name a").text().trim()
        || $(el).find(".prod_info .name").text().trim();

      // 최저가 — 첫 번째 숫자 덩어리만 추출 (여러 가격이 붙어서 파싱되는 버그 방지)
      const priceRaw = $(el).find(".price_sect a strong").first().text().trim()
        || $(el).find(".lowest_price strong").first().text().trim()
        || $(el).find("[class*='price'] strong").first().text().trim();
      const priceMatch = priceRaw.match(/[\d,]+/);
      const price = priceMatch ? parseInt(priceMatch[0].replace(/,/g, "")) : 0;

      // 이미지
      const image = $(el).find(".thumb_wrap img").attr("src")
        || $(el).find("img.thumb").attr("src") || "";

      // 브랜드
      const brand = $(el).find(".prod_name .prod_eng_name").text().trim()
        || $(el).find(".maker_nm").text().trim() || "";

      // 평점 — 다나와 현재 구조: <span class="text__score">4.65</span>
      // (예전 구조 .star_rating[data-rating]는 더 이상 안 쓰이지만 안전망으로 남김)
      const ratingText = $(el).find(".text__score").first().text().trim()
        || $(el).find(".star_rating").attr("data-rating")
        || $(el).find(".rating_num").text().trim();
      const rating = parseFloat(ratingText) || 0;

      // 리뷰 수 — 다나와 현재 구조: <div class="text__review">...<span class="text__number">100</span>
      const reviewText = $(el).find(".text__review .text__number").first().text().replace(/[^0-9]/g, "")
        || $(el).find(".cnt_opinion").text().replace(/[^0-9]/g, "")
        || $(el).find(".review_cnt").text().replace(/[^0-9]/g, "");
      const reviews = parseInt(reviewText) || 0;

      // 용량/중량 파싱
      const volumeMatch = name.match(/(\d+(?:\.\d+)?)\s*(kg|g|ml|L|매|롤|개|팩|봉|장)/i);
      const volume = volumeMatch
        ? { amount: parseFloat(volumeMatch[1]), unit: volumeMatch[2] }
        : null;

      // 단위별 대용량 기준
      // 각 값은 "이 이상이면 소비자가 대량 구매로 인식하는 경계선"
      // g/ml: 2kg/2L 이상, 롤: 한 묶음 20롤 이상, 매: 기저귀 60매팩 이상 등
      const BULK_THRESHOLD = {
        g: 2000, kg: 2, ml: 2000, L: 2,
        매: 60, 롤: 20, 개: 20, 팩: 10, 봉: 10, 장: 30,
      };
      const isBulk = volume
        ? volume.amount >= (BULK_THRESHOLD[volume.unit] || 1000)
        : false;

      if (name && price > 0) {
        products.push({
          // Date.now()를 섞는 이유: 같은 세션에서 두 번 검색하면 인덱스가 겹칠 수 있어 ID 충돌 방지
          id: `danawa-${i}-${Date.now()}`,
          name,
          price,
          // 다나와 이미지 URL은 "//img.danawa.com/..." 같은 프로토콜-상대 형식으로 오는 경우가 있어 보완
          image: image.startsWith("//") ? `https:${image}` : image,
          rating,
          reviews,
          brand,
          badge: "",
          volume,
          pricePerUnit: volume ? Math.round(price / volume.amount) : null,
          isPremium: false,
          isBulk,
          source: "danawa",
        });
      }
    });

    console.log(`다나와 크롤링 결과: ${products.length}개`);
    return products;
  } catch (err) {
    console.error("다나와 크롤링 실패:", err.message);
    return [];
  }
}

/**
 * 카테고리별 목 데이터
 * 크롤링 실패 또는 결과 부족(3개 미만) 시 폴백
 */
const MOCK_DATA = {
  세제: [
    { id: "mock-1", name: "피죤 울트라 세탁세제 3kg", price: 12900, brand: "피죤", image: "", rating: 4.7, reviews: 12043, volume: { amount: 3000, unit: "g" }, pricePerUnit: 4, isPremium: false, isBulk: true },
    { id: "mock-2", name: "LG테크 드럼세탁세제 3.6L", price: 17500, brand: "LG생활건강", image: "", rating: 4.8, reviews: 8321, volume: { amount: 3600, unit: "ml" }, pricePerUnit: 5, isPremium: true, isBulk: true },
    { id: "mock-3", name: "옥시 크린 파워젤 2.5L", price: 9900, brand: "옥시", image: "", rating: 4.5, reviews: 5421, volume: { amount: 2500, unit: "ml" }, pricePerUnit: 4, isPremium: false, isBulk: false },
    { id: "mock-4", name: "아리엘 세탁세제 6kg", price: 24900, brand: "아리엘", image: "", rating: 4.9, reviews: 19832, volume: { amount: 6000, unit: "g" }, pricePerUnit: 4, isPremium: true, isBulk: true },
    { id: "mock-5", name: "다우니 울트라 세탁세제 2L", price: 11500, brand: "다우니", image: "", rating: 4.6, reviews: 7654, volume: { amount: 2000, unit: "ml" }, pricePerUnit: 6, isPremium: true, isBulk: false },
    { id: "mock-6", name: "비트 파워젤 세탁세제 4L", price: 13200, brand: "비트", image: "", rating: 4.4, reviews: 4312, volume: { amount: 4000, unit: "ml" }, pricePerUnit: 3, isPremium: false, isBulk: true },
  ],
  휴지: [
    { id: "mock-7", name: "크리넥스 3겹 화장지 30롤", price: 19800, brand: "크리넥스", image: "", rating: 4.8, reviews: 24531, volume: { amount: 30, unit: "롤" }, pricePerUnit: 660, isPremium: true, isBulk: true },
    { id: "mock-8", name: "유한킴벌리 스카트 3겹 30롤", price: 17500, brand: "유한킴벌리", image: "", rating: 4.7, reviews: 18902, volume: { amount: 30, unit: "롤" }, pricePerUnit: 583, isPremium: true, isBulk: true },
    { id: "mock-9", name: "깨끗한나라 순수100 2겹 60롤", price: 21900, brand: "깨끗한나라", image: "", rating: 4.5, reviews: 8743, volume: { amount: 60, unit: "롤" }, pricePerUnit: 365, isPremium: false, isBulk: true },
    { id: "mock-10", name: "모나리자 3겹 프리미엄 24롤", price: 16800, brand: "모나리자", image: "", rating: 4.6, reviews: 6231, volume: { amount: 24, unit: "롤" }, pricePerUnit: 700, isPremium: false, isBulk: true },
  ],
  키친타올: [
    { id: "mock-18", name: "크리넥스 키친타올 150매 6롤", price: 12900, brand: "크리넥스", image: "", rating: 4.8, reviews: 15230, volume: { amount: 6, unit: "롤" }, pricePerUnit: 2150, isPremium: true, isBulk: false },
    { id: "mock-19", name: "스카트 키친타올 100매 8롤", price: 10500, brand: "유한킴벌리", image: "", rating: 4.6, reviews: 9812, volume: { amount: 8, unit: "롤" }, pricePerUnit: 1313, isPremium: true, isBulk: false },
    { id: "mock-20", name: "뽀삐 키친타올 150매 12롤", price: 14900, brand: "뽀삐", image: "", rating: 4.5, reviews: 6543, volume: { amount: 12, unit: "롤" }, pricePerUnit: 1242, isPremium: false, isBulk: true },
    { id: "mock-21", name: "좋은느낌 키친타올 100매 10롤", price: 8900, brand: "좋은느낌", image: "", rating: 4.3, reviews: 3210, volume: { amount: 10, unit: "롤" }, pricePerUnit: 890, isPremium: false, isBulk: true },
    { id: "mock-22", name: "LG 시트레이 키친타올 60매 6롤", price: 11200, brand: "LG생활건강", image: "", rating: 4.7, reviews: 7821, volume: { amount: 6, unit: "롤" }, pricePerUnit: 1867, isPremium: true, isBulk: false },
  ],
  기저귀: [
    { id: "mock-11", name: "하기스 맥스드라이 밴드형 대형 84매", price: 34900, brand: "하기스", image: "", rating: 4.9, reviews: 31245, volume: { amount: 84, unit: "매" }, pricePerUnit: 415, isPremium: true, isBulk: true },
    { id: "mock-12", name: "팸퍼스 보송보송 밴드형 대형 88매", price: 36500, brand: "팸퍼스", image: "", rating: 4.8, reviews: 22140, volume: { amount: 88, unit: "매" }, pricePerUnit: 415, isPremium: true, isBulk: true },
    { id: "mock-13", name: "마미포코 밴드형 팬티 대형 80매", price: 19900, brand: "마미포코", image: "", rating: 4.3, reviews: 8923, volume: { amount: 80, unit: "매" }, pricePerUnit: 249, isPremium: false, isBulk: true },
    { id: "mock-14", name: "그린핑거 유기농 밴드형 대형 72매", price: 28900, brand: "그린핑거", image: "", rating: 4.7, reviews: 14320, volume: { amount: 72, unit: "매" }, pricePerUnit: 401, isPremium: false, isBulk: true },
  ],
  쌀: [
    { id: "mock-15", name: "햇살드림 백미 10kg", price: 32900, brand: "햇살드림", image: "", rating: 4.8, reviews: 9821, volume: { amount: 10, unit: "kg" }, pricePerUnit: 3290, isPremium: false, isBulk: true },
    { id: "mock-16", name: "이천쌀 추청미 20kg", price: 58000, brand: "이천쌀", image: "", rating: 4.9, reviews: 5431, volume: { amount: 20, unit: "kg" }, pricePerUnit: 2900, isPremium: true, isBulk: true },
    { id: "mock-17", name: "CJ 햇반 즉석밥 210g 24개입", price: 24900, brand: "CJ", image: "", rating: 4.7, reviews: 31092, volume: { amount: 24, unit: "개" }, pricePerUnit: 1038, isPremium: true, isBulk: true },
    { id: "mock-23", name: "농협 고시히카리 10kg", price: 36900, brand: "농협", image: "", rating: 4.6, reviews: 4231, volume: { amount: 10, unit: "kg" }, pricePerUnit: 3690, isPremium: false, isBulk: true },
  ],
  라면: [
    { id: "mock-24", name: "농심 신라면 멀티팩 120g 20개입", price: 17900, brand: "농심", image: "", rating: 4.9, reviews: 28341, volume: { amount: 20, unit: "개" }, pricePerUnit: 895, isPremium: true, isBulk: true },
    { id: "mock-25", name: "오뚜기 진라면 매운맛 120g 20개입", price: 14900, brand: "오뚜기", image: "", rating: 4.7, reviews: 18234, volume: { amount: 20, unit: "개" }, pricePerUnit: 745, isPremium: false, isBulk: true },
    { id: "mock-26", name: "삼양 불닭볶음면 140g 20개입", price: 19800, brand: "삼양", image: "", rating: 4.8, reviews: 21432, volume: { amount: 20, unit: "개" }, pricePerUnit: 990, isPremium: true, isBulk: true },
    { id: "mock-27", name: "농심 안성탕면 125g 20개입", price: 13900, brand: "농심", image: "", rating: 4.6, reviews: 9821, volume: { amount: 20, unit: "개" }, pricePerUnit: 695, isPremium: false, isBulk: true },
    { id: "mock-28", name: "팔도 비빔면 130g 20개입", price: 16500, brand: "팔도", image: "", rating: 4.5, reviews: 7432, volume: { amount: 20, unit: "개" }, pricePerUnit: 825, isPremium: false, isBulk: true },
    { id: "mock-29", name: "농심 짜파게티 140g 20개입", price: 18200, brand: "농심", image: "", rating: 4.8, reviews: 15321, volume: { amount: 20, unit: "개" }, pricePerUnit: 910, isPremium: true, isBulk: true },
  ],
  생수: [
    { id: "mock-30", name: "제주삼다수 2L 12병", price: 14900, brand: "제주삼다수", image: "", rating: 4.9, reviews: 42321, volume: { amount: 24, unit: "L" }, pricePerUnit: 621, isPremium: true, isBulk: true },
    { id: "mock-31", name: "아이시스 8.0 2L 12병", price: 9900, brand: "롯데칠성", image: "", rating: 4.7, reviews: 21043, volume: { amount: 24, unit: "L" }, pricePerUnit: 413, isPremium: false, isBulk: true },
    { id: "mock-32", name: "백산수 2L 12병", price: 11900, brand: "농심", image: "", rating: 4.8, reviews: 18432, volume: { amount: 24, unit: "L" }, pricePerUnit: 496, isPremium: false, isBulk: true },
    { id: "mock-33", name: "평창수 2L 12병", price: 10500, brand: "해태", image: "", rating: 4.6, reviews: 8743, volume: { amount: 24, unit: "L" }, pricePerUnit: 438, isPremium: false, isBulk: true },
    { id: "mock-34", name: "에비앙 1.5L 12병", price: 28900, brand: "에비앙", image: "", rating: 4.8, reviews: 5421, volume: { amount: 18, unit: "L" }, pricePerUnit: 1606, isPremium: true, isBulk: true },
  ],
  김: [
    { id: "mock-35", name: "동원 양반 들기름김 5g 100봉", price: 24900, brand: "동원", image: "", rating: 4.8, reviews: 18234, volume: { amount: 100, unit: "봉" }, pricePerUnit: 249, isPremium: true, isBulk: true },
    { id: "mock-36", name: "광천김 재래김 도시락김 100봉", price: 17900, brand: "광천김", image: "", rating: 4.7, reviews: 12043, volume: { amount: 100, unit: "봉" }, pricePerUnit: 179, isPremium: false, isBulk: true },
    { id: "mock-37", name: "풀무원 곱창김 도시락김 80봉", price: 15900, brand: "풀무원", image: "", rating: 4.7, reviews: 8432, volume: { amount: 80, unit: "봉" }, pricePerUnit: 199, isPremium: false, isBulk: true },
    { id: "mock-38", name: "명가 프리미엄 조미김 50봉", price: 18500, brand: "명가", image: "", rating: 4.9, reviews: 6543, volume: { amount: 50, unit: "봉" }, pricePerUnit: 370, isPremium: true, isBulk: true },
    { id: "mock-39", name: "대천김 본조림김 60봉", price: 12900, brand: "대천김", image: "", rating: 4.5, reviews: 4321, volume: { amount: 60, unit: "봉" }, pricePerUnit: 215, isPremium: false, isBulk: true },
  ],
};

/**
 * keyword/category → MOCK_DATA 키 매핑
 */
function resolveMockCategory(keyword, category) {
  const key = (category || keyword || "").toLowerCase();
  if (key.includes("키친")) return "키친타올";
  if (key.includes("세제")) return "세제";
  if (key.includes("화장지") || key.includes("휴지") || key.includes("롤")) return "휴지";
  if (key.includes("기저귀")) return "기저귀";
  if (key.includes("쌀") || key.includes("즉석밥")) return "쌀";
  if (key.includes("라면") || key.includes("멀티팩")) return "라면";
  if (key.includes("생수") || key.includes("물") || key.includes("워터")) return "생수";
  if (key.includes("김") || key.includes("조미김") || key.includes("도시락김")) return "김";
  if (MOCK_DATA[category]) return category;
  return "세제";
}

/**
 * 메인 상품 조회 함수
 * 다나와 크롤링 → 부족하면 목 데이터 폴백 → 부가 지표 계산 후 반환
 */
async function getProducts(keyword, category) {
  console.log(`다나와 크롤링 시작: ${keyword}`);
  let products = await crawlDanawa(keyword);

  if (products.length < 3) {
    console.log("크롤링 데이터 부족, 목 데이터 사용");
    const mockKey = resolveMockCategory(keyword, category);
    console.log(`목 데이터 카테고리: ${mockKey}`);
    products = MOCK_DATA[mockKey].map(p => ({ ...p, source: "mock" }));
  }

  // 시장 기준선 계산: 같은 검색 결과 상품들의 평균을 시장 평균으로 정의
  // isPremium/lowUnitPrice 판별과 GPT 프롬프트 context에 사용됨
  const avgPrice = Math.round(
    products.reduce((s, p) => s + p.price, 0) / products.length
  );
  // pricePerUnit이 없는 상품(용량 파싱 실패)은 평균 계산에서 제외
  const withUnit = products.filter((p) => p.pricePerUnit);
  const avgPricePerUnit = withUnit.length > 0
    ? Math.round(withUnit.reduce((s, p) => s + p.pricePerUnit, 0) / withUnit.length)
    : 0;

  return products.map((p) => ({
    ...p,
    marketAvgPrice: avgPrice,
    marketAvgPricePerUnit: avgPricePerUnit,
    isPremium: p.isPremium ?? (p.price > avgPrice * 1.3),
    isBulk: p.isBulk ?? false,
    priceHistory: generatePriceHistory(p.price),
  }));
}

/**
 * 90일 가격 히스토리 시뮬레이션
 * 실제 서비스에서는 DB에 쌓인 실제 가격 이력으로 대체 필요
 */
function generatePriceHistory(currentPrice) {
  const history = [];
  const now = Date.now();
  for (let i = 90; i >= 0; i -= 10) {
    // (Math.random() - 0.3): -0.3~0.7 범위 → 평균적으로 현재가보다 약간 낮게 분포
    // * 0.15: 최대 ±15% 이내 변동 (실제 가격 변동폭과 유사한 수준으로 설정)
    const variance = (Math.random() - 0.3) * 0.15;
    history.push({
      // 
      date: new Date(now - i * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
      price: Math.round(currentPrice * (1 + variance)),
    });
  }
  history.push({ date: new Date().toISOString().split("T")[0], price: currentPrice });
  return history;
}

module.exports = { getProducts };
