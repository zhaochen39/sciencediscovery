"""Prepare and grade the official CodePDE Advection split.

The candidate interface is a Python point-prediction function. The development
wrapper checks a frozen in-split sample. Final scoring uses all official points
and the upstream compute_nrmse function in a separate grader.
"""
import argparse
import ast
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import time

import h5py
import numpy as np

CODEPDE_COMMIT = '26938c5832ddd0a957426dff6f702b54649c14af'
SOURCE = 'solvers/advection/evaluator.py'


def fingerprint(path):
    with path.open('rb') as file:
        return hashlib.file_digest(file, 'sha256').hexdigest()


def load(path, count):
    with h5py.File(path, 'r') as source:
        tensor = source['tensor'][:]
        times = source['t-coordinate'][:]
    if tensor.shape != (count, 201, 1024) or len(times) != 201:
        raise ValueError('Unexpected Advection data shape')
    return tensor, times[:tensor.shape[1]]


def metric_from(source):
    current = subprocess.check_output(['git', '-C', source, 'rev-parse', 'HEAD'], text=True).strip()
    if current != CODEPDE_COMMIT:
        raise ValueError(f'Supply the CodePDE repository at {CODEPDE_COMMIT}')
    scorer = subprocess.check_output(['git', '-C', source, 'show', f'{current}:{SOURCE}'], text=True)
    tree = ast.parse(scorer)
    body = [item for item in tree.body if isinstance(item, ast.FunctionDef) and item.name == 'compute_nrmse']
    namespace = {'np': np}
    exec(compile(ast.Module(body=body, type_ignores=[]), SOURCE, 'exec'), namespace)
    return namespace['compute_nrmse'], hashlib.sha256(scorer.encode()).hexdigest()


def write_json(path, obj):
    path.write_text(json.dumps(obj, allow_nan=False, separators=(',', ':')) + '\n', encoding='utf-8')


def prepare(data, product, source, seed):
    _, scorer_hash = metric_from(source)
    rng = np.random.default_rng(seed)
    source_data = data / '1D_Advection_Sols_beta0.1_development.hdf5'
    values, times = load(source_data, 50)
    product.mkdir(parents=True, exist_ok=False)
    traces = sorted(int(i) for i in rng.choice(len(values), size=24, replace=False))
    coordinates = [(j, i) for j in range(7, 201, 27) for i in range(0, 1024, 128)]
    rows = {'beta': 0.1, 'u0': values[traces, 0].round(7).astype(float).round(7).tolist(), 'measurements': []}
    labels = []
    for local_id, trace_id in enumerate(traces):
        for j, i in coordinates:
            identifier = f'{local_id}-{j}-{i}'
            rows['measurements'].append({'id': identifier, 'trace': local_id, 't': float(times[j]), 'i': i})
            labels.append({'id': identifier, 'value': float(values[trace_id, j, i])})
    write_json(product / 'development.json', rows)
    write_json(product / 'reference.json', labels)
    write_json(product / 'task.json', {
        'id': f'codepde-advection-smoke-{seed}', 'seed': seed, 'metric': 'nrmse', 'upstream': CODEPDE_COMMIT,
        'scorerSha256': scorer_hash, 'developmentSha256': fingerprint(source_data),
        'objective': 'Improve the numerical solver for 1-D periodic constant-speed advection on unseen initial conditions.',
        'instructions': 'Python standard library only. The domain has length 1. The positive advection speed beta is 0.1. '
                        'Implement predict(u0, t, index, beta) to predict the point at index on the original uniform periodic grid. '
                        'Preserve the function signature and command-line protocol in baseline.py. Use the supplied development data only.',
    })
    (product / 'baseline.py').write_text('''import json
import sys


def predict(u0, t, index, beta):
    return u0[(index - round(beta * t * len(u0))) % len(u0)]


if __name__ == "__main__":
    with open(sys.argv[1], encoding="utf-8") as file:
        data = json.load(file)
    print(json.dumps([{"id": row["id"], "value": predict(data["u0"][row["trace"]], row["t"], row["i"], data["beta"])}
                      for row in data["measurements"]]))
''', encoding='utf-8')


SCORE_WRAPPER = '''import array
import importlib.util
import json
import math
import sys

from pathlib import Path

spec = importlib.util.spec_from_file_location("candidate", "/work/candidate.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
u0, times = json.loads(Path("test-input.json").read_text())
with open("predictions.bin", "wb") as output:
    for initial in u0:
        for t in times:
            row = array.array("d", (module.predict(initial, t, i, 0.1) for i in range(len(initial))))
            if len(row) != len(initial) or not all(map(math.isfinite, row)):
                raise ValueError("Non-finite prediction")
            row.tofile(output)
'''


def grade(data, source, locked, destination):
    report = json.loads(locked.read_text(encoding='utf-8'))
    if report['outcome'] != 'submission_locked':
        raise ValueError('No locked submission')
    script = Path(report['submission']['path'])
    if fingerprint(script) != report['submission']['sha256']:
        raise ValueError('Submission hash mismatch')
    metric, scorer_hash = metric_from(source)
    test_data = data / '1D_Advection_Sols_beta0.1.hdf5'
    truth, times = load(test_data, 100)
    with tempfile.TemporaryDirectory(prefix='codepde-grade-') as folder:
        staging = Path(folder)
        # Bind only this directory and system Python. Scorer and truth are never
        # placed in the candidate's filesystem. No network or inherited secrets.
        (staging / 'candidate.py').write_bytes(script.read_bytes())
        (staging / 'grade_predictions.py').write_text(SCORE_WRAPPER, encoding='utf-8')
        write_json(staging / 'test-input.json', [truth[:, 0].tolist(), times.tolist()])
        command = ['bwrap', '--unshare-all', '--die-with-parent', '--clearenv', '--setenv', 'PATH', '/usr/bin',
                   '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64',
                   '--tmpfs', '/tmp', '--dev', '/dev', '--bind', folder, '/work', '--chdir', '/work',
                   '/usr/bin/python3', '-I', '-B', 'grade_predictions.py']
        started = time.monotonic()
        subprocess.run(command, check=True, timeout=120, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        duration = time.monotonic() - started
        path = staging / 'predictions.bin'
        if path.is_symlink() or path.stat().st_size != truth.size * 8:
            raise ValueError('Unexpected output size')
        predicted = np.fromfile(path, dtype=np.float64).reshape(truth.shape)
    if not np.isfinite(predicted).all():
        raise ValueError('Non-finite predictions')
    result = {'submissionSha256': report['submission']['sha256'], 'upstream': CODEPDE_COMMIT,
              'scorerSha256': scorer_hash, 'testSha256': fingerprint(test_data), 'testTrajectories': len(truth),
              'nrmse': float(metric(predicted, truth)), 'predictionSeconds': duration}
    write_json(destination, result)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument('action', choices=('prepare', 'grade'))
    for field in ('data', 'source', 'output'):
        parser.add_argument(field, type=Path)
    parser.add_argument('--seed', type=int, default=67)
    parser.add_argument('--locked', type=Path)
    args = parser.parse_args()
    if args.action == 'prepare':
        prepare(args.data, args.output, args.source, args.seed)
    elif args.locked:
        grade(args.data, args.source, args.locked, args.output)
    else:
        parser.error('grade requires --locked')
