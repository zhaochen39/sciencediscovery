// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

export interface CitationRecord {
  doi: string;
  title: string;
  year: number;
}

const normalize = (value: string) => value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();

function records(files: ReadonlyMap<string, Buffer>, name: string): CitationRecord[] {
  const value: unknown = JSON.parse(files.get(name)?.toString("utf8") ?? "");
  if (!Array.isArray(value) || value.length === 0 || value.length > 500) throw new Error("Invalid citation list");
  for (const entry of value) {
    if (!entry || typeof entry.doi !== "string" || !/^10\.\d{4,9}\/[^\s\u0000-\u001f]+$/u.test(entry.doi)
      || typeof entry.title !== "string" || !entry.title.trim() || /[\t\r\n\0]/u.test(entry.title)
      || !Number.isInteger(entry.year) || entry.year < 1500 || entry.year > 2200) throw new Error("Invalid citation record");
  }
  if (new Set(value.map(entry => entry.doi.toLowerCase())).size !== value.length) throw new Error("Duplicate DOI");
  return value;
}

function verify(fn: (files: ReadonlyMap<string, Buffer>) => boolean) {
  return (files: ReadonlyMap<string, Buffer>) => {
    try { return fn(files); }
    catch { return false; }
  };
}

export const citationWorkflow = {
  version: 1,
  pilotEligible: false,
  table: "citation_sources.tsv",
  inputs: ["bibliography.json", "doi_metadata.json", "citation_sources.tsv"],
  outputs: ["citation_audit.json", "citation_summary.json"],
  acceptQuality: verify(files => {
    records(files, "bibliography.json");
    const source = records(files, "doi_metadata.json");
    const table = "doi\ttitle\tyear\n" + source.map(row => `${row.doi.toLowerCase()}\t${row.title}\t${row.year}\n`).join("");
    return files.get("citation_sources.tsv")?.toString("utf8") === table;
  }),
  acceptDownstream: verify(files => {
    const source = new Map(records(files, "doi_metadata.json").map(row => [row.doi.toLowerCase(), row]));
    const bibliography = records(files, "bibliography.json");
    const audit: unknown = JSON.parse(files.get("citation_audit.json")?.toString("utf8") ?? "");
    return Array.isArray(audit) && audit.length === bibliography.length && bibliography.every((row, index) => {
      const doi = row.doi.toLowerCase();
      const reference = source.get(doi);
      const title = reference ? normalize(row.title) === normalize(reference.title) : null;
      const year = reference ? row.year === reference.year : null;
      const item = audit[index];
      return item && Object.keys(item).length === 4 && item.doi === doi && item.title_match === title
        && item.year_match === year && item.status === (!reference ? "unresolved" : title && year ? "match" : "mismatch");
    });
  }),
  acceptDelivery: verify(files => {
    if (!citationWorkflow.acceptDownstream(files)) return false;
    const audit = JSON.parse(files.get("citation_audit.json")!.toString("utf8")) as { status: string }[];
    const summary = JSON.parse(files.get("citation_summary.json")?.toString("utf8") ?? "");
    return summary && Object.keys(summary).length === 4 && summary.total === audit.length
      && ["match", "mismatch", "unresolved"].every(status => summary[status] === audit.filter(item => item.status === status).length);
  }),
  handoff: "Continue the citation audit after validated publication metadata was displayed. Compare the submitted bibliography with the frozen metadata. Preserve the accepted input files and begin with citation_audit.json.",
};
