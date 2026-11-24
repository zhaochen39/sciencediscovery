const python = (body: string) => `python3 - <<'PY'
import csv
import json
from pathlib import Path
from statistics import mean

def read(name):
    with open(name, newline='') as source:
        return list(csv.DictReader(source))

def write(name, columns, rows):
    with open(name, 'w', newline='') as target:
        writer = csv.writer(target, lineterminator='\\n')
        writer.writerow(columns)
        writer.writerows(rows)

${body}
PY`;

export const solarReadoutScenarios = ["split", "revised", "mixed", "ambiguous", "incomplete"] as const;
export type SolarReadoutScenario = (typeof solarReadoutScenarios)[number];

export function solarCommands(scenario: SolarReadoutScenario): string[] {
  const clean = python(`
sites = {row['site_id']: row for row in read('sites.csv')}
days = {site: [] for site in sites}
clean = []
for row in read('measurements.csv'):
    if row['status'] != 'ok':
        continue
    site = row['site_id']
    ratio = float(row['energy_kwh']) / (int(row['peak_sun_hours']) * int(sites[site]['capacity_kw']))
    days[site].append(ratio)
    clean.append((site, row['day'], sites[site]['technology'], ratio))
write('daily_clean.csv', ['site_id', 'day', 'technology', 'yield_index'], clean)
write('site_qc.csv', ['site_id', 'technology', 'expected_days', 'valid_days', 'excluded_days', 'mean_index'],
      [(site, info['technology'], 4, len(days[site]), 4 - len(days[site]), f'{mean(days[site]):.6f}')
       for site, info in sites.items()])`);
  const summarize = (name: string, complete: boolean) => python(`
${scenario === "revised" && !complete ? `path = Path('site_qc.csv')
header, *rows = path.read_text().splitlines()
path.write_text('\\n'.join([header, *reversed(rows)]) + '\\n')` : ""}
rows = read('site_qc.csv')
result = {}
for group in ('mono', 'poly', 'thin_film'):
    indexes = [float(row['mean_index']) for row in rows if row['technology'] == group
               and (${complete ? "row['valid_days'] == '4'" : "True"})]
    result[group] = {'sites': len(indexes), 'mean_index': mean(indexes)}
Path('${name}').write_text(json.dumps(result))
print(json.dumps(result))`);
  const report = python(`
groups = json.loads(Path('groups.json').read_text())
sensitivity = json.loads(Path('sensitivity.json').read_text())
top = lambda data: max(data, key=lambda group: data[group]['mean_index'])
Path('solar_report.md').write_text(f'''# Solar monitoring report

Both analyses rank mono, poly and thin_film in that order. Excluding incomplete sites changes the means and sample sizes while preserving the ranking.

Sources: daily_clean.csv, site_qc.csv, groups.json, sensitivity.json.

top_technology: {top(groups)}
complete_site_top_technology: {top(sensitivity)}
''')`);
  const readouts = scenario === "ambiguous" ? ["cat site_qc.csv", "cat site_qc.csv"]
    : scenario === "mixed" ? ["cat site_qc.csv; printf '\nExtra observation for later review\n'"]
    : scenario === "incomplete" ? ["head -n 30 site_qc.csv", "tail -n +31 site_qc.csv"] : ["cat site_qc.csv"];
  return [clean, ...readouts, summarize("groups.json", false), summarize("sensitivity.json", true), report];
}
