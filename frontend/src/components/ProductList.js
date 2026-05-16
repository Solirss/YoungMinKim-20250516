/**
 * ProductList.js — 상품 목록 + 가성비 점수 배지
 *
 * 이 파일이 하는 일:
 * 1. 상품 카드 그리드 렌더링
 * 2. 가성비 점수 배지(ScoreBadge) 표시 — hover/tap 시 툴팁으로 점수 근거 표시
 * 3. 90일 가격 추이 미니 차트(PriceChart) 렌더링
 * 4. 성향 배너 — 현재 어떤 기준으로 점수를 계산했는지 유저에게 설명
 * 5. Cold Start 상태 안내 — 점수 대기중 🔒 표시
 */

import React, { useState } from "react";

/**
 * ScoreBadge — 가성비 점수 배지
 *
 * 점수 범위에 따라 색상과 아이콘이 달라집니다:
 *   85~99: 🔥 빨간색 (압도적 가성비)
 *   70~84: ✨ 주황색 (매우 좋은 가성비)
 *   50~69: 👍 초록색 (좋은 가성비)
 *    0~49: 💡 회색   (평범하거나 낮은 가성비)
 *
 * 툴팁 표시 방식:
 * - 데스크탑: hover 시 자동 표시 / 마우스 벗어나면 숨김
 * - 모바일: 탭(클릭) 시 표시 / 3초 후 자동 숨김
 *
 * Props:
 * - score: 0~99 점수 (null이면 컴포넌트 자체를 렌더링하지 않음)
 * - tooltip: 점수 근거 텍스트 (예: "최저가 대비 3% · 3달 최저가")
 * - personaType: 성향 타입 — 툴팁 아이콘 결정에 사용
 */
function ScoreBadge({ score, tooltip, personaType }) {
  const [showTip, setShowTip] = useState(false);

  // score가 없으면 렌더링하지 않음 (Cold Start 상태)
  if (score === null || score === undefined) return null;

  // 점수 구간별 아이콘과 색상 클래스 결정
  const tier =
    score >= 85 ? "🔥"
    : score >= 70 ? "✨"
    : score >= 50 ? "👍"
    : "💡";

  const color =
    score >= 85 ? "badge-fire"
    : score >= 70 ? "badge-great"
    : score >= 50 ? "badge-good"
    : "badge-ok";

  // 성향별 툴팁 아이콘
  const tipIcon =
    personaType === "brand" ? "🏷"
    : personaType === "volume" ? "📦"
    : "⚖️";

  return (
    <div
      className="badge-wrapper"
      // 데스크탑: hover로 툴팁 제어
      onMouseEnter={() => setShowTip(true)}
      onMouseLeave={() => setShowTip(false)}
      // 모바일: 탭으로 툴팁 토글, 3초 후 자동 숨김
      onClick={(e) => {
        e.stopPropagation(); // 상품 카드 클릭 이벤트가 함께 발생하는 것 방지
        setShowTip((v) => !v);
        setTimeout(() => setShowTip(false), 3000);
      }}
    >
      <div className={`score-badge ${color}`}>
        <span className="badge-score">{score}점</span>
        <span className="badge-icon">{tier}</span>
      </div>

      {/* tooltip이 있을 때만 표시 */}
      {showTip && tooltip && (
        <div className="tooltip">
          <span className="tooltip-label">{tipIcon}</span>
          {tooltip}
        </div>
      )}
    </div>
  );
}

/**
 * PriceChart — 90일 가격 추이 미니 SVG 차트
 *
 * priceHistory 배열을 받아 꺾은선 그래프를 그립니다.
 * 최저가/최고가를 기준으로 y축을 정규화합니다.
 *
 * 현재는 시뮬레이션 데이터를 사용하지만,
 * 실 서비스에서는 DB에 쌓인 실제 가격 이력으로 대체되어야 합니다.
 *
 * Props:
 * - history: [{ date: string, price: number }] 배열
 */
function PriceChart({ history }) {
  // 데이터가 2개 미만이면 차트를 그릴 수 없음
  if (!history || history.length < 2) return null;

  const prices = history.map((h) => h.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1; // 0 나눗셈 방지

  const w = 80; // SVG 가로 크기 (px)
  const h = 28; // SVG 세로 크기 (px)

  // 각 데이터 포인트를 SVG 좌표로 변환
  // x: 인덱스를 0~w 범위로 선형 매핑
  // y: 가격을 h~0 범위로 반전 매핑 (SVG는 위가 0이라 반전 필요)
  const points = history.map((item, i) => {
    const x = (i / (history.length - 1)) * w;
    const y = h - ((item.price - min) / range) * h;
    return `${x},${y}`;
  });

  return (
    <svg
      className="price-chart"
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
    >
      <polyline
        points={points.join(" ")}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * ProductList — 상품 목록 메인 컴포넌트
 *
 * Props:
 * - products: 백엔드에서 받은 상품 배열 (valueScore, scoreTooltip 포함)
 * - personaType: 현재 유저 성향 ("brand"|"volume"|"mixed"|"unknown")
 * - logsNeeded: 성향 활성화까지 남은 신호 수 (안내 메시지용)
 * - onProductClick: 상품 클릭 시 행동 로그 업데이트 콜백
 * - onAddToCart: 장바구니 추가 콜백
 */
export default function ProductList({
  products,
  personaType,
  logsNeeded,
  onProductClick,
  onAddToCart,
}) {
  // 성향별 배너 텍스트 매핑
  const personaLabel = {
    brand: {
      icon: "🏷",
      title: "브랜드 가치파 모드",
      desc: "선호 브랜드의 가격 타이밍 기준으로 점수를 계산했어요",
    },
    volume: {
      icon: "📦",
      title: "실속 용량파 모드",
      desc: "단위당 단가가 시장 평균보다 얼마나 저렴한지 계산했어요",
    },
    mixed: {
      icon: "⚖️",
      title: "복합 분석 모드",
      desc: "브랜드와 용량 모두 고려해 균형 잡힌 가성비를 계산했어요",
    },
  };
  const persona = personaLabel[personaType]; // unknown이면 undefined → 배너 미표시

  return (
    <div className="product-section">

      {/* 성향 배너: 성향이 판별된 경우에만 표시 */}
      {persona && (
        <div className={`persona-banner ${personaType}`}>
          <span className="persona-icon">{persona.icon}</span>
          <div>
            <strong>{persona.title}</strong>
            <span>{persona.desc}</span>
          </div>
        </div>
      )}

      {/* Cold Start 안내: 아직 성향 미판별 상태에서만 표시 */}
      {logsNeeded > 0 && personaType === "unknown" && (
        <p className="log-hint">
          상품을 {logsNeeded}번 더 클릭하면 나만의 가성비 점수가 활성화돼요
        </p>
      )}

      {/* 상품 카드 그리드 */}
      <ul className="product-list">
        {products.map((product) => (
          <li
            key={product.id}
            className="product-card"
            // 카드 전체 클릭 → 행동 로그 업데이트 (장바구니 버튼 제외)
            onClick={() => onProductClick(product)}
          >
            {/* 상품 이미지 영역
                이미지가 없으면 상품명 첫 두 글자를 플레이스홀더로 표시 */}
            <div className="product-img-wrap">
              {product.image ? (
                <img
                  src={product.image}
                  alt={product.name}
                  className="product-img"
                />
              ) : (
                <div className="product-img-placeholder">
                  {product.name.slice(0, 2)}
                </div>
              )}
              {/* 판매 쇼핑몰명 뱃지 (다나와에서 크롤링한 mallName) */}
              {product.badge && (
                <span className="rocket-badge">{product.badge}</span>
              )}
            </div>

            {/* 상품 정보 영역 */}
            <div className="product-info">
              {/* 브랜드명 — 다나와 크롤링 상품은 비어있을 수 있음 */}
              <p className="product-brand">{product.brand}</p>
              <p className="product-name">{product.name}</p>

              {/* 메타 정보: 평점(있을 때만) + 단위당 단가(용량 정보 있을 때만) */}
              <div className="product-meta">
                {/* 다나와 크롤링은 rating이 0이라 표시 안 됨 */}
                {product.rating > 0 && (
                  <span className="rating">
                    ★ {product.rating.toFixed(1)}
                    <span className="review-count">
                      ({product.reviews?.toLocaleString()})
                    </span>
                  </span>
                )}
                {/* 단위당 단가: 용량 정보가 파싱된 상품만 표시
                    예: "ml당 4원", "매당 415원" */}
                {product.pricePerUnit && product.volume && (
                  <span className="unit-price">
                    {product.volume.unit}당{" "}
                    {product.pricePerUnit.toLocaleString()}원
                  </span>
                )}
              </div>

              {/* 하단 영역: 가격 + 가격 차트 + 가성비 점수 배지 */}
              <div className="product-bottom">
                <div className="price-area">
                  <span className="product-price">
                    {product.price?.toLocaleString()}원
                  </span>
                  {/* 90일 가격 추이 미니 차트 */}
                  <PriceChart history={product.priceHistory} />
                </div>

                {/* 가성비 점수 배지
                    - 점수 있음: ScoreBadge 표시
                    - 점수 없음(Cold Start): 🔒 대기중 표시 */}
                {product.valueScore !== null &&
                product.valueScore !== undefined ? (
                  <ScoreBadge
                    score={product.valueScore}
                    tooltip={product.scoreTooltip}
                    personaType={personaType}
                  />
                ) : (
                  <div
                    className="score-hidden"
                    title="상품을 더 클릭하면 점수가 표시돼요"
                  >
                    <span>점수 대기중</span>
                    <span>🔒</span>
                  </div>
                )}
              </div>

              {/* 장바구니 담기 버튼
                  e.stopPropagation(): 카드 클릭 이벤트와 겹치지 않도록 */}
              <button
                className="add-to-cart-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onAddToCart(product);
                }}
              >
                + 장바구니 담기
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
