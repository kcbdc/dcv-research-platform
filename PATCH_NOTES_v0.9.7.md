# DCV Research Platform v0.9.7

## Dedicated ECOS + OpenFiscal connectors

- ECOS default series updated to BOK ECOS `102Y004` / monthly / `ABA1` (본원통화 평잔·계절조정계열).
- When `end_period=latest`, the connector first calls `StatisticItemList` and resolves the latest `END_TIME` for the requested item/cycle before calling `StatisticSearch`.
- OpenFiscal no longer requires manual `rows_path`, `period_path`, or `value_path` setup for the verified `OPFI156` service.
- Dedicated OPFI156 XML parser added for `/OPFI156/row` with `ACNT_YR`, `BDG_FND_DIV_NM`, `ACNT_DIV_NM`, `SMOK_DIV_NM`, and `SUM_NASS_TREV_BDG_AMT`.
- OpenFiscal uses `Key`, `Type=xml`, `pIndex`, `pSize<=1000`, and `ACNT_YR`; `account_year=latest` tries the current year and up to two prior years until data are found.
- OPFI156 pagination follows `list_total_count` and preserves the fiscal dimensions in `series_key` and payload.
- OpenFiscal remains contextual public-fiscal evidence only; it is not treated as payment-stop/fraud ground truth.

## Connection diagnostics

- Added admin endpoint: `POST /api/projects/:id/official-sources/test` for `bok_ecos` and `openfiscal`.
- UI adds `ECOS 연결 테스트` and `열린재정 연결 테스트` buttons.
- Status now reports whether `ECOS_API_KEY` / `OPENFISCAL_API_KEY` is configured without exposing the secret.
- Connection test shows fetched row count, first/last period and provider metadata/error codes.

## UI defaults

- ECOS defaults: `102Y004`, `M`, `200310`, `ABA1`, latest END_TIME auto-resolve.
- OpenFiscal defaults: `https://openapi.openfiscaldata.go.kr/OPFI156`, account year `latest`.
- Public asset cache version updated to `0.9.7`.

## Validation

- Full regression suite: **229 / 229 PASS**.
- Dedicated tests cover ECOS latest-period discovery and OPFI156 XML parsing/storage.
- No D1 schema migration is required for v0.9.7.
