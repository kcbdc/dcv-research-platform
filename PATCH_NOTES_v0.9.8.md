# v0.9.8 — Mobile Content Containment

- Empirical Calibration Registry, FDIC, Official Data Layers, External Validation Matrix/Funnel을 1400px 미만에서 단일 열로 강제.
- 긴 상태문구/설명/버튼이 viewport를 넓히지 않도록 min-width:0, max-width:100%, overflow-wrap 적용.
- report-view/pre는 모바일에서 줄바꿈하고 가로 페이지 확장을 차단.
- FDIC/Matrix 표만 자체 가로스크롤 유지.
- Funnel step은 부모 폭을 넘지 않고 모바일에서는 100% 폭으로 표시.
- ECOS/열린재정 설정 form은 모바일에서 1열로 재배치.
- CSS/JS cache key 0.9.8로 갱신.
- regression tests: 232/232 PASS.
