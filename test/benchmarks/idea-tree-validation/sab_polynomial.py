"""ScienceAgentBench verified task 87 adapter using the original CSV evaluator.

Idea Tree receives a subset of the climate series and offline numeric checks.
The final evaluator consumes a frozen deliverable and the complete official data.
"""

import argparse
import ast
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

import h5py
import numpy as np


UPSTREAM = 'cc87b58cddf3954673c8ed29ac0d5a4a081b5d00'
DATA = 'datasets/polynomial_fit/A1B_north_america.nc'
SCORER = 'eval_programs/eval_polynomial_fit.py'
REFERENCE = 'eval_programs/gold_results/polynomial_fit_gold.csv'
STARTER = '''import json
import sys


def fit(years, temperatures):
    mean = sum(temperatures) / len(temperatures)
    return [mean] * len(years)


if __name__ == "__main__":
    with open(sys.argv[1], encoding="utf-8") as handle:
        data = json.load(handle)
    predicted = fit(data["year"], data["temperature"])
    print(json.dumps([{"id": str(y), "value": float(v)} for y, v in zip(data["year"], predicted)]))
'''


def fingerprint(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, allow_nan=False) + '\n', encoding='utf-8')


def series(root):
    with h5py.File(root / DATA) as netcdf:
        time = netcdf['time']
        if time.attrs['calendar'] != b'360_day' or time.attrs['units'] != b'hours since 1970-01-01 00:00:00':
            raise ValueError('Unexpected climate time coordinate')
        years = (1970 + np.floor(time[:] / (24 * 360))).astype(int)
        # The official task-87 gold program selects the first time series yielded
        # by Iris' cube.slices(['time']), which is the [0, 0] grid cell.
        # Keep this exact series selection so the adapter and official CSV
        # scorer evaluate the same task semantics.
        mean = netcdf['air_temperature'][:, 0, 0]
    if len(years) != len(set(years)) or len(years) != 240 or not np.isfinite(mean).all():
        raise ValueError('Unexpected annual climate series')
    return years, mean


def prepare(root, folder, seed):
    years, temperatures = series(root)
    indices = np.sort(np.random.default_rng(seed).choice(len(years), 48, replace=False))
    years, temperatures = years[indices], temperatures[indices]
    fitted = np.polyval(np.polyfit(years, temperatures, 2), years)
    folder.mkdir(parents=True, exist_ok=False)
    write_json(folder / 'development.json', {'year': years.tolist(), 'temperature': temperatures.tolist()})
    write_json(folder / 'reference.json', [{'id': str(y), 'value': float(v)} for y, v in zip(years, fitted)])
    write_json(folder / 'task.json', {
        'id': f'sab-verified-87-smoke-{seed}', 'seed': seed, 'metric': 'mae', 'upstream': UPSTREAM,
        'datasetSha256': fingerprint(root / DATA), 'scorerSha256': fingerprint(root / SCORER),
        'objective': 'Perform degree-2 least-squares fitting of an annual temperature series from ScienceAgentBench verified task 87.',
        'instructions': 'Implement fit(years, temperatures) in the starter Python source. Return one fitted value per year in order. '
                        'The inputs contain the official task-87 annual temperature series in kelvin. Preserve the JSON CLI for managed validation. '
                        'The final harness adapts this function to the benchmark CSV over the complete NetCDF series. '
                        'Aim for numerical stability. NumPy is available in the final scorer environment, but include a standard-library '
                        'fallback so that managed development validation also works. Do not invent, download, or hard-code any data.',
    })
    (folder / 'baseline.py').write_text(STARTER, encoding='utf-8')


RUNNER = '''import csv
import importlib.util
import json
import math
from pathlib import Path

spec = importlib.util.spec_from_file_location("submission", Path("candidate.py").resolve())
submission = importlib.util.module_from_spec(spec)
spec.loader.exec_module(submission)
data = json.loads(Path("final-series.json").read_text())
years = data["year"]
values = [float(v) for v in submission.fit(years, data["temperature"])]
if len(values) != len(years) or not all(map(math.isfinite, values)):
    raise ValueError("Invalid fitted series")
with open("pred_results/polynomial_fit_pred.csv", "w", newline="", encoding="utf-8") as destination:
    writer = csv.writer(destination)
    writer.writerow(["Year", "Fitted_Temperature"])
    writer.writerows(zip(years, values))
'''


def grade(root, locked, output):
    report = json.loads(locked.read_text(encoding='utf-8'))
    if report['outcome'] != 'submission_locked':
        raise ValueError('No frozen product submission')
    submission = Path(report['submission']['path'])
    receipt = report['submission']['sha256']
    if fingerprint(submission) != receipt:
        raise ValueError('Submission hash mismatch')
    years, temperatures = series(root)
    with tempfile.TemporaryDirectory(prefix='sab-87-grade-') as work:
        sandbox = Path(work)
        (sandbox / 'pred_results').mkdir()
        (sandbox / 'candidate.py').write_bytes(submission.read_bytes())
        (sandbox / 'run_fit.py').write_text(RUNNER, encoding='utf-8')
        write_json(sandbox / 'final-series.json', {'year': years.tolist(), 'temperature': temperatures.tolist()})
        python_env = Path(sys.prefix).resolve()
        if shutil.which('bwrap'):
            command = ['bwrap', '--unshare-all', '--die-with-parent', '--clearenv', '--setenv', 'PATH', '/usr/bin',
                       '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64',
                       '--ro-bind', str(python_env), str(python_env), '--tmpfs', '/tmp', '--dev', '/dev',
                       '--bind', work, '/work', '--chdir', '/work', sys.executable, '-I', '-B', 'run_fit.py']
            subprocess.run(command, check=True, timeout=90, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            # Windows acceptance runs do not provide bubblewrap. Keep the same
            # isolated temporary workspace and protocol while using Python's
            # isolated mode for the candidate process.
            subprocess.run([sys.executable, '-I', '-B', str(sandbox / 'run_fit.py')], check=True,
                           cwd=work, timeout=90, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        predictions = sandbox / 'pred_results/polynomial_fit_pred.csv'
        if predictions.is_symlink() or predictions.stat().st_size > 100_000:
            raise ValueError('Unexpected prediction file')
        # Run the original scorer in a separate directory without candidate code.
        with tempfile.TemporaryDirectory(prefix='sab-87-official-') as grader:
            directory = Path(grader)
            target = directory / 'benchmark' / REFERENCE
            target.parent.mkdir(parents=True)
            target.write_bytes((root / REFERENCE).read_bytes())
            prediction = directory / 'pred_results' / predictions.name
            prediction.parent.mkdir()
            prediction.write_bytes(predictions.read_bytes())
            result = subprocess.check_output([sys.executable, '-I', str((root / SCORER).resolve())], cwd=grader, timeout=30, text=True)
    success, _ = ast.literal_eval(result.strip())
    if success not in (0, 1):
        raise ValueError('Unexpected official score')
    write_json(output, {'task': 87, 'upstream': UPSTREAM, 'success': success, 'submissionSha256': receipt,
                        'scorerSha256': fingerprint(root / SCORER), 'dataSha256': fingerprint(root / DATA),
                        'referenceSha256': fingerprint(root / REFERENCE), 'protocol': 'fixed split, function-to-CSV adapter'})


if __name__ == '__main__':
    arguments = argparse.ArgumentParser(__doc__)
    arguments.add_argument('action', choices=('prepare', 'grade'))
    arguments.add_argument('benchmark', type=Path)
    arguments.add_argument('output', type=Path)
    arguments.add_argument('--seed', type=int, default=67)
    arguments.add_argument('--locked', type=Path)
    args = arguments.parse_args()
    if args.action == 'prepare':
        prepare(args.benchmark, args.output, args.seed)
    elif args.locked:
        grade(args.benchmark, args.locked, args.output)
    else:
        arguments.error('grade requires --locked')
