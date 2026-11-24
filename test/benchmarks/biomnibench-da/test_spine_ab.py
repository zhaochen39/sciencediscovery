# Copyright (C) 2026 Huawei Technologies Co., Ltd
# SPDX-License-Identifier: Apache-2.0
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest

from compare_spine import compare, load_arm
from suite import freeze_spine_arm, projection_evidence


class SpineABTests(unittest.TestCase):
    def test_resume_rejects_changed_arm(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            args = SimpleNamespace(spine_arm='off', backend='jiuwenswarm', data_root=root / 'data',
                                   runtime=root / 'run', results=root, python='python3',
                                   idle_seconds=1200, min_free_gib=64, min_free_inodes=150000)
            env = {'E2E_LLM_BASE_URL': 'https://generator.invalid/v1', 'BIOMNI_JUDGE_BASE_URL': 'https://judge.invalid/v1',
                   'E2E_LLM_TOKEN': 'fake-secret', 'SCIENCE_AGENT_RESEARCH_RECOVERY_SESSIONS': 'inherited'}
            freeze_spine_arm(args, env, 'revision', ['a'])
            self.assertEqual(env['SCIENCE_AGENT_JIUWENSWARM_SCOPE_PROJECTION'], '0')
            self.assertNotIn('SCIENCE_AGENT_RESEARCH_RECOVERY_SESSIONS', env)
            self.assertNotIn('fake-secret', (root / 'spine-arm.json').read_text())
            freeze_spine_arm(args, env, 'revision', ['a'])
            args.spine_arm = 'on'
            with self.assertRaisesRegex(RuntimeError, 'different experiment configuration'):
                freeze_spine_arm(args, env, 'revision', ['a'])

    def test_projection_evidence_counts_distinct_turns(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.assertEqual(projection_evidence(root)['stack_logs'], 0)
            event = '[swarm-spine] ' + json.dumps({'event': 'scope.projection.applied', 'runId': 'r1', 'turn': 2})
            (root / 'stack.log').write_text(event + '\n' + event + '\n')
            self.assertEqual(projection_evidence(root), {'stack_logs': 1, 'applied_turns': 1, 'applied_runs': 1})

    def test_partial_pair_and_evaluation_retry_do_not_hide_missing_usage(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            case_ids = [f'case-{i}' for i in range(45)]
            case = case_ids[0]
            for arm in ('off', 'on'):
                path = root / arm
                path.mkdir()
                latest = {'case': case, 'phase': 'retry-1', 'completed': True, 'exit': 0,
                          'generation_metrics_path': '/saved/research-metrics.json'}
                research = {'case': case, 'metrics_path': '/saved/research-metrics.json',
                            'projection': {'stack_logs': 1, 'applied_turns': int(arm == 'on')}}
                doc = {'case_id': case, 'evaluation': {'score': 99}, 'judge_usage': {'complete': arm == 'off'},
                       'measurements': {'generation_input_tokens': 100 if arm == 'off' else 90, 'total_tokens': 130}}
                for name, obj in {
                    'spine-arm.json': {'arm': arm, 'common': {'backend': 'jiuwenswarm', 'cases': case_ids}},
                    'summary.json': {'cases': [latest], 'attempts': [research, latest]},
                    'selected-metrics.json': [doc],
                }.items():
                    (path / name).write_text(json.dumps(obj))
            report, rows = compare(load_arm(root / 'off', 'off'), load_arm(root / 'on', 'on'))
            self.assertEqual(report['metrics']['generation_input_tokens']['relative_percent'], -10)
            self.assertEqual(report['metrics']['total_tokens']['pairs'], 0)
            self.assertFalse(report['all_cases_paired_and_scored'])
            self.assertEqual(report['arms']['on']['selected_scored_cases_with_projection'], 1)
            self.assertEqual(rows[0]['on_selected_generation_projection_turns'], 1)
            self.assertIsNone(rows[1]['on_selected_generation_projection_turns'])
