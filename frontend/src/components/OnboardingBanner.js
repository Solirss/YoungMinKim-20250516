/**
 * OnboardingBanner.js — 초기 진입 안내 화면
 *
 * 검색 전(상품 목록이 없는 상태)에 표시됩니다.
 *
 * 두 가지 섹션으로 구성:
 * 1. 3단계 사용법 안내 + 빠른 시작 버튼
 * 2. 기존 이커머스 vs 올웨이즈 비교표
 *
 * Props:
 * - onCategoryClick: (cat: { keyword, label }) => void
 *   빠른 시작 버튼 클릭 시 해당 카테고리 검색 실행
 */

import React from "react";

// 빠른 시작 버튼 목록
// App.js의 CATEGORIES와 동일하게 8개 전체 노출 (생활용품 4 + 음식 4)
const QUICK_STARTS = [
  { label: "세제",     emoji: "🧴", keyword: "세제" },
  { label: "휴지",     emoji: "🧻", keyword: "화장지 30롤" },
  { label: "기저귀",   emoji: "👶", keyword: "기저귀 대형" },
  { label: "키친타올", emoji: "🍃", keyword: "키친타올" },
  { label: "쌀",       emoji: "🌾", keyword: "쌀 10kg" },
  { label: "라면",     emoji: "🍜", keyword: "라면 멀티팩" },
  { label: "생수",     emoji: "💧", keyword: "생수 2L" },
  { label: "김",       emoji: "🍙", keyword: "조미김" },
];

export default function OnboardingBanner({ onCategoryClick }) {
  return (
    <div className="onboarding">

      {/* ── 섹션 1: 사용법 안내 ── */}
      <div className="onboarding-card">
        {/* 3단계 흐름 안내 */}
        <div className="onboarding-steps">
          <div className="step">
            <span className="step-num">1</span>
            <div>
              <strong>상품 탐색</strong>
              <p>카테고리를 선택하거나 검색하세요</p>
            </div>
          </div>
          <div className="step-arrow">→</div>
          <div className="step">
            <span className="step-num">2</span>
            <div>
              <strong>AI 성향 분석</strong>
              <p>클릭 패턴으로 당신의 가성비 기준을 파악해요</p>
            </div>
          </div>
          <div className="step-arrow">→</div>
          <div className="step">
            <span className="step-num">3</span>
            <div>
              <strong>나만의 점수 활성화</strong>
              {/* 3번: Cold Start 임계값과 동기화 (calcPersona의 total < 3) */}
              <p>3번 클릭 후 개인화 가성비 점수가 켜져요</p>
            </div>
          </div>
        </div>

        {/* 빠른 시작 버튼: 클릭 시 바로 해당 카테고리 검색 */}
        <div className="quick-start">
          <p className="quick-label">빠른 시작</p>
          <div className="quick-pills">
            {QUICK_STARTS.map((cat) => (
              <button
                key={cat.label}
                className="quick-pill"
                // cat.keyword로 실제 다나와 검색, cat.label로 UI 표시
                onClick={() => onCategoryClick({ keyword: cat.keyword, label: cat.label })}
              >
                <span>{cat.emoji}</span>
                <span>{cat.label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── 섹션 2: 기존 이커머스 vs 올웨이즈 비교표 ──
          서비스의 핵심 차별점을 한눈에 보여주기 위한 표
          과제 1에서 정의한 "인지 비용의 혁신"을 시각화 */}
      <div className="comparison-table">
        <h3 className="comparison-title">기존 추천 vs 올웨이즈</h3>
        <table>
          <thead>
            <tr>
              <th>항목</th>
              <th>기존 이커머스</th>
              <th className="highlight-col">올웨이즈</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>제공 형태</td>
              <td>장황한 텍스트 설명</td>
              <td className="highlight-col">⚡ 가성비 00점 배지</td>
            </tr>
            <tr>
              <td>유저 경험</td>
              <td>읽고 해석하는 노동</td>
              <td className="highlight-col">🎯 0.1초 인지 제로</td>
            </tr>
            <tr>
              <td>심리적 효과</td>
              <td>"정말 싼 게 맞나?"</td>
              <td className="highlight-col">✅ "나한테 최고다"</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
