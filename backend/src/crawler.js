/**
 * crawler.js
 *
 * 다나와 가격비교 크롤링 모듈
 *
 * 왜 다나와인가:
 * - 정적 HTML 렌더링 → axios+cheerio로 안정적 크롤링 (Puppeteer 같은 무거운 도구 불필요)
 * - 여러 쇼핑몰 최저가를 한 페이지에 모아 제공 → 단일 요청으로 시장 가격 분포 확보
 * - 별도 API 키 불필요 (쿠팡/네이버는 파트너 인증 필요)
 *
 * 외부 의존성 실패 처리 (이 모듈의 핵심 책임):
 * - 다나와 HTTP 응답 실패 / HTML 구조 변경 / 결과 부족 → 카테고리별 목 데이터로 자동 폴백
 * - 호출부(index.js)는 "항상 정상 배열을 받는다"고 가정 가능
 *
 * 데이터 흐름:
 *   crawlDanawa()       — 다나와 검색 페이지 HTML 가져와 cheerio로 파싱
 *      ↓
 *   getProducts()       — 크롤링 결과 부족 시 mock 폴백, 시장 평균 계산, priceHistory 부여
 *      ↓ (호출부로 반환)
 */

const axios = require("axios");
const cheerio = require("cheerio");

/**
 * 다나와에서 상품 목록을 크롤링합니다.
 *
 * 실패 모드:
 * - 네트워크 오류 / 타임아웃 → 빈 배열 반환 (호출부에서 mock 폴백)
 * - HTML 구조 변경으로 셀렉터 미스 → name/price 0인 항목이 필터링되어 빈 배열에 가까워짐
 *
 * @param {string} keyword - 검색 키워드 (이미 한글 그대로 전달, encodeURIComponent로 인코딩)
 * @returns {Array} 파싱된 상품 배열. 실패 시 빈 배열.
 */
async function crawlDanawa(keyword) {
  // 다나와 검색 URL 구성
  // - sort=savePriceDesc: 가격 절약율 내림차순 (인기상품 위주 노출 → 가성비 신호 풍부)
  // - limit=10: 한 페이지 10개 (GPT 프롬프트 토큰 관리 + 유저 스크롤 길이 고려)
  // - originalQuery: 다나와 자동완성 우회용 파라미터 (없으면 일부 키워드에서 결과 누락)
  const url = `https://search.danawa.com/dsearch.php?query=${encodeURIComponent(keyword)}&originalQuery=${encodeURIComponent(keyword)}&checkedInfo=N&volumeType=allvs&page=1&limit=10&sort=savePriceDesc&list=list&boost=true&tab=goods`;

  // 봇 차단 회피: 일반 데스크탑 Chrome으로 위장
  // Referer를 danawa.com으로 설정해야 외부 봇으로 분류되어 차단되는 것을 방지
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ko-KR,ko;q=0.9",
    Referer: "https://www.danawa.com/",
  };

  try {
    // timeout 10초: 다나와가 느릴 때 무한정 기다리면 클라이언트도 함께 멈춤
    // → 빠르게 포기하고 mock 폴백을 타는 게 UX 측면에서 우월 (사용자는 "느림"보다 "결과 없음"을 더 싫어함)
    const response = await axios.get(url, { headers, timeout: 10000 });
    const $ = cheerio.load(response.data);
    const products = [];

    // ── 다나와 상품 리스트 파싱 ──
    // 셀렉터를 여러 단계로 fallback 체이닝하는 이유:
    //   다나와는 상품 종류별로 약간씩 다른 템플릿을 쓰고, 가끔 A/B 테스트로 클래스명이 바뀜.
    //   하나가 비면 다음 후보로 넘어가도록 || 체인으로 방어적 파싱.
    $("li.prod_item").each((i, el) => {
      // 10개 이상은 자르는 이유:
      //   - GPT 프롬프트 토큰 비용 (10개에 ~600토큰)
      //   - 유저가 스크롤로 다 보지 않음 (모바일 기준 3~5개에서 결정)
      if (i >= 10) return false;

      // ── 상품명 ──
      // 다나와 신규 템플릿(.prod_name a) → 구 템플릿(.prod_info .name) 순으로 시도
      const name = $(el).find(".prod_name a").text().trim()
        || $(el).find(".prod_info .name").text().trim();

      // ── 가격 ──
      // 다나와는 "12,900원12,500원 (할인)" 처럼 여러 가격이 연달아 붙은 텍스트를 노출하는 경우가 있음
      // → 첫 번째 숫자+콤마 덩어리만 정규식으로 추출해 잘못 합쳐진 가격을 방지
      const priceRaw = $(el).find(".price_sect a strong").first().text().trim()
        || $(el).find(".lowest_price strong").first().text().trim()
        || $(el).find("[class*='price'] strong").first().text().trim();
      const priceMatch = priceRaw.match(/[\d,]+/);
      const price = priceMatch ? parseInt(priceMatch[0].replace(/,/g, "")) : 0;

      // ── 이미지 ──
      // 다나와 lazy-load 미적용 케이스(thumb_wrap img) + 적용 케이스(img.thumb) 모두 커버
      const image = $(el).find(".thumb_wrap img").attr("src")
        || $(el).find("img.thumb").attr("src") || "";

      // ── 브랜드 ──
      // 다나와 영문 브랜드명(.prod_eng_name) 우선 → 없으면 제조사(.maker_nm)
      // 다나와는 브랜드를 별도 필드로 항상 노출하지 않아서 빈 문자열인 경우도 많음
      // → 프론트에서 brand가 빈 경우 "평균가 이상 클릭" 신호로 브랜드파 성향을 보완 감지
      const brand = $(el).find(".prod_name .prod_eng_name").text().trim()
        || $(el).find(".maker_nm").text().trim() || "";

      // ── 평점 ──
      // 2024년 이후 다나와 구조: <span class="text__score">4.65</span>
      // 예전 구조 .star_rating[data-rating]와 .rating_num도 안전망으로 유지
      // (다나와 HTML이 또 바뀌어도 한쪽이 살아있으면 평점 신호가 끊기지 않음)
      const ratingText = $(el).find(".text__score").first().text().trim()
        || $(el).find(".star_rating").attr("data-rating")
        || $(el).find(".rating_num").text().trim();
      const rating = parseFloat(ratingText) || 0;

      // ── 리뷰 수 ──
      // 현재 구조: <div class="text__review">...<span class="text__number">1,234</span>
      // replace(/[^0-9]/g, ""): "1,234개" → "1234" 변환 (쉼표·한글 단위 제거)
      const reviewText = $(el).find(".text__review .text__number").first().text().replace(/[^0-9]/g, "")
        || $(el).find(".cnt_opinion").text().replace(/[^0-9]/g, "")
        || $(el).find(".review_cnt").text().replace(/[^0-9]/g, "");
      const reviews = parseInt(reviewText) || 0;

      // ── 용량/중량 파싱 ──
      // 상품명에서 "3kg", "30롤", "20개입" 같은 수량+단위 패턴 추출
      // 정규식: (숫자.소수점) + (공백 0~여러개) + (단위 키워드)
      // 첫 번째 매칭만 사용 → 상품명에 여러 숫자가 있어도(예: "신라면 120g 20개입") 첫 단위 우선
      // ※ 이 동작은 라면처럼 "내용량 g + 묶음 개수"가 둘 다 있는 케이스에서 단위가 g로 잡혀
      //    pricePerUnit이 g당 가격이 되는 한계가 있음 (현재는 수용)
      const volumeMatch = name.match(/(\d+(?:\.\d+)?)\s*(kg|g|ml|L|매|롤|개|팩|봉|장)/i);
      const volume = volumeMatch
        ? { amount: parseFloat(volumeMatch[1]), unit: volumeMatch[2] }
        : null;

      // ── 대용량 판별 ──
      // 단위별 "이 이상이면 일반 소비자가 대량 구매로 인식하는 경계선"
      //   g/ml: 2kg/2L 이상 (가정용 일반 사이즈의 약 2배)
      //   롤: 20롤 이상 (1~2달치 화장지)
      //   매: 60매 이상 (기저귀 한 팩 기준)
      //   개/팩/봉: 묶음 멀티팩 기준
      // 단위가 없거나 사전에 없는 값이면 기본값 1000 → 사실상 false로 작동
      const BULK_THRESHOLD = {
        g: 2000, kg: 2, ml: 2000, L: 2,
        매: 60, 롤: 20, 개: 20, 팩: 10, 봉: 10, 장: 30,
      };
      const isBulk = volume
        ? volume.amount >= (BULK_THRESHOLD[volume.unit] || 1000)
        : false;

      // 필수 필드(name + price > 0)가 있을 때만 결과에 포함
      // → 광고 슬롯, 빈 카드, 파싱 실패 항목을 자동 필터링
      if (name && price > 0) {
        products.push({
          // ID에 Date.now() 섞는 이유:
          //   같은 세션에서 두 번 검색하면 인덱스(i)가 0~9로 겹칠 수 있음
          //   → React key 중복으로 리렌더링 버그 발생
          //   타임스탬프를 붙여 동일 세션 내 절대 충돌 방지
          id: `danawa-${i}-${Date.now()}`,
          name,
          price,
          // 다나와 이미지 URL은 "//img.danawa.com/..." 같은 프로토콜-상대 형식이 흔함
          // → 그대로 <img src>에 넣으면 file:// 등으로 해석될 수 있어 https: 보강
          image: image.startsWith("//") ? `https:${image}` : image,
          rating,
          reviews,
          brand,
          badge: "",
          volume,
          // pricePerUnit: 단가 (1g당, 1매당 등). 용량 파싱 실패 시 null.
          // → 용량파 점수 계산의 핵심 값이라 null이면 GPT/로컬 모두 그 상품 제외 로직 탐
          pricePerUnit: volume ? Math.round(price / volume.amount) : null,
          // isPremium은 다나와에서는 직접 못 받음 → getProducts()에서 시장 평균 130% 기준으로 후처리
          isPremium: false,
          isBulk,
          source: "danawa",
        });
      }
    });

    console.log(`다나와 크롤링 결과: ${products.length}개`);
    return products;
  } catch (err) {
    // 네트워크/타임아웃/HTML 파싱 예외 모두 여기로
    // → 호출부(getProducts)가 빈 배열을 받으면 자동으로 mock 데이터 폴백
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
 *
 * 폴백 시 어느 카테고리의 mock 상품을 보여줄지 결정합니다.
 * category(카테고리 탭 클릭 시 label) 우선 → 없으면 keyword(자유 검색)에서 추출.
 *
 * 매칭 순서가 중요한 이유:
 *   "키친타올"에 "타올"이 들어가지 않아도 "키친"이 먼저 잡혀야 함.
 *   "조미김"은 "김"보다 먼저 매칭되도록 김 분기에서 함께 처리.
 *
 * 매칭 실패 시 "세제" 폴백:
 *   - README에 명시된 8개 카테고리 외 키워드를 사용자가 검색했을 때 도달 가능
 *   - 무성 폴백을 유지하는 이유: 데모 환경에서 빈 화면보다는 뭐라도 보이는 게 나음
 *   - 운영에서는 keyword whitelist 도입 또는 "검색 결과 없음" UI를 권장
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
  // category 라벨이 MOCK_DATA의 키와 정확히 일치하면 그대로 사용 (확장 여유)
  if (MOCK_DATA[category]) return category;
  // 매칭 실패: 최후 폴백 — 운영에선 console.warn으로 어떤 키워드가 누락됐는지 추적
  console.warn(`[mock fallback] 매칭 실패, 세제로 대체: keyword="${keyword}" category="${category}"`);
  return "세제";
}

/**
 * 메인 상품 조회 함수
 *
 * 동작 순서:
 *   1) 다나와 크롤링 시도
 *   2) 결과가 3개 미만이면 mock 폴백 (점수 분포를 만들기엔 최소 3개 필요)
 *   3) 시장 평균가 / 평균 단가 계산해 각 상품에 부가 지표 부여
 *   4) priceHistory 시뮬레이션해서 GPT 프롬프트에 넣을 "3달 최저가" 컨텍스트 제공
 *
 * @param {string} keyword  검색어 (크롤링에 사용)
 * @param {string} category 카테고리 라벨 (mock 폴백 키 결정에 사용)
 * @returns {Array} 점수 계산에 필요한 모든 필드가 채워진 상품 배열
 */
async function getProducts(keyword, category) {
  console.log(`다나와 크롤링 시작: ${keyword}`);
  let products = await crawlDanawa(keyword);

  // 결과가 3개 미만이면 폴백:
  //   - 0개: 크롤링 자체 실패(네트워크/HTML 변경)
  //   - 1~2개: 인기 없는 키워드로 다나와에 상품이 거의 없는 경우
  // 어느 쪽이든 점수 분포를 만들 신호가 부족하므로 mock으로 교체
  if (products.length < 3) {
    console.log("크롤링 데이터 부족, 목 데이터 사용");
    const mockKey = resolveMockCategory(keyword, category);
    console.log(`목 데이터 카테고리: ${mockKey}`);
    products = MOCK_DATA[mockKey].map(p => ({ ...p, source: "mock" }));
  }

  // ── 시장 기준선(market baseline) 계산 ──
  // 이 검색 결과의 평균을 "시장 평균"으로 정의 — 절대값(예: 카테고리 전체 평균)이 아닌
  // 검색 컨텍스트 내부의 상대 비교를 하는 이유:
  //   1) 다나와 결과는 sort=savePriceDesc로 받아 비슷한 가격대가 모임 → 비교가 의미 있음
  //   2) 카테고리 전역 평균을 쓰려면 DB가 필요 (현재 데모 범위 밖)
  // 이 평균은 isPremium(>130%) 판정과 GPT 프롬프트 context로 들어감
  const avgPrice = Math.round(
    products.reduce((s, p) => s + p.price, 0) / products.length
  );
  // pricePerUnit이 없는 상품(용량 파싱 실패)은 평균 계산에서 제외
  // → 분모에 0이 끼면 정확도가 깨지므로 유효 데이터만 가지고 평균 산출
  const withUnit = products.filter((p) => p.pricePerUnit);
  const avgPricePerUnit = withUnit.length > 0
    ? Math.round(withUnit.reduce((s, p) => s + p.pricePerUnit, 0) / withUnit.length)
    : 0;

  return products.map((p) => ({
    ...p,
    marketAvgPrice: avgPrice,
    marketAvgPricePerUnit: avgPricePerUnit,
    // isPremium: mock 데이터엔 사전 정의되어 있고, 다나와엔 false로 초기화되어 있어
    //   ?? 연산자로 "이미 값이 있으면 보존, 없으면 130% 룰로 계산"
    isPremium: p.isPremium ?? (p.price > avgPrice * 1.3),
    isBulk: p.isBulk ?? false,
    priceHistory: generatePriceHistory(p.price),
  }));
}

/**
 * 90일 가격 히스토리 시뮬레이션
 *
 * GPT 프롬프트와 가격 추이 차트에 사용되는 90일치 가격 데이터를 생성합니다.
 * 실제 가격 히스토리 DB가 없는 데모 환경의 한계를 메우기 위한 임시 데이터입니다.
 *
 * 한계 (README에도 명시):
 *   - 매 요청마다 Math.random()으로 새로 생성 → 같은 상품도 새로고침하면 "3달 최저가"가 바뀜
 *   - 실 서비스에서는 DB에 일별 가격을 누적해서 그대로 반환해야 함
 *
 * 생성 규칙:
 *   - 10일 간격으로 10개 데이터 포인트 + 오늘 가격 = 총 11개
 *   - 분포를 (Math.random() - 0.3)으로 잡아 평균이 현재가보다 약간 낮음
 *     → "현재가가 3달 최저가 근처"로 보일 확률을 약간 높여 데모에서 점수가 잘 나옴
 *   - ±15% 변동폭은 한국 생필품 가격 변동률을 참고한 경험치
 */
function generatePriceHistory(currentPrice) {
  const history = [];
  const now = Date.now();
  for (let i = 90; i >= 0; i -= 10) {
    // (Math.random() - 0.3): -0.3 ~ 0.7 범위 → 평균값 약 +0.2 (살짝 높은 쪽)
    // * 0.15: 최대 ±15% 이내 변동 (실제 가격 변동폭과 유사한 수준)
    // → 결과적으로 과거 가격이 평균적으로 현재가보다 약간 높게 생성됨
    //   → 오늘이 "최근 90일 중 저가권"으로 보여 데모 점수가 잘 분포됨
    const variance = (Math.random() - 0.3) * 0.15;
    history.push({
      // ISO 날짜의 앞부분만 떼서 "YYYY-MM-DD" 형식으로 저장 (시·분·초 불필요)
      date: new Date(now - i * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
      price: Math.round(currentPrice * (1 + variance)),
    });
  }
  // 오늘 가격은 무조건 정확한 현재가로 마무리 (마지막 포인트가 진짜 가격)
  history.push({ date: new Date().toISOString().split("T")[0], price: currentPrice });
  return history;
}

module.exports = { getProducts };
