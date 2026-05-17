/**
 * App.js — 올웨이즈 메인 컴포넌트
 *
 * 이 파일이 하는 일:
 * 1. 유저의 상품 클릭 행동을 신호로 수집해 성향(브랜드파/용량파/복합형)을 실시간 판별
 * 2. 다나와 크롤링 결과를 백엔드에 요청하고 GPT 가성비 점수를 받아 화면에 표시
 * 3. 장바구니 상태 관리
 *
 * 핵심 상태:
 * - userLog: 유저 행동 로그 (클릭할 때마다 누적, 세션 동안 유지)
 * - products: 현재 표시 중인 상품 목록 (백엔드에서 받아온 데이터)
 * - cart: 장바구니 아이템 목록
 *
 * 성향 판별 흐름:
 * 상품 클릭 → updateLog() → userLog 업데이트 → calcPersona() 재계산 → PersonaBadge 실시간 반영
 */

import React, { useState, useCallback, useRef } from "react";
import "./App.css";
import ProductList from "./components/ProductList";
import SearchBar from "./components/SearchBar";
import PersonaBadge from "./components/PersonaBadge";
import OnboardingBanner from "./components/OnboardingBanner";
import Cart from "./components/Cart";

// 배포 시 환경변수로 백엔드 주소 주입
// 로컬 개발 시: package.json의 "proxy" 설정으로 /api/* 요청이 localhost:4000으로 자동 전달
const API_BASE = process.env.REACT_APP_API_URL || "";

// 카테고리 탭 목록
// keyword는 다나와 크롤링에 사용하는 실제 검색어 (label과 다를 수 있음)
const CATEGORIES = [
  { label: "세제",     emoji: "🧴", keyword: "세제" },
  { label: "휴지",     emoji: "🧻", keyword: "화장지 30롤" },
  { label: "기저귀",   emoji: "👶", keyword: "기저귀 대형" },
  { label: "쌀",       emoji: "🌾", keyword: "쌀 10kg" },
  { label: "키친타올", emoji: "🍃", keyword: "키친타올" },
];

// 유저 행동 로그 초기값
// 세션 시작 시 빈 상태에서 시작하고, 상품을 클릭할 때마다 해당 필드가 누적됨
const INITIAL_LOG = {
  clickedBrands: [],      // 클릭한 고유 브랜드 목록 (중복 없이)
  brandClickCounts: {},   // { 브랜드명: 클릭횟수 } — 같은 브랜드 반복 클릭 추적
  premiumClicks: 0,       // 시장 평균가 130% 이상 상품을 클릭한 횟수
  avgAboveClicks: 0,      // 시장 평균가 이상 상품 클릭 횟수 (brand 필드 없을 때 보완 신호)
  highRatingClicks: 0,    // 평점 4.7 이상 상품 클릭 횟수 (브랜드 신뢰도 직접 신호)
  bulkClicks: 0,          // 대용량 상품(isBulk) 클릭 횟수
  lowUnitPriceClicks: 0,  // 시장 평균 단가의 80% 이하 상품 클릭 횟수
  totalClicks: 0,         // 전체 클릭 수 (디버깅용)
};

/**
 * 유저 행동 로그를 기반으로 성향을 판별합니다.
 * 백엔드 detectPersonaType()과 동일한 로직을 프론트에서도 유지해
 * 헤더의 PersonaBadge가 클릭 즉시 업데이트되도록 합니다.
 *
 * 브랜드파 신호 (고가/브랜드 선호 행동):
 *   +2  같은 브랜드 2번 이상 클릭 (강한 브랜드 충성도 신호)
 *   +2  시장 평균가 130% 이상 상품 클릭 (프리미엄 선호)
 *   +2  고평점 상품 클릭 (평점 4.7 이상 — 브랜드 신뢰도 직접 신호)
 *   +1  시장 평균가 이상 상품 클릭 (보조 신호)
 *
 * 용량파 신호 (가격/단가 선호 행동):
 *   +1  대용량 상품 클릭 (가중치를 낮게 설정한 이유: 다나와 상품 대부분이 대용량이라
 *       가중치 2로 두면 모든 유저가 용량파로 분류되는 문제 발생)
 *   +2  시장 평균 단가의 80% 이하 상품 클릭 (명확한 저단가 선호 신호)
 *
 * Cold Start: 클릭한 상품 수가 3개 미만이면 "unknown" 반환 → 점수 배지 미노출
 * (가중치 합이 아닌 실제 클릭 수 기준 — 한 번 클릭만으로 활성화되는 문제 방지)
 */
function calcPersona(log) {
  const {
    brandClickCounts = {},
    premiumClicks = 0,
    avgAboveClicks = 0,
    highRatingClicks = 0,
    bulkClicks = 0,
    lowUnitPriceClicks = 0,
    totalClicks = 0,
  } = log;

  // Cold Start: 클릭 횟수 3회 미만이면 무조건 미판별
  // (가중치만 보면 1클릭에 프리미엄+벌크가 겹쳐 즉시 활성화되는 문제 방지)
  if (totalClicks < 3) return "unknown";

  // 같은 브랜드를 2번 이상 클릭한 브랜드의 수
  const repeatBrandClicks = Object.values(brandClickCounts).filter((c) => c >= 2).length;

  const brandScore =
    repeatBrandClicks * 2 +
    premiumClicks * 2 +
    highRatingClicks * 2 +  // 평점 신호 부활: 다나와 HTML에 평점이 있음을 재확인
    avgAboveClicks * 1;

  const volumeScore =
    bulkClicks * 1 +
    lowUnitPriceClicks * 2;

  const total = brandScore + volumeScore;
  if (total === 0) return "mixed"; // 신호 없으면 중립으로

  const ratio = brandScore / total;
  if (ratio >= 0.6) return "brand";   // 브랜드파: 60% 이상이 브랜드 신호
  if (ratio <= 0.4) return "volume";  // 용량파: 브랜드 신호가 40% 이하
  return "mixed";                      // 복합형: 그 사이
}

/**
 * 성향 활성화까지 남은 클릭 수 계산.
 * PersonaBadge의 "성향 분석 중 (N/3)" 표시에 사용.
 * 가중치 합이 아닌 실제 클릭한 상품 수를 반환.
 */
function calcLogProgress(log) {
  return Math.min(log.totalClicks || 0, 3);
}

export default function App() {
  // 상품 목록 — 백엔드 /api/products 응답값
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // 현재 활성화된 카테고리 탭 레이블 (스타일링용)
  const [activeCategory, setActiveCategory] = useState(null);
  const [searchKeyword, setSearchKeyword] = useState("");

  // 장바구니 상태 — [{ ...product, qty: number }]
  const [cart, setCart] = useState([]);
  const [cartOpen, setCartOpen] = useState(false);

  // 유저 행동 로그 — 세션 동안 누적, 새로고침 시 초기화
  // (실 서비스에서는 로그인 연동 + DB 저장 필요)
  const [userLog, setUserLog] = useState(INITIAL_LOG);

  /**
   * 중복 신호 방지용 Set
   * key 형식: "productId:signalType" (예: "danawa-0-123:bulk")
   *
   * useRef를 쓰는 이유: 리렌더링을 트리거하지 않고 값을 유지해야 하기 때문
   * useState로 하면 Set 업데이트마다 리렌더링 발생 → 성능 저하
   *
   * 이전 버그: productId 전체를 key로 쓰면 같은 상품의 다른 신호가 모두 차단됨
   * 수정: signalType을 포함한 "productId:signalType" 조합으로 신호별 독립 체크
   */
  const loggedSignals = useRef(new Set());

  // userLog에서 실시간 파생 — 클릭할 때마다 자동 재계산
  const personaType = calcPersona(userLog);
  const logScore = calcLogProgress(userLog);
  const logsNeeded = Math.max(0, 3 - logScore); // 활성화까지 남은 점수

  /**
   * 상품 클릭 시 행동 신호를 userLog에 누적합니다.
   *
   * 각 신호는 "productId:signalType" 키로 중복을 방지합니다.
   * 같은 상품을 여러 번 클릭해도 신호는 1회만 카운트됩니다.
   *
   * changed 플래그를 사용해 실제로 변경된 경우에만 상태를 업데이트합니다.
   * (불필요한 리렌더링 방지)
   *
   * useCallback 의존성 배열이 빈 이유:
   * loggedSignals는 ref라 의존성 불필요, setUserLog는 setState라 안정적
   */
  const updateLog = useCallback((product) => {
    setUserLog((prev) => {
      const next = { ...prev, totalClicks: prev.totalClicks + 1 };
      let changed = false;

      // ── 브랜드 클릭 신호 ──
      // brand 필드가 있는 상품을 클릭했을 때 브랜드명을 누적
      // brandClickCounts로 같은 브랜드 반복 클릭을 추적
      if (product.brand) {
        const key = `${product.id}:brand`;
        if (!loggedSignals.current.has(key)) {
          loggedSignals.current.add(key);
          // Set처럼 중복 없이 브랜드 추가
          next.clickedBrands = [...new Set([...prev.clickedBrands, product.brand])];
          next.brandClickCounts = {
            ...prev.brandClickCounts,
            [product.brand]: (prev.brandClickCounts[product.brand] || 0) + 1,
          };
          changed = true;
        }
      }

      // ── 프리미엄 상품 신호 ──
      // isPremium: 시장 평균가의 130% 이상 상품 (백엔드에서 계산)
      if (product.isPremium) {
        const key = `${product.id}:premium`;
        if (!loggedSignals.current.has(key)) {
          loggedSignals.current.add(key);
          next.premiumClicks = prev.premiumClicks + 1;
          changed = true;
        }
      }

      // ── 평균가 이상 클릭 신호 ──
      // 다나와 크롤링 상품에는 brand 필드가 없는 경우가 많아
      // "비싼 상품을 선택한다"는 행동으로 브랜드파 성향을 보완 감지
      if (product.marketAvgPrice && product.price >= product.marketAvgPrice) {
        const key = `${product.id}:avgAbove`;
        if (!loggedSignals.current.has(key)) {
          loggedSignals.current.add(key);
          next.avgAboveClicks = (prev.avgAboveClicks || 0) + 1;
          changed = true;
        }
      }

      // ── 고평점 신호 ──
      // 평점 4.7 이상 상품 클릭 → 브랜드 신뢰도 직접 신호
      // 다나와 HTML에서 평점이 정상 수집됨이 재확인되어 신호 복원
      if (product.rating && product.rating >= 4.7) {
        const key = `${product.id}:highRating`;
        if (!loggedSignals.current.has(key)) {
          loggedSignals.current.add(key);
          next.highRatingClicks = (prev.highRatingClicks || 0) + 1;
          changed = true;
        }
      }

      // ── 대용량 신호 ──
      // isBulk: 단위별 기준값 이상 (예: 세제 2L 이상, 화장지 20롤 이상)
      // 가중치를 1로 낮게 설정: 다나와 상품 대부분이 대용량이라
      // 가중치 2이면 클릭 1번만으로 용량파가 되어버리는 문제 방지
      if (product.isBulk) {
        const key = `${product.id}:bulk`;
        if (!loggedSignals.current.has(key)) {
          loggedSignals.current.add(key);
          next.bulkClicks = prev.bulkClicks + 1;
          changed = true;
        }
      }

      // ── 저단가 신호 ──
      // 시장 평균 단가의 80% 이하 상품을 선택 → 강한 용량파 신호
      // pricePerUnit: 상품 가격 / 용량 (예: 세제 1ml당 몇 원)
      // marketAvgPricePerUnit: 해당 카테고리 평균 단가
      if (
        product.pricePerUnit &&
        product.marketAvgPricePerUnit &&
        product.pricePerUnit < product.marketAvgPricePerUnit * 0.8
      ) {
        const key = `${product.id}:lowUnit`;
        if (!loggedSignals.current.has(key)) {
          loggedSignals.current.add(key);
          next.lowUnitPriceClicks = prev.lowUnitPriceClicks + 1;
          changed = true;
        }
      }

      // 변경이 없으면 기존 상태 그대로 반환 (불필요한 리렌더링 방지)
      return changed ? next : prev;
    });
  }, []);

  /**
   * 다나와 크롤링 + GPT 점수 요청
   * userLog를 함께 전송해 서버에서도 성향 기반 점수를 계산합니다.
   * useCallback: userLog가 바뀔 때만 함수 재생성 (의존성 최적화)
   */
  const fetchProducts = useCallback(async (keyword, category) => {
    setLoading(true);
    setError(null);
    setActiveCategory(category);
    try {
      const res = await fetch(`${API_BASE}/api/products`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keyword, category, userLog }),
      });
      if (!res.ok) throw new Error("서버 오류");
      const data = await res.json();
      setProducts(data.products);

      // 디버깅: 브라우저 콘솔에서 점수 출처 확인
      // scoreSource: "gpt" → GPT API 정상 응답
      // scoreSource: "local" → GPT 실패, 로컬 알고리즘 폴백
      // scoreSource: "none" → Cold Start, 점수 없음
      console.log(`[점수 출처] personaType: ${data.personaType}, scoreSource: ${data.scoreSource}`);
    } catch (e) {
      setError("상품을 불러오지 못했어요. 잠시 후 다시 시도해주세요.");
    } finally {
      setLoading(false);
    }
  }, [userLog]);

  // 검색창 제출 핸들러
  const handleSearch = (keyword) => {
    if (!keyword.trim()) return;
    setSearchKeyword(keyword);
    fetchProducts(keyword, keyword);
  };

  // 카테고리 탭 클릭 핸들러
  // cat.keyword로 검색하고 cat.label로 카테고리 표시
  const handleCategoryClick = (cat) => {
    setSearchKeyword(cat.label);
    fetchProducts(cat.keyword, cat.label);
  };

  // ── 장바구니 핸들러 ──

  /**
   * 상품을 장바구니에 추가합니다.
   * 이미 있는 상품이면 수량 +1, 없으면 qty: 1로 새로 추가.
   * 추가 즉시 카트 드로어를 엽니다.
   */
  const addToCart = useCallback((product) => {
    setCart((prev) => {
      const existing = prev.find((i) => i.id === product.id);
      if (existing) {
        return prev.map((i) => i.id === product.id ? { ...i, qty: i.qty + 1 } : i);
      }
      return [...prev, { ...product, qty: 1 }];
    });
    setCartOpen(true);
  }, []);

  // 장바구니에서 상품 제거
  const removeFromCart = useCallback(
    (id) => setCart((prev) => prev.filter((i) => i.id !== id)),
    []
  );

  // 장바구니 수량 조절 (최소 1, 0이 되면 자동 제거 없이 1 유지)
  const updateQty = useCallback((id, delta) => {
    setCart((prev) =>
      prev.map((i) => i.id === id ? { ...i, qty: Math.max(1, i.qty + delta) } : i)
    );
  }, []);

  // 상품 카드 클릭 → 행동 로그 업데이트
  const handleProductClick = useCallback((product) => {
    updateLog(product);
  }, [updateLog]);

  return (
    <div className="app">

      {/* ── 헤더 ──
          로고 + 성향 칩(PersonaBadge) + 장바구니 버튼
          PersonaBadge는 userLog가 업데이트될 때마다 자동으로 재렌더링됨 */}
      <header className="header">
        <div className="header-inner">
          <div className="logo">
            <span className="logo-mark">◈</span>
            <span className="logo-text">올웨이즈</span>
            <span className="logo-sub">AI 가성비</span>
          </div>
          <div className="header-right">
            {/* logScore: 현재 누적 가중치 합계, logsNeeded: 활성화까지 남은 점수 */}
            <PersonaBadge
              personaType={personaType}
              logScore={logScore}
              logsNeeded={logsNeeded}
            />
            {/* 장바구니 버튼: 아이템 있으면 총 수량 뱃지 표시 */}
            <button className="cart-btn" onClick={() => setCartOpen(true)}>
              🛒
              {cart.length > 0 && (
                <span className="cart-count">
                  {cart.reduce((s, i) => s + i.qty, 0)}
                </span>
              )}
            </button>
          </div>
        </div>
      </header>

      {/* ── 히어로 섹션 ──
          슬로건 + 검색창 */}
      <section className="hero">
        <div className="hero-inner">
          <p className="hero-eyebrow">당근에는 온도, 올웨이즈에는</p>
          <h1 className="hero-title">
            나만의<br />
            <span className="hero-accent">가성비 점수</span>
          </h1>
          <p className="hero-desc">
            AI가 내 쇼핑 패턴을 분석해<br />
            0.1초 만에 결제를 확신하게 합니다
          </p>
          <SearchBar
            onSearch={handleSearch}
            value={searchKeyword}
            onChange={setSearchKeyword}
          />
        </div>
      </section>

      {/* ── 카테고리 탭 ──
          activeCategory와 일치하는 탭에 "active" 클래스 적용 */}
      <nav className="categories">
        {CATEGORIES.map((cat) => (
          <button
            key={cat.label}
            className={`cat-pill ${activeCategory === cat.label ? "active" : ""}`}
            onClick={() => handleCategoryClick(cat)}
          >
            <span>{cat.emoji}</span>
            <span>{cat.label}</span>
          </button>
        ))}
      </nav>

      {/* ── 메인 컨텐츠 ──
          상태에 따라 온보딩 / 로딩 / 에러 / 상품 리스트 중 하나를 표시 */}
      <main className="main">

        {/* 초기 상태: 검색 전 온보딩 배너 */}
        {!products.length && !loading && (
          <OnboardingBanner onCategoryClick={handleCategoryClick} />
        )}

        {/* 로딩 상태: 스피너 + 현재 성향에 맞는 분석 중 메시지 */}
        {loading && (
          <div className="loading-state">
            <div className="spinner" />
            <p>다나와 상품 분석 중...</p>
            {/* 성향이 이미 판별된 경우 어떤 기준으로 분석 중인지 표시 */}
            {personaType !== "unknown" && (
              <p className="loading-sub">
                {personaType === "brand"
                  ? "🏷 브랜드 가격 추이 계산 중"
                  : personaType === "volume"
                  ? "📦 단위당 단가 비교 중"
                  : "⚖️ 복합 가성비 분석 중"}
              </p>
            )}
          </div>
        )}

        {/* 에러 상태 */}
        {error && <div className="error-state">{error}</div>}

        {/* 상품 리스트: 로딩 완료 + 상품 있을 때만 표시 */}
        {!loading && products.length > 0 && (
          <ProductList
            products={products}
            personaType={personaType}
            logsNeeded={logsNeeded}
            onProductClick={handleProductClick}
            onAddToCart={addToCart}
          />
        )}
      </main>

      {/* ── 장바구니 드로어 ──
          open prop으로 슬라이드 인/아웃 제어 */}
      <Cart
        open={cartOpen}
        items={cart}
        onClose={() => setCartOpen(false)}
        onRemove={removeFromCart}
        onUpdateQty={updateQty}
      />

      <footer className="footer">
        <p>© 2025 올웨이즈 · 데이터 출처: 다나와 · AI 점수는 행동 로그 기반입니다</p>
      </footer>
    </div>
  );
}
