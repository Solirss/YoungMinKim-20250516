/**
 * SearchBar.js — 상품 검색창
 *
 * form 태그로 감싸서 Enter 키와 버튼 클릭 모두 검색 가능하게 합니다.
 * value와 onChange를 부모(App.js)에서 제어하는 controlled component 패턴.
 *
 * Props:
 * - onSearch: (keyword: string) => void — 검색 실행 콜백
 * - value: string — 현재 입력값 (부모가 관리)
 * - onChange: (value: string) => void — 입력값 변경 콜백
 */

import React from "react";

export default function SearchBar({ onSearch, value, onChange }) {
  // form submit 핸들러: 기본 동작(페이지 새로고침) 방지 후 검색 실행
  const handleSubmit = (e) => {
    e.preventDefault();
    onSearch(value);
  };

  return (
    <form className="search-form" onSubmit={handleSubmit}>
      <div className="search-inner">
        <span className="search-icon">🔍</span>
        <input
          className="search-input"
          type="text"
          placeholder="상품명 검색 (예: 세제, 기저귀, 휴지)"
          value={value}
          // onChange: 타이핑할 때마다 부모 상태 업데이트
          onChange={(e) => onChange(e.target.value)}
        />
        {/* type="submit"으로 Enter 키와 동일하게 동작 */}
        <button className="search-btn" type="submit">
          검색
        </button>
      </div>
    </form>
  );
}
