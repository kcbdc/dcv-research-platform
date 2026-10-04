# Official Data Connectors — v0.5.8

## Case A: CBDC / public-payment validation

### BIS CPMI Red Book (`bis_cpmi`)
- Transport: BIS SDMX REST API (`stats.bis.org/api/v2`).
- Default Korea series:
  - total cashless-payment volume: `A.KR.N.A.A.Z.Z.A.A.Z.A.A`
  - total cashless-payment value: `A.KR.V.A.A.Z.Z.A.A.Z.A.A`
- Research role: external digital-payment environment covariate. It does **not** replace the historical-panel digital-adoption variable automatically.

### ECB Supervisory Banking Statistics (`ecb_supervisory`)
- Transport: ECB SDMX REST API (`data-api.ecb.europa.eu/service/data/SUP`).
- Defaults:
  - LCR, significant institutions total: `Q.B01.W0._Z.I3017._T.SII._Z._Z._Z.PCT.C`
  - CET1 ratio, significant institutions total: `Q.B01.W0._Z.I4008._T.SII._Z._Z._Z.PCT.C`
- Research role: external banking-system resilience/funding-liquidity validation covariates. These do **not** overwrite author-calibrated stability thresholds automatically.

### Bank of Korea ECOS (`bok_ecos`)
- Requires Worker secret `ECOS_API_KEY`.
- The shipped default (`722Y001`, item `0101000`) is a **connectivity/macro anchor**. It is not claimed to be the final payment-system calibration series.
- Configure the intended payment/settlement statistic code in the UI/API before using it as a substantive DCV input.

## Case B: fiscal/subsidy payment external-replication layer

### 열린재정 (`openfiscal`)
- Requires `OPENFISCAL_API_KEY` and a dataset-specific endpoint/configuration.
- Activated as `CONFIG_REQUIRED` until endpoint, row path, period field, and value field are specified.
- Public fiscal aggregates are environmental/contextual data. They do **not** provide case-level fraud/payment-stop ground truth by themselves.

### 보조금통합포털/e나라도움 (`bojo_openapi`)
- Requires `BOJO_API_KEY` and a selected JSON Open API endpoint.
- Activated as `CONFIG_REQUIRED` until endpoint and field mappings are supplied.
- Public budget/business/execution data are Case-B covariates. Human-review or administrative case labels must come from a separate authorized de-identified dataset.

## Evidence and revalidation
- Any changed official observation creates external-data evidence and starts incremental DCV revalidation from **MEASURE**.
- Unchanged refreshes do not create a new evidence revision.
- Case A and Case B are stored separately in `project_case_layers` and `official_observations.case_layer`.
- No official connector silently overwrites the 81-episode panel or a design parameter.

## CDRS mapping rules (v0.5.9)

### BIS CPMI → external digital-payment intensity (`D_CPMI`)
The connector collects total cashless-payment volume and fast-payment volume. The platform derives:

- `D_level`: percentile rank of `log(1 + total cashless volume)` inside the available BIS time series.
- `D_fast`: `fast payment volume / total cashless payment volume`, clipped to [0,1].
- `D_CPMI`: equal-weight mean of the components that are available.

CDRS runs the equal-weight value and the two component-only variants as external stress scenarios. This metric is an **independent validation proxy** and never overwrites `empirical_episodes.digital_adoption`.

### ECB supervisory data → external resilience (`R_ECB`)
Using the latest common observation period for LCR and CET1:

- `h_LCR = max(0, 1 - 100/LCR)`
- `h_CET1 = max(0, 1 - 4.5/CET1)`
- `R_ECB = mean(h_LCR, h_CET1)`
- `theta_ext = theta_low + (theta_high-theta_low) * R_ECB`

The 100% LCR and 4.5% CET1 values are regulatory minima used only as normalization anchors. `theta_ext` is bounded to the model's predeclared theta range and is an external stress-validation transform, not an estimate of Korea's theta. Component-only variants are retained for sensitivity analysis.


## v0.9.7 verified Korea connectors

### BOK ECOS
- Statistic table: `102Y004`
- Item: `ABA1` — 본원통화(평잔, 계절조정계열)
- Cycle: `M`
- Start: `200310`
- End: resolved from `StatisticItemList` (`END_TIME`) before `StatisticSearch`
- Secret: `ECOS_API_KEY`
- Research role: macro/context calibration; not direct payment-decision ground truth.

### OpenFiscal
- Endpoint: `https://openapi.openfiscaldata.go.kr/OPFI156`
- Query: `Key`, `Type=xml`, `pIndex`, `pSize`, `ACNT_YR`
- Row path: `/OPFI156/row`
- Fields: `ACNT_YR`, `BDG_FND_DIV_NM`, `ACNT_DIV_NM`, `SMOK_DIV_NM`, `SUM_NASS_TREV_BDG_AMT`
- Secret: `OPENFISCAL_API_KEY`
- Research role: `CONTEXTUAL_PUBLIC_PAYMENT`; not outcome-labelled FN/FP validation.
