#!/usr/bin/env python3
# Copyright (C) 2026 Huawei Technologies Co., Ltd
# SPDX-License-Identifier: Apache-2.0
"""Compare two same-revision JiuwenSwarm BiomniBench-DA suite runs."""
import argparse
import csv
import json
from pathlib import Path
from statistics import median


METRICS = (
    'score', 'generation_input_tokens', 'generation_output_tokens', 'generation_tokens',
    'generation_requests', 'judge_input_tokens', 'judge_output_tokens', 'judge_tokens',
    'total_tokens', 'tool_calls', 'tool_rounds', 'shell_executions', 'e2e_ms', 'judge_ms', 'peak_rss_bytes',
)


def read(root, name, default=None):
    path = root / name
    return json.loads(path.read_text()) if path.exists() else default


def load_arm(root, expected_arm):
    config = read(root, 'spine-arm.json')
    if not config or config['arm'] != expected_arm or config['common']['backend'] != 'jiuwenswarm':
        raise ValueError(f'{root}: expected JiuwenSwarm arm {expected_arm}')
    summary = read(root, 'summary.json', {})
    by_case = {row['case']: row for row in summary.get('cases', [])}
    docs = {row['case_id']: row for row in read(root, 'selected-metrics.json', [])}
    attempts = summary.get('attempts', [])
    by_metrics_path = {row.get('metrics_path'): row for row in attempts if row.get('metrics_path')}
    projection = {case: {'turns': 0, 'attempts_with_logs': 0} for case in config['common']['cases']}
    for row in attempts:
        fields = row.get('projection', {})
        case = projection[row['case']]
        case['turns'] += fields.get('applied_turns', 0)
        case['attempts_with_logs'] += bool(fields.get('stack_logs'))
    for case, status in by_case.items():
        selected = by_metrics_path.get(status.get('generation_metrics_path'), status)
        projection[case]['selected_generation'] = selected.get('projection', {})
    return config, summary, by_case, docs, projection, read(root, 'attempt-costs.json', {})


def measurement(doc, metric):
    if metric in ('judge_tokens', 'judge_input_tokens', 'judge_output_tokens', 'total_tokens'):
        if doc.get('judge_usage', {}).get('complete') is not True:
            return None
    value = doc.get('evaluation', {}).get('score') if metric == 'score' else doc.get('measurements', {}).get(metric)
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def compare(off, on):
    off_config, off_summary, off_cases, off_docs, off_projection, off_costs = off
    on_config, on_summary, on_cases, on_docs, on_projection, on_costs = on
    if {k: v for k, v in off_config['common'].items() if k != 'runtime'} != {
        k: v for k, v in on_config['common'].items() if k != 'runtime'
    }:
        raise ValueError('A/B common configurations do not match')
    case_ids = off_config['common']['cases']
    if len(case_ids) != 45 or len(set(case_ids)) != 45:
        raise ValueError('Expected 45 unique active cases')
    rows = []
    pairs = {metric: [] for metric in METRICS}
    for case in case_ids:
        row = {'case': case}
        for arm, cases, docs, projections in (('off', off_cases, off_docs, off_projection),
                                               ('on', on_cases, on_docs, on_projection)):
            status = cases.get(case, {})
            doc = docs.get(case, {})
            row[f'{arm}_completed'] = bool(status.get('completed'))
            row[f'{arm}_exit'] = status.get('exit')
            row[f'{arm}_reason'] = status.get('reason')
            row[f'{arm}_first_pass'] = status.get('phase') == 'first-pass' and row[f'{arm}_completed']
            row[f'{arm}_projection_turns'] = projections[case]['turns']
            row[f'{arm}_attempts_with_stack_logs'] = projections[case]['attempts_with_logs']
            selected = projections[case].get('selected_generation', {})
            row[f'{arm}_selected_generation_projection_turns'] = selected.get('applied_turns') if selected.get('stack_logs') else None
            row[f'{arm}_observed_runs'] = doc.get('spine_observation', {}).get('observed_runs')
            for metric in METRICS:
                row[f'{arm}_{metric}'] = measurement(doc, metric) if row[f'{arm}_completed'] else None
        for metric in METRICS:
            a, b = row[f'off_{metric}'], row[f'on_{metric}']
            row[f'delta_{metric}'] = b - a if a is not None and b is not None else None
            if row[f'delta_{metric}'] is not None:
                pairs[metric].append((a, b))
        rows.append(row)
    metrics = {}
    for metric, values in pairs.items():
        a = sum(before for before, _ in values)
        b = sum(after for _, after in values)
        metrics[metric] = {'pairs': len(values), 'off_mean': a / len(values) if values else None,
            'on_mean': b / len(values) if values else None,
            'mean_difference': (b - a) / len(values) if values else None,
            'median_paired_difference': median(after - before for before, after in values) if values else None,
            'relative_percent': (b - a) / a * 100 if a else None,
            'on_lower_cases': sum(after < before for before, after in values),
            'equal_cases': sum(after == before for before, after in values),
            'on_higher_cases': sum(after > before for before, after in values)}
    counts = {}
    for arm, summary, costs in (('off', off_summary, off_costs), ('on', on_summary, on_costs)):
        counts[arm] = {
            'first_pass': summary.get('first_pass_completed', 0),
            'final_scored': sum(row[f'{arm}_completed'] for row in rows),
            'final_exit_zero': sum(row[f'{arm}_exit'] == 0 for row in rows),
            'selected_scored_cases_with_projection': sum(row[f'{arm}_completed']
                and (row[f'{arm}_selected_generation_projection_turns'] or 0) > 0 for row in rows),
            'selected_scored_cases_with_projection_evidence': sum(row[f'{arm}_completed']
                and row[f'{arm}_selected_generation_projection_turns'] is not None for row in rows),
            'cases_with_projection': sum(row[f'{arm}_projection_turns'] > 0 for row in rows),
            'projection_turns': sum(row[f'{arm}_projection_turns'] for row in rows),
            'cases_with_stack_logs': sum(row[f'{arm}_attempts_with_stack_logs'] > 0 for row in rows),
            'cases_with_scope_observation': sum((row[f'{arm}_observed_runs'] or 0) > 0 for row in rows),
            'attempt_costs': costs,
        }
    return {'expected_cases': len(case_ids), 'arms': counts, 'metrics': metrics,
            'all_cases_exit_zero': all(arm['final_exit_zero'] == len(case_ids) for arm in counts.values()),
            'spine_off_contamination': counts['off']['projection_turns'] > 0 or counts['off']['cases_with_scope_observation'] > 0,
            'all_cases_paired_and_scored': metrics['score']['pairs'] == len(case_ids),
            'configurations': {'off': off_config, 'on': on_config}}, rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--off', type=Path, required=True)
    parser.add_argument('--on', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    result, rows = compare(load_arm(args.off, 'off'), load_arm(args.on, 'on'))
    args.output.mkdir(parents=True, exist_ok=False)
    (args.output / 'comparison.json').write_text(json.dumps(result, indent=2) + '\n')
    with (args.output / 'cases.csv').open('w', newline='') as stream:
        writer = csv.DictWriter(stream, fieldnames=rows[0].keys())
        writer.writeheader()
        writer.writerows(rows)
    print(json.dumps({k: result[k] for k in ('arms', 'all_cases_paired_and_scored', 'spine_off_contamination')}, indent=2))
    return 0 if (result['all_cases_paired_and_scored'] and result['all_cases_exit_zero']
                 and not result['spine_off_contamination']) else 1


if __name__ == '__main__':
    raise SystemExit(main())
