/**
 * index.js
 *
 * 올웨이즈 백엔드 Express 서버 진입점
 *
 * 엔드포인트:
 * - GET  /health         서버 상태 확인 (배포 플랫폼 헬스체크용)
 * - POST /api/products   상품 검색 + 가성비 점수 반환
 *
 * 환경변수 (.env):
 * - OPENAI_API_KEY   OpenAI API 키 (GPT-4o-mini 사용)
 * - PORT             서버 포트 (기본값: 4000)
 * - FRONTEND_URL     CORS 허용할 프론트엔드 URL
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { getProducts } = require("./crawler");
const { detectPersonaType, scoreProductsWithGPT } = require("./scorer");

const app = express();
const PORT = process.env.PORT || 4000;

// CORS 설정: 환경변수로 지정된 프론트엔드 URL만 허용 (미설정 시 전체 허용)
app.use(cors({
  origin: process.env.FRONTEND_URL || "*",
  methods: ["GET", "POST"],
}));
app.use(express.json());

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
 *   - scoreSource  {string}  점수 출처 ("gpt"|"local"|"none") — 디버깅용
 *   - products     {Array}   점수가 포함된 상품 배열
 *   - totalCount   {number}  반환된 상품 수
 */
app.post("/api/products", async (req, res) => {
  try {
    const { keyword, category, userLog } = req.body;

    if (!keyword) {
      return res.status(400).json({ error: "keyword is required" });
    }

    // 1. 쿠팡 크롤링 (실패 시 목 데이터 폴백)
    const products = await getProducts(keyword, category);

    // 2. 유저 행동 로그로 성향 판별
    const personaType = detectPersonaType(userLog || {});

    // 3. GPT로 가성비 점수 산출 (실패 시 로컬 계산 폴백)
    const { products: scoredProducts, scoreSource } = await scoreProductsWithGPT(
      products,
      userLog || {},
      personaType
    );

    // 서버 로그: 요청 내용과 점수 출처를 기록 (디버깅 용이)
    console.log(`[API] keyword=${keyword} persona=${personaType} scoreSource=${scoreSource} products=${scoredProducts.length}`);

    res.json({
      personaType,
      scoreSource,  // 프론트 콘솔에서 "gpt" 또는 "local"로 확인 가능
      products: scoredProducts,
      totalCount: scoredProducts.length,
    });

  } catch (err) {
    console.error("API 오류:", err);
    res.status(500).json({ error: "서버 오류가 발생했습니다." });
  }
});


/**
 * GET /api/debug-crawl?keyword=세제
 * 크롤링 원본 데이터 확인용 (개발 환경에서만 사용)
 */
app.get("/api/debug-crawl", async (req, res) => {
  const keyword = req.query.keyword || "세제";
  const products = await getProducts(keyword, keyword);
  res.json({ count: products.length, products });
});

app.listen(PORT, () => {
  console.log(`🚀 올웨이즈 백엔드 실행: http://localhost:${PORT}`);
});
