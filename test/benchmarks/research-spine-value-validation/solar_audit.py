"""Pinned solar-monitoring fixture and independent artifact audit (standard library)."""
import csv
import json
import math
import re
import sys
from pathlib import Path
from statistics import mean

GROUPS = ("mono", "poly", "thin_film")
CLEAN_COLUMNS = ("site_id", "day", "technology", "yield_index")
QC_COLUMNS = ("site_id", "technology", "expected_days", "valid_days", "excluded_days", "mean_index")
ARTIFACTS = ("daily_clean.csv", "site_qc.csv", "groups.json", "sensitivity.json")


def fixture():
    sites, measurements = [], []
    for i in range(120):
        site = f"site-{i + 1:03d}"
        group, capacity = GROUPS[i % 3], 20 + (i % 5) * 10
        sites.append((site, group, capacity))
        for day in range(1, 5):
            hours = 3 + (day + i) % 5
            factor = (860, 810, 770)[i % 3] + (i % 7 - 3) * 5 + day - 2
            status = "bad" if i % 7 == 0 and day == 2 else "ok"
            produced = f"{capacity * hours * factor / 1_000:.3f}"
            measurements.append((site, day, hours, produced, status))
    return sites, measurements


def write_csv(path, columns, rows):
    with path.open("x", encoding="utf-8", newline="") as stream:
        writer = csv.writer(stream, lineterminator="\n")
        writer.writerow(columns)
        writer.writerows(rows)


def generate(root):
    sites, measurements = fixture()
    write_csv(root / "sites.csv", ("site_id", "technology", "capacity_kw"), sites)
    write_csv(root / "measurements.csv", ("site_id", "day", "peak_sun_hours", "energy_kwh", "status"), measurements)


def read_csv(root, name, columns):
    with (root / name).open(encoding="utf-8", newline="") as stream:
        reader = csv.DictReader(stream)
        if tuple(reader.fieldnames or ()) != columns:
            raise ValueError(f"{name} columns must be {','.join(columns)}")
        rows = list(reader)
        if any(None in row or any(value is None for value in row.values()) for row in rows):
            raise ValueError(f"{name} has an invalid row width")
        return [tuple(row[key] for key in columns) for row in rows]


def json_file(root, name):
    return json.loads((root / name).read_text(encoding="utf-8"))


def equal_number(value, expected):
    return type(value) in (int, float) and math.isclose(value, expected, rel_tol=0, abs_tol=1e-6)


def audit(root):
    sites, measurements = fixture()
    site_lookup = {site: (technology, capacity) for site, technology, capacity in sites}
    expected_clean = {}
    expected_yields = {site: [] for site in site_lookup}
    for site, day, sun, energy, status in measurements:
        if status == "ok":
            tech, capacity = site_lookup[site]
            result = float(energy) / (sun * capacity)
            expected_clean[site, day] = tech, result
            expected_yields[site].append(result)
    expected_qc = {site: (tech, len(expected_yields[site]), mean(expected_yields[site])) for site, tech, _ in sites}
    errors = [[] for _ in range(4)]
    facts = [{} for _ in range(3)]
    handoff = [{} for _ in range(3)]
    try:
        input_sites = read_csv(root, "sites.csv", ("site_id", "technology", "capacity_kw"))
        input_measurements = read_csv(root, "measurements.csv", ("site_id", "day", "peak_sun_hours", "energy_kwh", "status"))
        if input_sites != [tuple(map(str, row)) for row in sites] or input_measurements != [tuple(map(str, row)) for row in measurements]:
            raise ValueError("original input fixture changed")
        clean_rows = read_csv(root, "daily_clean.csv", CLEAN_COLUMNS)
        clean = {(site, int(day)): (tech, float(index)) for site, day, tech, index in clean_rows}
        if len(clean_rows) != len(clean) or clean.keys() != expected_clean.keys() or any(
            clean[key][0] != tech or not equal_number(clean[key][1], ratio) for key, (tech, ratio) in expected_clean.items()
        ):
            raise ValueError("daily_clean.csv has incorrect daily joins, exclusions or index values")
        qc_rows = read_csv(root, "site_qc.csv", QC_COLUMNS)
        qc = {site: (tech, int(days), int(valid), int(excluded), float(index)) for site, tech, days, valid, excluded, index in qc_rows}
        if len(qc_rows) != len(qc) or qc.keys() != expected_qc.keys() or any(
            qc[site][:4] != (tech, 4, valid, 4 - valid) or not equal_number(qc[site][4], ratio)
            for site, (tech, valid, ratio) in expected_qc.items()
        ):
            raise ValueError("site_qc.csv has incorrect per-site counts or means")
        facts[0] = {"site_count": len(qc), "valid_days": len(clean), "excluded_days": len(measurements) - len(clean)}
        handoff[0] = {
            "accepted": "Daily joins, exclusions and per-site QC",
            "per_site_source": "site_qc.csv (technology, expected_days, valid_days, mean_index)",
            "complete_site_rule": "valid_days == expected_days == 4",
            **{f"{group}_incomplete_sites": sum(row[0] == group and row[2] != row[1] for row in qc.values()) for group in GROUPS},
        }
    except (OSError, ValueError, KeyError, TypeError) as error:
        errors[0].append(str(error))
    winners = []
    for i, name in enumerate(("groups.json", "sensitivity.json"), 1):
        subset = {g: [ratio for tech, n, ratio in expected_qc.values() if tech == g and (i == 1 or n == 4)] for g in GROUPS}
        winners.append(max(GROUPS, key=lambda group: mean(subset[group])))
        try:
            actual = json_file(root, name)
            for group, ratios in subset.items():
                item = actual[group]
                if not equal_number(item["sites"], len(ratios)) or not equal_number(item["mean_index"], mean(ratios)):
                    raise ValueError(f"{name} has incorrect site count or unweighted site mean for {group}")
            facts[i] = {"top_technology": winners[-1], "site_count": sum(map(len, subset.values()))}
            handoff[i] = {
                "accepted": "All-site group comparison" if i == 1 else "Complete-site sensitivity comparison",
                "aggregation": "Unweighted mean of site-level indices",
                **{f"{group}_{field}": actual[group][field] for group in GROUPS for field in ("sites", "mean_index")},
            }
        except (OSError, ValueError, KeyError, TypeError) as error:
            errors[i].append(str(error))
    try:
        report = (root / "solar_report.md").read_text(encoding="utf-8")
        if not all(name in report for name in ARTIFACTS):
            raise ValueError("Report must cite all four supporting artifacts")
        for label, winner in zip(("top_technology", "complete_site_top_technology"), winners):
            if re.findall(rf"^\s*{label}:\s*(\w+)\s*$", report, flags=re.M) != [winner]:
                raise ValueError(f"Report has an incorrect or missing {label}")
    except (OSError, ValueError) as error:
        errors[3].append(str(error))
    return {"errors": errors, "facts": facts, "handoff": handoff}


if __name__ == "__main__":
    action, directory = sys.argv[1:]
    if action == "generate":
        generate(Path(directory))
    elif action == "audit":
        print(json.dumps(audit(Path(directory))))
    else:
        sys.exit(f"Unknown solar fixture action {action}")
