export const citationPrompt = `Perform the first stage of a literature citation audit in the current workspace. The supplied doi_metadata.json is a frozen Crossref snapshot with DOI, title, and year. bibliography.json contains references to check in a later stage. Use only run_shell and Python's standard library.
1. Read doi_metadata.json and create citation_sources.tsv with header doi<TAB>title<TAB>year and one line per metadata record in input order, lowercase DOI and preserve each title exactly. Use UTF-8 and one final newline. Do not change either JSON input. In a separate read-only run_shell call, display the entire citation_sources.tsv with cat. Once it is displayed, stop naturally. A later request will handle the citation comparison and summary.`;

export const citationResume = `Continue the citation audit. Preserve bibliography.json, doi_metadata.json, and citation_sources.tsv. The accepted table was displayed in the source run. Use only run_shell and Python's standard library. Read the accepted TSV inside the first calculation. Create citation_audit.json as an array in bibliography order. Each row must have exactly the keys doi (lowercase), title_match, year_match, status. Compare titles after Unicode NFKC normalization, trimming, whitespace collapsing, and lowercasing. Years must match exactly. Use status match if both match, mismatch if either differs, and unresolved with both matches null if the DOI is absent from the frozen metadata. In a separate tool call, write citation_summary.json with integer keys total, match, mismatch, unresolved derived from the audit. Finish naturally with a short message once both outputs are written. Do not repeat the table display.`;

export const citationCommands = [String.raw`python3 - <<'PY'
import csv, json, unicodedata
with open('citation_sources.tsv', encoding='utf-8') as f:
    sources = {row['doi']: row for row in csv.DictReader(f, delimiter='\t', quoting=csv.QUOTE_NONE)}
with open('bibliography.json', encoding='utf-8') as f:
    bibliography = json.load(f)
def normalize(title):
    return ' '.join(unicodedata.normalize('NFKC', title).lower().split())
audit = []
for row in bibliography:
    doi = row['doi'].lower()
    reference = sources.get(doi)
    title = normalize(row['title']) == normalize(reference['title']) if reference else None
    year = row['year'] == int(reference['year']) if reference else None
    status = 'unresolved' if reference is None else 'match' if title and year else 'mismatch'
    audit.append(dict(doi=doi, title_match=title, year_match=year, status=status))
with open('citation_audit.json', 'w', encoding='utf-8') as f:
    json.dump(audit, f)
PY`, String.raw`python3 - <<'PY'
import json
with open('citation_audit.json', encoding='utf-8') as f:
    audit = json.load(f)
summary = {'total': len(audit), **{key: sum(row['status'] == key for row in audit) for key in ('match', 'mismatch', 'unresolved')}}
with open('citation_summary.json', 'w', encoding='utf-8') as f:
    json.dump(summary, f)
PY`];
