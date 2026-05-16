/**
 * Cart.js — 장바구니 슬라이드 드로어
 *
 * 이 파일이 하는 일:
 * 1. 우측에서 슬라이드 인/아웃되는 드로어 UI
 * 2. 장바구니 아이템 목록 표시 (이미지, 이름, 가격, 가성비 점수)
 * 3. 수량 조절 (+/-) 및 개별 삭제
 * 4. 합계 금액 계산 및 표시
 *
 * open prop이 true이면 CSS transform으로 드로어를 화면에 표시
 * open prop이 false이면 translateX(100%)로 화면 밖으로 숨김
 *
 * Props:
 * - open: boolean — 드로어 열림/닫힘 상태
 * - items: [{ ...product, qty: number }] — 장바구니 아이템 배열
 * - onClose: () => void — 드로어 닫기 콜백
 * - onRemove: (id) => void — 아이템 삭제 콜백
 * - onUpdateQty: (id, delta) => void — 수량 변경 콜백 (delta: +1 또는 -1)
 */

import React from "react";

export default function Cart({ open, items, onClose, onRemove, onUpdateQty }) {
  // 장바구니 합계 금액: 각 아이템의 (가격 × 수량) 합산
  const total = items.reduce((sum, item) => sum + item.price * item.qty, 0);

  return (
    <>
      {/* 백드롭: 드로어 열렸을 때 배경 어둡게 + 클릭 시 닫힘 */}
      {open && <div className="cart-backdrop" onClick={onClose} />}

      {/* 드로어 본체
          open 상태에 따라 "open" 클래스 토글 → CSS transition으로 슬라이드 */}
      <div className={`cart-drawer ${open ? "open" : ""}`}>

        {/* 헤더: 타이틀 + 닫기 버튼 */}
        <div className="cart-header">
          <h2 className="cart-title">장바구니</h2>
          <button className="cart-close" onClick={onClose}>✕</button>
        </div>

        {/* 빈 장바구니 상태 */}
        {items.length === 0 ? (
          <div className="cart-empty">
            <span>🛒</span>
            <p>담긴 상품이 없어요</p>
          </div>
        ) : (
          <>
            {/* 아이템 목록 */}
            <ul className="cart-list">
              {items.map((item) => (
                <li key={item.id} className="cart-item">

                  {/* 상품 썸네일
                      이미지 없으면 상품명 첫 두 글자로 대체 */}
                  <div className="cart-item-img">
                    {item.image ? (
                      <img src={item.image} alt={item.name} />
                    ) : (
                      <span>{item.name.slice(0, 2)}</span>
                    )}
                  </div>

                  {/* 상품 정보: 이름, 총 가격, 가성비 점수 */}
                  <div className="cart-item-info">
                    <p className="cart-item-name">{item.name}</p>
                    {/* 총 가격 = 단가 × 수량 */}
                    <p className="cart-item-price">
                      {(item.price * item.qty).toLocaleString()}원
                    </p>
                    {/* 가성비 점수: 점수가 있을 때만 표시 */}
                    {item.valueScore && (
                      <span className="cart-item-score">
                        가성비 {item.valueScore}점
                      </span>
                    )}
                  </div>

                  {/* 수량 조절 + 삭제 버튼 */}
                  <div className="cart-item-controls">
                    {/* 수량 감소: App.js의 updateQty에서 최소 1 보장 */}
                    <button onClick={() => onUpdateQty(item.id, -1)}>−</button>
                    <span>{item.qty}</span>
                    <button onClick={() => onUpdateQty(item.id, 1)}>+</button>
                    {/* 삭제: 장바구니에서 완전 제거 */}
                    <button
                      className="cart-remove"
                      onClick={() => onRemove(item.id)}
                    >
                      🗑
                    </button>
                  </div>
                </li>
              ))}
            </ul>

            {/* 하단: 합계 금액 + 구매 버튼 */}
            <div className="cart-footer">
              <div className="cart-total">
                <span>합계</span>
                <span className="cart-total-price">
                  {total.toLocaleString()}원
                </span>
              </div>
              {/* 구매하기 버튼: 현재는 UI만 존재, 실제 결제 연동 미구현 */}
              <button className="cart-checkout">구매하기</button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
