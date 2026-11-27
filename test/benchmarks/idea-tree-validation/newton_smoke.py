"""Prepare official NewtonBench tasks for a fixed-observation Idea Tree smoke.

This fixture does not approximate the full interactive NewtonBench protocol.
It keeps withheld points and the official law out of the product workspace.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import random
import subprocess

PIN = '912a4ba5f4356ddd06acc16e44460ca30be4abc2'


def write_json(path, data):
    path.write_text(json.dumps(data, separators=(',', ':')) + '\n', encoding='utf-8')


def prepare(source, product, withheld, seed):
    revision = subprocess.check_output(['git', '-C', source, 'rev-parse', 'HEAD'], text=True).strip()
    if revision != PIN:
        raise ValueError(f'Supply NewtonBench revision {PIN}')
    spec = importlib.util.spec_from_file_location('newtonbench_fourier_laws', source / 'modules/m3_fourier_law/laws.py')
    laws = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(laws)
    law, _ = laws.get_ground_truth_law('easy', 'v0')
    product.mkdir(parents=True, exist_ok=False)
    withheld.mkdir(parents=True, exist_ok=False)
    for folder, stream_seed, count in ((product, seed, 24), (withheld, seed + 1, 64)):
        rng = random.Random(stream_seed)
        rows = [{'id': str(i), 'x': [round(rng.uniform(a, b), 5) for a,b in ((.5, 4), (.1, 3), (5, 100), (.2, 4))]}
                for i in range(count)]
        write_json(folder / 'development.json', rows)
        write_json(folder / 'reference.json', [{'id': row['id'], 'value': law(*row['x'])} for row in rows])
    problem = {
        'id': f'newton-fourier-smoke-{seed}', 'metric': 'nrmse', 'seed': seed,
        'objective': 'Infer a generalized heat flow law from the development measurements for a shifted Fourier experiment.',
        'instructions': 'Rows in development.json each give x=[conductivity k, area A, positive temperature difference delta_T, thickness d]. '
                        'development-reference.json has the paired measured heat flow. Improve and define discovered_law(k, A, delta_T, d) '
                        'in Python. Preserve the CLI for prediction. Compare alternative powers by fitting the development observations.',
    }
    write_json(product / 'task.json', problem)
    (product / 'baseline.py').write_text('''import json
import sys


def discovered_law(k, A, delta_T, d):
    return k * A * delta_T / d


if __name__ == "__main__":
    with open(sys.argv[1], encoding="utf-8") as file:
        rows = json.load(file)
    print(json.dumps([{"id": row["id"], "value": discovered_law(*row["x"])} for row in rows]))
''', encoding='utf-8')
    write_json(withheld / 'manifest.json', {
        'upstream': revision, 'task': 'm3_fourier_law/easy/v0/vanilla_equation',
        'protocol': 'fixed noiseless measurements for product smoke', 'seed': seed,
        'files': {f'{folder.name}/{p.name}': hashlib.sha256(p.read_bytes()).hexdigest()
                  for folder in (product, withheld) for p in sorted(folder.iterdir())},
    })


if __name__ == '__main__':
    args = argparse.ArgumentParser(__doc__)
    for arg in ('source', 'product', 'withheld'):
        args.add_argument(arg, type=Path)
    args.add_argument('--seed', type=int, default=67)
    a = args.parse_args()
    prepare(a.source, a.product, a.withheld, a.seed)
