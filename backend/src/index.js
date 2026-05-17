/**
 * index.js
 *
 * 올웨이즈 백엔드 Express 서버 진입점
 *
 * 책임:
 * - 클라이언트(React)의 검색 요청을 받아 다나와 크롤링 → 성향 판별 → GPT 점수 산출까지
 *   파이프라인을 오케스트레이션하고 결과를 JSON으로 반환
 * - 외부 의존성(다나와 HTML, OpenAI API)의 실패에 대비해 각 단계마다 폴백을 보장
 *
 * 엔드포인트:
 * - GET  /health         배포 플랫폼(Render/Railway) 헬스체크용
 * - POST /api/products   상품 검색 + 가성비 점수 반환 (메인 API)
 * - GET  /api/debug-crawl 크롤링 원본 확인용 (개발 환경에서만 활성화)
 *
 * 환경변수 (.env):
 * - OPENAI_API_KEY   OpenAI API 키 (GPT-4o-mini 사용)
 * - PORT             서버 포트 (기본값: 4000)
 * - FRONTEND_URL     CORS 허용할 프론트엔드 URL (운영 환경에서는 반드시 설정)
 * - NODE_ENV         "production"이면 디버그 엔드포인트 비활성화
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { getProducts } = require("./crawler");
const { detectPersonaType, scoreProductsWithGPT } = require("./scorer");

const app = express();
const PORT = process.env.PORT || 4000;
const IS_PRODUCTION = process.env.NODE_ENV === "production";

// ── CORS 설정 ──
// 운영 환경: FRONTEND_URL이 반드시 설정되어 있어야 하며, 미설정 시 같은 origin만 허용(보안)
// 개발 환경: localhost CRA(3000번)와 직접 호출(Postman 등)을 위해 와일드카드 허용
// render.yaml에서 FRONTEND_URL을 envVar로 잡고 있으므로 운영에선 실질적으로 화이트리스트 동작
app.use(cors({
  origin: process.env.FRONTEND_URL || (IS_PRODUCTION ? false : "*"),
  methods: ["GET", "POST"],
}));

// JSON body 크기 제한 (10kb): userLog가 그대로 GPT 프롬프트에 들어가므로
// 거대한 페이로드가 토큰 폭증 및 메모리 부담을 일으키지 않도록 입력 단에서 차단
app.use(express.json({ limit: "10kb" }));

/**
 * GET /health
 * Render, Railway 등 배포 플랫폼의 헬스체크 요청에 응답
 */
app.get("/health", (req, res) => res.json({ status: "ok" }));

/**
 * POST /api/products
 *
 * 상품 검색, 유저 성향 판별, GPT 가성비 점수 산출을 수행하고 결과를 반환합니다.
 *
 * Request body:
 * @param {string} keyword   - 검색 키워드 (필수)
 * @param {string} category  - 카테고리 레이블 (목 데이터 매핑에 사용)
 * @param {Object} userLog   - 클라이언트에서 누적한 행동 로그
 *   @param {string[]} clickedBrands  - 클릭한 브랜드 목록
 *   @param {number}   viewedVolume   - 용량 조회 횟수
 *   @param {number}   clickedBulk    - 대용량 클릭 횟수
 *
 * Response:
 * @returns {Object}
 *   - personaType  {string}  판별된 성향 ("brand"|"volume"|"mixed"|"unknown")
 *   - scoreSource  {string}  점수 출처 ("gpt"|"error"|"none")
 *   - scoreError   {string?} scoreSource === "error" 일 때만 포함 — 사유 메시지
 *   - products     {Array}   상품 배열 (scoreSource가 "gpt"가 아니면 valueScore=null)
 *   - totalCount   {number}  반환된 상품 수
 */
app.post("/api/products", async (req, res) => {
  try {
    const { keyword, category, userLog } = req.body;

    // 입력 검증: keyword가 없으면 400 (다나와 검색 URL 자체가 만들어지지 않음)
    if (!keyword) {
      return res.status(400).json({ error: "keyword is required" });
    }

    // ── 1단계: 다나와 크롤링 ──
    // 다나와 HTML 파싱 실패하거나 결과가 3개 미만이면 자동으로 mock 데이터로 폴백
    // (crawler.js 내부에서 처리 — 호출부는 항상 정상 배열을 받는다고 가정 가능)
    const products = await getProducts(keyword, category);

    // ── 2단계: 유저 성향 판별 ──
    // userLog가 비어있어도 동작하도록 빈 객체로 디폴트 (Cold Start 케이스)
    // → totalClicks 0 → "unknown" 반환
    const personaType = detectPersonaType(userLog || {});

    // ── 3단계: GPT 가성비 점수 산출 ──
    // GPT API 실패 시 로컬 폴백 없이 scoreSource: "error"로 표시 (의도적 설계).
    // 화면을 비우는 대신, 점수 없는 상품 목록 + 에러 메시지를 함께 반환.
    const { products: scoredProducts, scoreSource, error: scoreError } = await scoreProductsWithGPT(
      products,
      userLog || {},
      personaType
    );

    // 서버 로그: 요청 키워드, 판별된 성향, 점수 출처, 결과 개수 기록
    // → Render 로그에서 GPT 실패율, 성향 분포 등을 관찰하는 데 사용
    console.log(`[API] keyword=${keyword} persona=${personaType} scoreSource=${scoreSource} products=${scoredProducts.length}`);

    res.json({
      personaType,                        // "brand"|"volume"|"mixed"|"unknown"
      scoreSource,                        // "gpt"|"error"|"none"
      ...(scoreError ? { scoreError } : {}), // GPT 실패 시에만 사유 포함
      products: scoredProducts,           // valueScore, scoreTooltip 포함 (gpt 실패 시 둘 다 null)
      totalCount: scoredProducts.length,
    });

  } catch (err) {
    // 예상치 못한 예외(크롤러 내부 throw, JSON.parse 실패 등)는 500으로 일괄 처리
    // 운영에서는 에러 상세를 노출하지 않고 한국어 메시지만 반환 (보안 + UX)
    console.error("API 오류:", err);
    res.status(500).json({ error: "서버 오류가 발생했습니다." });
  }
});


/**
 * GET /api/debug-crawl?keyword=세제
 *
 * 크롤링 원본 데이터를 GPT 점수 산출 없이 그대로 반환합니다.
 * 다나와 HTML 구조 변경으로 파싱이 깨졌을 때 어떤 필드가 비는지 확인하는 용도.
 *
 * 보안: NODE_ENV=production 일 때는 404로 응답해 외부에 노출되지 않게 차단.
 * (예전엔 노출되어 있어 누구나 다나와 트래픽을 우회 발생시킬 수 있었음)
 */
app.get("/api/debug-crawl", async (req, res) => {
  if (IS_PRODUCTION) {
    return res.status(404).json({ error: "Not found" });
  }
  const keyword = req.query.keyword || "세제";
  const products = await getProducts(keyword, keyword);
  res.json({ count: products.length, products });
});

app.listen(PORT, () => {
  console.log(`🚀 올웨이즈 백엔드 실행: http://localhost:${PORT}`);
});
