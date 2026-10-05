# v0.9.9 Report Modal Mobile Presentation

## Fixed
- `자동 연구 보고서` heading collapsing into vertical one-character lines on narrow screens.
- Word/MD/원문/더보기/AI 재생성 controls competing for the same header row.
- Oversized generated manuscript title and cramped body margins on Samsung Internet / Chrome mobile.

## Changed
- Report header now uses a dedicated title row and action toolbar.
- Mobile report modal uses the full dynamic viewport height.
- Rendered report typography uses Korean-friendly line breaking and responsive heading sizes.
- Tables remain horizontally scrollable inside the report rather than widening the page.

## Verification
- `npm test`: 234/234 PASS.
- No database migration required.
