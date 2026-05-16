/**
 * PersonaBadge.js — 유저 성향 칩 (헤더 표시)
 *
 * 유저의 행동 로그가 쌓일수록 "성향 분석 중" → 성향 타입으로 전환됩니다.
 *
 * 상태별 표시:
 * - unknown: "성향 분석 중 (N/3)" + 깜빡이는 점 (Cold Start 상태)
 * - brand:   "🏷 브랜드 가치파 · 활성화 ✓"
 * - volume:  "📦 실속 용량파 · 활성화 ✓"
 * - mixed:   "⚖️ 복합 분석 · 활성화 ✓"
 *
 * Props:
 * - personaType: "unknown" | "brand" | "volume" | "mixed"
 * - logScore: 현재 누적 가중치 합계 (3 이상이면 성향 활성화)
 * - logsNeeded: 활성화까지 필요한 추가 점수 (안내 표시용)
 */

import React from "react";

export default function PersonaBadge({ personaType, logScore, logsNeeded }) {
  // Cold Start 상태: 아직 행동 로그가 충분히 쌓이지 않음
  if (personaType === "unknown") {
    return (
      <div className="persona-chip unknown">
        {/* 깜빡이는 점: 분석 중임을 시각적으로 표시 (CSS animation) */}
        <span className="chip-dot" />
        <span>성향 분석 중 ({logScore}/3)</span>
      </div>
    );
  }

  // 성향별 아이콘과 레이블
  const labels = {
    brand:  { icon: "🏷", text: "브랜드 가치파" },
    volume: { icon: "📦", text: "실속 용량파" },
    mixed:  { icon: "⚖️", text: "복합 분석" },
  };
  const label = labels[personaType] || labels.mixed;

  return (
    <div className={`persona-chip ${personaType}`}>
      <span>{label.icon}</span>
      <span>{label.text}</span>
      {/* 활성화 확인 표시 */}
      <span className="chip-active">활성화 ✓</span>
    </div>
  );
}
