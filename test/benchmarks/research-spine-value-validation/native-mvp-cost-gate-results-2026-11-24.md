# Native MVP cost-gate acceptance · 2026-11-24

The projection uses an estimated history threshold of 1,500 tokens, estimated savings of at least 1,500 tokens and at least 10% compression. The live experiment uses six recent messages and the controlled experiment uses four. All arms use fresh workspaces, and paired order alternates. Usage comes from the model endpoint. The controlled endpoint scripts replies and synthesizes usage. See the benchmark README for reproduction commands.

The 10-pair live comparison missed both acceptance gates. All 20 executions stopped naturally. Projection passed 9/10 and Dynamic passed 10/10 after whole-batch revalidation corrected three report-parser false positives. Pair 8 Projection wrote `None rows x None columns` because a report rewrite used field names absent from the phase 1 output. That failure remains in the paired results and all metrics. Live total tokens increased 8.90% and P95 duration increased 36.03%. The controlled test showed the mechanical input reduction. Default context assembly remains Dynamic.

The benchmark-only artifact feedback run uses the same validation feedback for both modes. It is a separate configuration with its own results. That feedback leaves the final artifact validation and model stop checks in place.

Raw logs and artifacts are generated locally in the benchmark's ignored `logs` directory. The tables below are reproduced by `report-paired.py` from the raw manifests and the model input traces.

## Native MVP cost-gate evidence · controlled-native-mvp-phase2-cost-gate-r3

Model `controlled-stub`.

| Mode | E2E PASS | Natural stop | Valid complete artifact sets |
|---|---:|---:|---:|
| dynamic | 5/5 | 5/5 | 5/5 |
| shadow | 5/5 | 5/5 | 5/5 |
| projection | 5/5 | 5/5 | 5/5 |

Independent cleaned-cohort recomputation for `dynamic` matched 5/5.

Independent cleaned-cohort recomputation for `shadow` matched 5/5.

Independent cleaned-cohort recomputation for `projection` matched 5/5.

Provider-reported usage events 75/75.

| Metric | Dynamic mean | Projection mean | Change | Dynamic P50 / P95 | Projection P50 / P95 |
|---|---:|---:|---:|---:|---:|
| Input tokens | 30,317.20 | 28,314.00 | -6.61% | 30,318.00 / 30,318.00 | 28,314.00 / 28,314.00 |
| Output tokens | 156.00 | 156.00 | +0.00% | 156.00 / 156.00 | 156.00 / 156.00 |
| Total tokens | 30,473.20 | 28,470.00 | -6.57% | 30,474.00 / 30,474.00 | 28,470.00 / 28,470.00 |
| Model turns | 5.00 | 5.00 | +0.00% | 5.00 / 5.00 | 5.00 / 5.00 |
| Tool calls | 4.00 | 4.00 | +0.00% | 4.00 / 4.00 | 4.00 / 4.00 |
| Duration (ms) | 423.80 | 412.20 | -2.74% | 401.00 / 491.80 | 413.00 / 421.20 |

Percentiles use linear interpolation. D → P is Dynamic → Projection.

| Pair | E2E D / P | Input D → P | Output D → P | Total D → P | Δ total | Turns D → P | Tools D → P | Seconds D → P |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | PASS / PASS | 30,314 → 28,314 | 156 → 156 | 30,470 → 28,470 | -2,000 | 5 → 5 | 4 → 4 | 0.51 → 0.41 |
| 2 | PASS / PASS | 30,318 → 28,314 | 156 → 156 | 30,474 → 28,470 | -2,004 | 5 → 5 | 4 → 4 | 0.43 → 0.41 |
| 3 | PASS / PASS | 30,318 → 28,314 | 156 → 156 | 30,474 → 28,470 | -2,004 | 5 → 5 | 4 → 4 | 0.40 → 0.42 |
| 4 | PASS / PASS | 30,318 → 28,314 | 156 → 156 | 30,474 → 28,470 | -2,004 | 5 → 5 | 4 → 4 | 0.38 → 0.40 |
| 5 | PASS / PASS | 30,318 → 28,314 | 156 → 156 | 30,474 → 28,470 | -2,004 | 5 → 5 | 4 → 4 | 0.40 → 0.41 |

Input-token improvements in 5/5 pairs. Total-token improvements in 5/5 pairs.

- `shadow` had 25 gate records, 5 admitted candidates and 0 applications visible in model input across 0/5 runs. Missing projection records on 0 context traces.
- `shadow` skip reasons `{'short_history': 10, 'below_savings_threshold': 10}`.
- `shadow` mean candidate savings 1,318.27 estimated history tokens per evaluated turn, excluding short histories.
- `projection` had 25 gate records, 5 admitted candidates and 5 applications visible in model input across 5/5 runs. Missing projection records on 0 context traces.
- `projection` skip reasons `{'short_history': 10, 'below_savings_threshold': 10}`.
- `projection` mean candidate savings 1,318.33 estimated history tokens per evaluated turn, excluding short histories.
- `projection` mean applied savings 3,960.00 estimated history tokens per application. Compression P50/P95/max 28.09% / 28.09% / 28.09%.

### projection trajectory after first model-visible projection

| Pair | First projected turn (1-based) | Model turns including and after it | Tool calls including and after it |
|---|---:|---:|---:|
| 1 | 4 | 2 | 1 |
| 2 | 4 | 2 | 1 |
| 3 | 4 | 2 | 1 |
| 4 | 4 | 2 | 1 |
| 5 | 4 | 2 | 1 |


Source `results.json` and per-run `context-traces`, benchmark directory `controlled-native-mvp-phase2-cost-gate-r3`.

## Native MVP cost-gate evidence · live-native-mvp-phase2-cost-gate-r1

Model `DeepSeek-V4.1-Flash-1017`.

| Mode | E2E PASS | Natural stop | Valid complete artifact sets |
|---|---:|---:|---:|
| dynamic | 3/3 | 3/3 | 3/3 |
| projection | 3/3 | 3/3 | 3/3 |

Independent cleaned-cohort recomputation for `dynamic` matched 3/3.

Independent cleaned-cohort recomputation for `projection` matched 3/3.

Provider-reported usage events 37/37.

| Metric | Dynamic mean | Projection mean | Change | Dynamic P50 / P95 | Projection P50 / P95 |
|---|---:|---:|---:|---:|---:|
| Input tokens | 29,271.67 | 42,260.33 | +44.37% | 27,047.00 / 33,226.40 | 38,168.00 / 49,960.70 |
| Output tokens | 3,856.33 | 6,357.00 | +64.85% | 3,410.00 / 5,062.40 | 6,720.00 / 7,731.60 |
| Total tokens | 33,128.00 | 48,617.33 | +46.76% | 30,457.00 / 38,288.80 | 44,062.00 / 57,609.70 |
| Model turns | 5.33 | 7.00 | +31.25% | 5.00 / 5.90 | 7.00 / 7.90 |
| Tool calls | 4.33 | 6.00 | +38.46% | 4.00 / 4.90 | 6.00 / 6.90 |
| Duration (ms) | 100,110.67 | 129,185.00 | +29.04% | 105,023.00 / 106,106.60 | 120,196.00 / 156,138.40 |

Percentiles use linear interpolation. D → P is Dynamic → Projection.

| Pair | E2E D / P | Input D → P | Output D → P | Total D → P | Δ total | Turns D → P | Tools D → P | Seconds D → P |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | PASS / PASS | 26,855 → 38,168 | 2,913 → 4,507 | 29,768 → 42,675 | +12,907 | 5 → 7 | 4 → 6 | 89.08 → 120.20 |
| 2 | PASS / PASS | 27,047 → 51,271 | 3,410 → 7,844 | 30,457 → 59,115 | +28,658 | 5 → 8 | 4 → 7 | 106.23 → 160.13 |
| 3 | PASS / PASS | 33,913 → 37,342 | 5,246 → 6,720 | 39,159 → 44,062 | +4,903 | 6 → 6 | 5 → 5 | 105.02 → 107.23 |

Input-token improvements in 0/3 pairs. Total-token improvements in 0/3 pairs.

- `projection` had 21 gate records, 7 admitted candidates and 7 applications visible in model input across 3/3 runs. Missing projection records on 0 context traces.
- `projection` skip reasons `{'short_history': 9, 'below_savings_threshold': 5}`.
- `projection` mean candidate savings 2,019.50 estimated history tokens per evaluated turn, excluding short histories.
- `projection` mean applied savings 3,125.71 estimated history tokens per application. Compression P50/P95/max 24.42% / 34.82% / 36.66%.

### projection trajectory after first model-visible projection

| Pair | First projected turn (1-based) | Model turns including and after it | Tool calls including and after it |
|---|---:|---:|---:|
| 1 | 6 | 2 | 1 |
| 2 | 6 | 3 | 2 |
| 3 | 5 | 2 | 1 |


Source `results-revalidated.json` and per-run `context-traces`, benchmark directory `live-native-mvp-phase2-cost-gate-r1`.

## Native MVP cost-gate evidence · live-native-mvp-phase2-cost-gate-10pair

Model `DeepSeek-V4.1-Flash-1017`.

| Mode | E2E PASS | Natural stop | Valid complete artifact sets |
|---|---:|---:|---:|
| dynamic | 10/10 | 10/10 | 10/10 |
| projection | 9/10 | 10/10 | 9/10 |

Independent cleaned-cohort recomputation for `dynamic` matched 10/10.

Independent cleaned-cohort recomputation for `projection` matched 10/10.

Provider-reported usage events 128/128.

Reported metrics include every run. A run that stopped naturally can still fail artifact validation.

| Metric | Dynamic mean | Projection mean | Change | Dynamic P50 / P95 | Projection P50 / P95 |
|---|---:|---:|---:|---:|---:|
| Input tokens | 35,661.90 | 38,614.90 | +8.28% | 33,957.00 / 46,552.40 | 35,210.50 / 56,389.15 |
| Output tokens | 4,873.90 | 5,529.60 | +13.45% | 5,023.50 / 6,288.25 | 5,385.50 / 8,201.50 |
| Total tokens | 40,535.80 | 44,144.50 | +8.90% | 38,846.00 / 52,840.65 | 40,739.50 / 64,415.15 |
| Model turns | 6.10 | 6.70 | +9.84% | 6.00 / 7.55 | 6.00 / 9.10 |
| Tool calls | 5.10 | 5.70 | +11.76% | 5.00 / 6.55 | 5.00 / 8.10 |
| Duration (ms) | 124,301.00 | 139,107.40 | +11.91% | 119,228.50 / 189,016.60 | 127,354.00 / 257,112.85 |

Percentiles use linear interpolation. D → P is Dynamic → Projection.

| Pair | E2E D / P | Input D → P | Output D → P | Total D → P | Δ total | Turns D → P | Tools D → P | Seconds D → P |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | PASS / PASS | 27,745 → 28,389 | 4,464 → 3,691 | 32,209 → 32,080 | -129 | 5 → 5 | 4 → 4 | 76.45 → 48.61 |
| 2 | PASS / PASS | 27,156 → 36,189 | 3,958 → 5,246 | 31,114 → 41,435 | +10,321 | 5 → 6 | 4 → 5 | 66.14 → 72.79 |
| 3 | PASS / PASS | 45,096 → 32,997 | 6,005 → 5,341 | 51,101 → 38,338 | -12,763 | 7 → 6 | 6 → 5 | 99.82 → 101.08 |
| 4 | PASS / PASS | 43,415 → 34,938 | 5,164 → 5,452 | 48,579 → 40,390 | -8,189 | 7 → 6 | 6 → 5 | 162.01 → 112.50 |
| 5 | PASS / PASS | 32,935 → 33,159 | 5,402 → 4,305 | 38,337 → 37,464 | -873 | 6 → 6 | 5 → 5 | 166.49 → 137.95 |
| 6 | PASS / PASS | 33,442 → 65,782 | 3,840 → 10,150 | 37,282 → 75,932 | +38,650 | 6 → 10 | 5 → 9 | 118.22 → 330.78 |
| 7 | PASS / PASS | 27,413 → 35,483 | 3,009 → 5,606 | 30,422 → 41,089 | +10,667 | 5 → 6 | 4 → 5 | 101.31 → 148.35 |
| 8 | PASS / FAIL | 34,472 → 44,909 | 4,883 → 5,430 | 39,355 → 50,339 | +10,984 | 6 → 8 | 5 → 7 | 124.89 → 155.18 |
| 9 | PASS / PASS | 37,201 → 31,734 | 5,494 → 4,255 | 42,695 → 35,989 | -6,706 | 6 → 6 | 5 → 5 | 120.23 → 116.76 |
| 10 | PASS / PASS | 47,744 → 42,569 | 6,520 → 5,820 | 54,264 → 48,389 | -5,875 | 8 → 8 | 7 → 7 | 207.44 → 167.07 |

Input-token improvements in 4/10 pairs. Total-token improvements in 6/10 pairs.

- `projection` had 67 gate records, 20 admitted candidates and 20 applications visible in model input across 10/10 runs. Missing projection records on 0 context traces.
- `projection` skip reasons `{'short_history': 31, 'below_savings_threshold': 16}`.
- `projection` mean candidate savings 1,672.83 estimated history tokens per evaluated turn, excluding short histories.
- `projection` mean applied savings 2,621.75 estimated history tokens per application. Compression P50/P95/max 25.70% / 34.97% / 39.61%.

### projection trajectory after first model-visible projection

| Pair | First projected turn (1-based) | Model turns including and after it | Tool calls including and after it |
|---|---:|---:|---:|
| 1 | 5 | 1 | 0 |
| 2 | 5 | 2 | 1 |
| 3 | 6 | 1 | 0 |
| 4 | 6 | 1 | 0 |
| 5 | 5 | 2 | 1 |
| 6 | 6 | 5 | 4 |
| 7 | 6 | 1 | 0 |
| 8 | 6 | 3 | 2 |
| 9 | 5 | 2 | 1 |
| 10 | 6 | 3 | 2 |


- `08-projection-af616e02` failed. final report does not state 60 raw rows, final report does not state 10 raw columns, final report does not state one duplicate subject See its `summary.json` and `events.jsonl`.

Source `results-revalidated-v2.json` and per-run `context-traces`, benchmark directory `live-native-mvp-phase2-cost-gate-10pair`.

## Native MVP cost-gate evidence · controlled-native-mvp-phase2-cost-gate-artifact-feedback

Model `controlled-stub`.

| Mode | E2E PASS | Natural stop | Valid complete artifact sets |
|---|---:|---:|---:|
| dynamic | 5/5 | 5/5 | 5/5 |
| shadow | 5/5 | 5/5 | 5/5 |
| projection | 5/5 | 5/5 | 5/5 |

Independent cleaned-cohort recomputation for `dynamic` matched 5/5.

Independent cleaned-cohort recomputation for `shadow` matched 5/5.

Independent cleaned-cohort recomputation for `projection` matched 5/5.

Provider-reported usage events 75/75.

| Metric | Dynamic mean | Projection mean | Change | Dynamic P50 / P95 | Projection P50 / P95 |
|---|---:|---:|---:|---:|---:|
| Input tokens | 30,731.60 | 28,707.00 | -6.59% | 30,733.00 / 30,733.00 | 28,707.00 / 28,707.00 |
| Output tokens | 156.00 | 156.00 | +0.00% | 156.00 / 156.00 | 156.00 / 156.00 |
| Total tokens | 30,887.60 | 28,863.00 | -6.55% | 30,889.00 / 30,889.00 | 28,863.00 / 28,863.00 |
| Model turns | 5.00 | 5.00 | +0.00% | 5.00 / 5.00 | 5.00 / 5.00 |
| Tool calls | 4.00 | 4.00 | +0.00% | 4.00 / 4.00 | 4.00 / 4.00 |
| Duration (ms) | 448.40 | 439.80 | -1.92% | 446.00 / 499.20 | 437.00 / 468.60 |

Percentiles use linear interpolation. D → P is Dynamic → Projection.

| Pair | E2E D / P | Input D → P | Output D → P | Total D → P | Δ total | Turns D → P | Tools D → P | Seconds D → P |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | PASS / PASS | 30,726 → 28,707 | 156 → 156 | 30,882 → 28,863 | -2,019 | 5 → 5 | 4 → 4 | 0.51 → 0.45 |
| 2 | PASS / PASS | 30,733 → 28,707 | 156 → 156 | 30,889 → 28,863 | -2,026 | 5 → 5 | 4 → 4 | 0.42 → 0.42 |
| 3 | PASS / PASS | 30,733 → 28,707 | 156 → 156 | 30,889 → 28,863 | -2,026 | 5 → 5 | 4 → 4 | 0.45 → 0.44 |
| 4 | PASS / PASS | 30,733 → 28,707 | 156 → 156 | 30,889 → 28,863 | -2,026 | 5 → 5 | 4 → 4 | 0.41 → 0.42 |
| 5 | PASS / PASS | 30,733 → 28,707 | 156 → 156 | 30,889 → 28,863 | -2,026 | 5 → 5 | 4 → 4 | 0.45 → 0.47 |

Input-token improvements in 5/5 pairs. Total-token improvements in 5/5 pairs.

- `shadow` had 25 gate records, 5 admitted candidates and 0 applications visible in model input across 0/5 runs. Missing projection records on 0 context traces.
- `shadow` skip reasons `{'short_history': 10, 'below_savings_threshold': 10}`.
- `shadow` mean candidate savings 1,332.93 estimated history tokens per evaluated turn, excluding short histories.
- `projection` had 25 gate records, 5 admitted candidates and 5 applications visible in model input across 5/5 runs. Missing projection records on 0 context traces.
- `projection` skip reasons `{'short_history': 10, 'below_savings_threshold': 10}`.
- `projection` mean candidate savings 1,333.00 estimated history tokens per evaluated turn, excluding short histories.
- `projection` mean applied savings 4,004.00 estimated history tokens per application. Compression P50/P95/max 28.14% / 28.14% / 28.14%.

### projection trajectory after first model-visible projection

| Pair | First projected turn (1-based) | Model turns including and after it | Tool calls including and after it |
|---|---:|---:|---:|
| 1 | 4 | 2 | 1 |
| 2 | 4 | 2 | 1 |
| 3 | 4 | 2 | 1 |
| 4 | 4 | 2 | 1 |
| 5 | 4 | 2 | 1 |


Source `results.json` and per-run `context-traces`, benchmark directory `controlled-native-mvp-phase2-cost-gate-artifact-feedback`.

The original stub reran the full analysis at each stage. Its archived measurements describe a repeated-write workload. The final staged stub writes each artifact in its own phase. The failure-injection run generated an invalid row count, observed validator feedback, repaired the report and stopped naturally in all three modes. The live feedback pilot passed 6/6 and consumed 20.89% fewer total tokens in Projection. All three Projection runs applied memory on their last model turn. The earlier trajectory differences limit causal attribution, and the 10-pair comparison remains the larger sample.

## Native MVP cost-gate evidence · controlled-native-mvp-phase2-staged-final

Model `controlled-stub`.

| Mode | E2E PASS | Natural stop | Valid complete artifact sets |
|---|---:|---:|---:|
| dynamic | 5/5 | 5/5 | 5/5 |
| shadow | 5/5 | 5/5 | 5/5 |
| projection | 5/5 | 5/5 | 5/5 |

Independent cleaned-cohort recomputation for `dynamic` matched 5/5.

Independent cleaned-cohort recomputation for `shadow` matched 5/5.

Independent cleaned-cohort recomputation for `projection` matched 5/5.

Provider-reported usage events 75/75.

| Metric | Dynamic mean | Projection mean | Change | Dynamic P50 / P95 | Projection P50 / P95 |
|---|---:|---:|---:|---:|---:|
| Input tokens | 30,531.60 | 25,840.00 | -15.37% | 30,533.00 / 30,533.00 | 25,840.00 / 25,840.00 |
| Output tokens | 156.00 | 156.00 | +0.00% | 156.00 / 156.00 | 156.00 / 156.00 |
| Total tokens | 30,687.60 | 25,996.00 | -15.29% | 30,689.00 / 30,689.00 | 25,996.00 / 25,996.00 |
| Model turns | 5.00 | 5.00 | +0.00% | 5.00 / 5.00 | 5.00 / 5.00 |
| Tool calls | 4.00 | 4.00 | +0.00% | 4.00 / 4.00 | 4.00 / 4.00 |
| Duration (ms) | 458.00 | 455.00 | -0.66% | 434.00 / 536.40 | 440.00 / 496.20 |

Percentiles use linear interpolation. D → P is Dynamic → Projection.

| Pair | E2E D / P | Input D → P | Output D → P | Total D → P | Δ total | Turns D → P | Tools D → P | Seconds D → P |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | PASS / PASS | 30,526 → 25,840 | 156 → 156 | 30,682 → 25,996 | -4,686 | 5 → 5 | 4 → 4 | 0.56 → 0.50 |
| 2 | PASS / PASS | 30,533 → 25,840 | 156 → 156 | 30,689 → 25,996 | -4,693 | 5 → 5 | 4 → 4 | 0.43 → 0.48 |
| 3 | PASS / PASS | 30,533 → 25,840 | 156 → 156 | 30,689 → 25,996 | -4,693 | 5 → 5 | 4 → 4 | 0.43 → 0.43 |
| 4 | PASS / PASS | 30,533 → 25,840 | 156 → 156 | 30,689 → 25,996 | -4,693 | 5 → 5 | 4 → 4 | 0.45 → 0.44 |
| 5 | PASS / PASS | 30,533 → 25,840 | 156 → 156 | 30,689 → 25,996 | -4,693 | 5 → 5 | 4 → 4 | 0.42 → 0.43 |

Input-token improvements in 5/5 pairs. Total-token improvements in 5/5 pairs.

- `shadow` had 25 gate records, 10 admitted candidates and 0 applications visible in model input across 0/5 runs. Missing projection records on 0 context traces.
- `shadow` skip reasons `{'short_history': 10, 'below_savings_threshold': 5}`.
- `shadow` mean candidate savings 3,116.47 estimated history tokens per evaluated turn, excluding short histories.
- `projection` had 25 gate records, 10 admitted candidates and 10 applications visible in model input across 5/5 runs. Missing projection records on 0 context traces.
- `projection` skip reasons `{'short_history': 10, 'below_savings_threshold': 5}`.
- `projection` mean candidate savings 3,116.67 estimated history tokens per evaluated turn, excluding short histories.
- `projection` mean applied savings 4,653.00 estimated history tokens per application. Compression P50/P95/max 34.68% / 41.29% / 41.29%.

### projection trajectory after first model-visible projection

| Pair | First projected turn (1-based) | Model turns including and after it | Tool calls including and after it |
|---|---:|---:|---:|
| 1 | 4 | 2 | 1 |
| 2 | 4 | 2 | 1 |
| 3 | 4 | 2 | 1 |
| 4 | 4 | 2 | 1 |
| 5 | 4 | 2 | 1 |


Source `results.json` and per-run `context-traces`, benchmark directory `controlled-native-mvp-phase2-staged-final`.

## Native MVP cost-gate evidence · controlled-native-mvp-phase2-repair

Model `controlled-stub`.

| Mode | E2E PASS | Natural stop | Valid complete artifact sets |
|---|---:|---:|---:|
| dynamic | 1/1 | 1/1 | 1/1 |
| shadow | 1/1 | 1/1 | 1/1 |
| projection | 1/1 | 1/1 | 1/1 |

Independent cleaned-cohort recomputation for `dynamic` matched 1/1.

Independent cleaned-cohort recomputation for `shadow` matched 1/1.

Independent cleaned-cohort recomputation for `projection` matched 1/1.

Provider-reported usage events 18/18.

| Metric | Dynamic mean | Projection mean | Change | Dynamic P50 / P95 | Projection P50 / P95 |
|---|---:|---:|---:|---:|---:|
| Input tokens | 36,606.00 | 31,921.00 | -12.80% | 36,606.00 / 36,606.00 | 31,921.00 / 31,921.00 |
| Output tokens | 192.00 | 192.00 | +0.00% | 192.00 / 192.00 | 192.00 / 192.00 |
| Total tokens | 36,798.00 | 32,113.00 | -12.73% | 36,798.00 / 36,798.00 | 32,113.00 / 32,113.00 |
| Model turns | 6.00 | 6.00 | +0.00% | 6.00 / 6.00 | 6.00 / 6.00 |
| Tool calls | 5.00 | 5.00 | +0.00% | 5.00 / 5.00 | 5.00 / 5.00 |
| Duration (ms) | 653.00 | 518.00 | -20.67% | 653.00 / 653.00 | 518.00 / 518.00 |

Percentiles use linear interpolation. D → P is Dynamic → Projection.

| Pair | E2E D / P | Input D → P | Output D → P | Total D → P | Δ total | Turns D → P | Tools D → P | Seconds D → P |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | PASS / PASS | 36,606 → 31,921 | 192 → 192 | 36,798 → 32,113 | -4,685 | 6 → 6 | 5 → 5 | 0.65 → 0.52 |

Input-token improvements in 1/1 pairs. Total-token improvements in 1/1 pairs.

- `shadow` had 6 gate records, 2 admitted candidates and 0 applications visible in model input across 0/1 runs. Missing projection records on 0 context traces.
- `shadow` skip reasons `{'short_history': 2, 'below_savings_threshold': 2}`.
- `shadow` mean candidate savings 2,324.75 estimated history tokens per evaluated turn, excluding short histories.
- `projection` had 6 gate records, 2 admitted candidates and 2 applications visible in model input across 1/1 runs. Missing projection records on 0 context traces.
- `projection` skip reasons `{'short_history': 2, 'below_savings_threshold': 2}`.
- `projection` mean candidate savings 2,325.50 estimated history tokens per evaluated turn, excluding short histories.
- `projection` mean applied savings 4,653.00 estimated history tokens per application. Compression P50/P95/max 34.68% / 40.62% / 41.28%.

### projection trajectory after first model-visible projection

| Pair | First projected turn (1-based) | Model turns including and after it | Tool calls including and after it |
|---|---:|---:|---:|
| 1 | 4 | 3 | 2 |


Source `results.json` and per-run `context-traces`, benchmark directory `controlled-native-mvp-phase2-repair`.

## Native MVP cost-gate evidence · live-native-mvp-phase2-cost-gate-artifact-feedback

Model `DeepSeek-V4.1-Flash-1017`.

| Mode | E2E PASS | Natural stop | Valid complete artifact sets |
|---|---:|---:|---:|
| dynamic | 3/3 | 3/3 | 3/3 |
| projection | 3/3 | 3/3 | 3/3 |

Independent cleaned-cohort recomputation for `dynamic` matched 3/3.

Independent cleaned-cohort recomputation for `projection` matched 3/3.

Provider-reported usage events 36/36.

| Metric | Dynamic mean | Projection mean | Change | Dynamic P50 / P95 | Projection P50 / P95 |
|---|---:|---:|---:|---:|---:|
| Input tokens | 40,167.33 | 31,741.33 | -20.98% | 38,276.00 / 43,625.60 | 33,665.00 / 34,858.40 |
| Output tokens | 5,901.00 | 4,704.00 | -20.28% | 5,861.00 / 6,140.90 | 5,080.00 / 5,811.70 |
| Total tokens | 46,068.33 | 36,445.33 | -20.89% | 44,448.00 / 49,517.70 | 38,745.00 / 40,670.10 |
| Model turns | 6.33 | 5.67 | -10.53% | 6.00 / 6.90 | 6.00 / 6.00 |
| Tool calls | 5.33 | 4.67 | -12.50% | 5.00 / 5.90 | 5.00 / 5.00 |
| Duration (ms) | 108,646.67 | 103,152.67 | -5.06% | 100,543.00 / 125,022.10 | 109,852.00 / 113,174.80 |

Percentiles use linear interpolation. D → P is Dynamic → Projection.

| Pair | E2E D / P | Input D → P | Output D → P | Total D → P | Δ total | Turns D → P | Tools D → P | Seconds D → P |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | PASS / PASS | 38,276 → 33,665 | 6,172 → 5,080 | 44,448 → 38,745 | -5,703 | 6 → 6 | 5 → 5 | 100.54 → 109.85 |
| 2 | PASS / PASS | 38,006 → 26,568 | 5,670 → 3,139 | 43,676 → 29,707 | -13,969 | 6 → 5 | 5 → 4 | 97.66 → 113.54 |
| 3 | PASS / PASS | 44,220 → 34,991 | 5,861 → 5,893 | 50,081 → 40,884 | -9,197 | 7 → 6 | 6 → 5 | 127.74 → 86.06 |

Input-token improvements in 3/3 pairs. Total-token improvements in 3/3 pairs.

- `projection` had 17 gate records, 3 admitted candidates and 3 applications visible in model input across 3/3 runs. Missing projection records on 0 context traces.
- `projection` skip reasons `{'short_history': 9, 'below_savings_threshold': 5}`.
- `projection` mean candidate savings 1,107.62 estimated history tokens per evaluated turn, excluding short histories.
- `projection` mean applied savings 2,157.67 estimated history tokens per application. Compression P50/P95/max 21.56% / 22.15% / 22.21%.

### projection trajectory after first model-visible projection

| Pair | First projected turn (1-based) | Model turns including and after it | Tool calls including and after it |
|---|---:|---:|---:|
| 1 | 6 | 1 | 0 |
| 2 | 5 | 1 | 0 |
| 3 | 6 | 1 | 0 |


Source `results.json` and per-run `context-traces`, benchmark directory `live-native-mvp-phase2-cost-gate-artifact-feedback`.
