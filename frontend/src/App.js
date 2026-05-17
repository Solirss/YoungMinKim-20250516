/**
 * App.js — 올웨이즈 메인 컴포넌트
 *
 * 이 파일의 책임:
 * 1. 유저의 상품 클릭/장바구니 담기 행동을 신호로 수집 → 성향(브랜드파/용량파/복합형) 실시간 판별
 * 2. 다나와 크롤링 결과를 백엔드에 요청하고 GPT 가성비 점수를 받아 ProductList에 전달
 * 3. 장바구니 상태와 드로어 UI 토글 관리
 *
 * 핵심 상태:
 * - userLog:   유저 행동 로그 (클릭할 때마다 누적, 새로고침 시 초기화 — 세션 단위)
 * - products:  현재 표시 중인 상품 목록 (백엔드 응답)
 * - cart:      장바구니 아이템 배열 ([{ ...product, qty }])
 *
 * 성향 판별 흐름 (핵심 데이터 플로우):
 *   상품 클릭/담기
 *      ↓
 *   updateLog(product)         — 5가지 신호(brand, premium, avgAbove, bulk, lowUnit) 누적
 *      ↓ (loggedSignals Set으로 같은 상품·같은 신호 중복 방지)
 *   userLog 업데이트
 *      ↓ (리렌더링)
 *   calcPersona(userLog)       — 가중치 합산 → "brand"|"volume"|"mixed"|"unknown" 결정
 *      ↓
 *   PersonaBadge / ProductList — 결과를 헤더 칩과 상품 점수 컨텍스트에 반영
 *
 * 백엔드와의 동기화:
 *   calcPersona()는 백엔드 scorer.js의 detectPersonaType()과 100% 동일한 로직.
 *   프론트가 직접 계산하는 이유: 클릭 즉시 PersonaBadge가 반응해야 UX가 자연스러워서.
 *   백엔드는 GPT 프롬프트의 성향 컨텍스트를 위해 자체적으로 다시 계산 (네트워크 단절 시에도 일관성).
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
// 생활용품 4종 + 음식 4종으로 균형 (이전에는 음식이 쌀 1개뿐이라 편향)
const CATEGORIES = [
  { label: "세제",     emoji: "🧴", keyword: "세제" },
  { label: "휴지",     emoji: "🧻", keyword: "화장지 30롤" },
  { label: "기저귀",   emoji: "👶", keyword: "기저귀 대형" },
  { label: "키친타올", emoji: "🍃", keyword: "키친타올" },
  { label: "쌀",       emoji: "🌾", keyword: "쌀 10kg" },
  { label: "라면",     emoji: "🍜", keyword: "라면 멀티팩" },
  { label: "생수",     emoji: "💧", keyword: "생수 2L" },
  { label: "김",       emoji: "🍙", keyword: "조미김" },
];

// 유저 행동 로그 초기값
//
// 각 필드의 의미와 신호 유형:
//   - clickedBrands / brandClickCounts: 브랜드 충성도 측정 (반복 브랜드 클릭 = 강한 브랜드파 신호)
//   - premiumClicks / avgAboveClicks: 브랜드파 신호 (고가 선호)
//   - bulkClicks / lowUnitPriceClicks: 용량파 신호 (대용량/저단가 선호)
//   - totalClicks: Cold Start 임계값 판별용 (3회 미만이면 "unknown" 반환)
//
// 평점 신호를 성향 판별에서 뺀 이유:
//   저단가 + 고평점 상품(자취생 인기템 등)이 흔해, 평점을 브랜드 신호로 쓰면
//   용량파 유저까지 brandScore가 쌓여 mixed/brand로 오분류됨.
//   평점은 GPT 점수 산출(scoreProductsWithGPT) 단계에서만 활용.
//
// 새로고침 시 초기화되는 점에 유의: 실 서비스에서는 로그인 + DB 저장으로 영속화 필요.
const INITIAL_LOG = {
  clickedBrands: [],      // 클릭한 고유 브랜드 목록 (Set처럼 중복 없이 누적) — GPT 프롬프트에 "선호 브랜드"로 전달
  brandClickCounts: {},   // { 브랜드명: 클릭횟수 } — 같은 브랜드 2회 이상 클릭 시 강한 신호로 카운트
  premiumClicks: 0,       // 시장 평균가 130% 이상 상품을 클릭한 횟수 (브랜드파 강신호 +2)
  avgAboveClicks: 0,      // 시장 평균가 이상 상품 클릭 횟수 — brand 필드가 비어있을 때의 보완 신호 (+1)
  bulkClicks: 0,          // 대용량(isBulk=true) 상품 클릭 횟수 — 다나와 결과에 대용량이 흔해 가중치 1로 평탄화
  lowUnitPriceClicks: 0,  // 시장 평균 단가의 80% 이하 상품 클릭 횟수 (용량파 강신호 +2)
  totalClicks: 0,         // 전체 클릭 수 — Cold Start 게이트(3회) 판별 및 디버깅에 사용
};

/**
 * 유저 행동 로그를 기반으로 성향을 판별합니다.
 *
 * 백엔드 scorer.js의 detectPersonaType()과 100% 동일한 산식.
 * 프론트가 별도 계산하는 이유: PersonaBadge가 클릭 즉시 업데이트되도록 (네트워크 라운드트립 X).
 *
 * ── 가중치 표 ──
 * 브랜드파 신호 (고가·브랜드 선호):
 *   +2  같은 브랜드 2번 이상 클릭        — 가장 강한 브랜드 충성도 신호
 *   +2  시장 평균가 130% 이상 상품 클릭  — 프리미엄 가격대 선호
 *   +1  시장 평균가 이상 상품 클릭       — brand 필드가 비어있을 때의 보완 신호
 *
 * 용량파 신호 (저단가·대용량 선호):
 *   +1  대용량(isBulk) 상품 클릭
 *       └─ 가중치를 1로 낮춘 이유: 다나와 결과의 70%+가 대용량으로 분류되어
 *          +2를 주면 거의 모든 유저가 용량파로 판별되는 문제가 있었음
 *   +2  시장 평균 단가의 80% 이하 상품 클릭 — 명확한 저단가 선호 신호
 *
 * 평점(highRating) 신호를 뺀 이유:
 *   저단가이면서 평점 높은 상품(깨끗한나라 60롤 등)이 흔해, 평점을 브랜드 신호로 두면
 *   용량파 유저의 brandScore까지 쌓여 mixed/brand로 오분류됨.
 *   평점은 GPT 점수 산출 단계(scoreProductsWithGPT)에서만 활용.
 *
 * 판정 로직:
 *   total = brandScore + volumeScore
 *   ratio = brandScore / total
 *   ratio >= 0.6 → "brand"  (브랜드 신호가 60% 이상)
 *   ratio <= 0.4 → "volume" (브랜드 신호가 40% 이하)
 *   그 사이      → "mixed"
 *
 * Cold Start:
 *   클릭 수 3회 미만이면 무조건 "unknown" 반환.
 *   가중치 합이 아닌 "실제 클릭 횟수" 기준인 이유:
 *     한 상품이 premium + bulk를 동시에 만족하면 1클릭에 3점이 쌓여
 *     성향이 즉시 활성화되는 문제가 있었음 → 최소 3개 다른 상품 클릭을 요구로 변경.
 */
function calcPersona(log) {
  const {
    brandClickCounts = {},
    premiumClicks = 0,
    avgAboveClicks = 0,
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
   *
   * key 형식: "productId:signalType" (예: "danawa-0-1747000000000:bulk")
   *
   * 왜 useRef인가:
   *   useState로 Set을 관리하면 추가/삭제마다 리렌더링이 발생 → 클릭 한 번에 6개 신호 추가 시
   *   불필요한 리렌더 6번 발생. ref는 값을 보존하면서 리렌더 트리거 X.
   *
   * 왜 "productId:signalType" 조합 키인가:
   *   초기 버전은 productId만 키로 썼는데, 한 번 클릭한 상품에 대해 다른 신호(rating, bulk 등)도
   *   모두 차단되는 버그가 있었음. signalType을 함께 묶어 신호별로 독립 dedup.
   *
   * 다른 상품을 클릭하면 새로운 productId라 신호가 다시 카운트됨 → 의도된 동작.
   */
  const loggedSignals = useRef(new Set());

  // userLog에서 실시간 파생 — 클릭할 때마다 자동 재계산
  const personaType = calcPersona(userLog);
  const logScore = calcLogProgress(userLog);
  const logsNeeded = Math.max(0, 3 - logScore); // 활성화까지 남은 점수

  /**
   * 상품 클릭 시 행동 신호를 userLog에 누적합니다.
   *
   * 동작 원리:
   *   - 한 번의 클릭으로 상품의 여러 신호(예: premium + avgAbove + bulk)가 동시에 카운트될 수 있음
   *   - 각 신호는 "productId:signalType" 키로 dedup → 같은 상품을 여러 번 눌러도 신호당 1회만 누적
   *   - totalClicks만 매번 +1 → Cold Start 게이트(3회) 카운팅의 근거
   *
   * changed 플래그를 두는 이유:
   *   - 이미 로그된 상품을 다시 누르면 신호는 늘지 않지만 setUserLog는 새 객체를 반환
   *   - 그러면 참조가 바뀌어 자식 컴포넌트들이 불필요하게 재렌더
   *   - changed=false면 prev를 그대로 반환해 React가 동일 참조로 감지하고 리렌더 스킵
   *
   * useCallback 의존성 빈 배열:
   *   - loggedSignals는 ref (값 변경 추적 불필요)
   *   - setUserLog는 setState (React가 stable 보장)
   *   → 의존성 없음, 컴포넌트 수명 동안 한 번만 생성
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

      // (평점 신호 의도적으로 미수집)
      // 저단가 + 고평점 상품이 흔해, 평점을 브랜드 신호로 두면 용량파가 mixed로 흘러감.
      // 평점은 백엔드 GPT 점수 산출에서만 활용 (product.rating은 그대로 전달됨).

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
   *
   * 백엔드에 userLog를 함께 보내는 이유:
   *   백엔드도 자체적으로 detectPersonaType()을 돌려 GPT 프롬프트의 성향 컨텍스트를 만듦.
   *   (프론트 calcPersona와 결과는 동일하지만, 백엔드가 GPT 호출 시 외부 의존성 없이 동작 가능)
   *
   * useCallback 의존성에 userLog가 들어가는 이유:
   *   매 호출 시 최신 userLog를 캡처해야 하므로 userLog가 바뀔 때마다 새 함수 생성 필요.
   *   (의존성을 빼면 클로저가 초기 빈 userLog를 영원히 캡처해서 백엔드에 매번 빈 로그가 감)
   *
   * 에러 메시지가 일반적인 이유:
   *   네트워크 실패/서버 5xx/4xx 모두 같은 메시지 — 사용자는 차이를 알 수 없고
   *   상세 노출은 보안상 부담. 디버깅 정보는 console.log로 남겨 개발자만 확인.
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

      // 디버깅용 로그
      //   "gpt"   → GPT API 정상 응답
      //   "local" → GPT 실패, 직관적 합산 알고리즘으로 폴백
      //   "none"  → Cold Start, 점수 산출 안 함
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
   *
   * 장바구니 담기도 카드 클릭과 동등한 "관심 신호"로 보고 행동 로그를 업데이트합니다.
   * (updateLog의 loggedSignals Set이 productId+signalType 단위 중복을 막아주므로,
   *  카드 클릭 후 같은 상품을 담아도 이중 카운트되지 않음)
   */
  const addToCart = useCallback((product) => {
    updateLog(product);
    setCart((prev) => {
      const existing = prev.find((i) => i.id === product.id);
      if (existing) {
        return prev.map((i) => i.id === product.id ? { ...i, qty: i.qty + 1 } : i);
      }
      return [...prev, { ...product, qty: 1 }];
    });
    setCartOpen(true);
  }, [updateLog]);

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
