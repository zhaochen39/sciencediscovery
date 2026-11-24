// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { test } from "node:test";
import { researchCheckpointContract } from "./research-workflows.js";

test("resolve only explicitly registered research contracts", () => {
  for (const id of ["solar", "calibration", "citations"]) assert.equal(researchCheckpointContract(id)?.version, 1);
  for (const id of [null, false, "__proto__", "toString", "unregistered", ""]) assert.equal(researchCheckpointContract(id), undefined);
});

test("citation verifier rejects fabricated metadata, reordered or stale evidence and incorrect delivery", () => {
  const profile = researchCheckpointContract("citations")!;
  const source = { doi: "10.1000/reference", title: "Example study", year: 2026 };
  const claims = [{ ...source, title: "EXAMPLE  study" }, { doi: "10.1000/missing", title: "Other study", year: 2025 }];
  const expected = [
    { doi: "10.1000/reference", title_match: true, year_match: true, status: "match" },
    { doi: "10.1000/missing", title_match: null, year_match: null, status: "unresolved" },
  ];
  const json = (value: unknown) => Buffer.from(JSON.stringify(value));
  const quality = new Map([
    ["doi_metadata.json", json([source])],
    ["bibliography.json", json(claims)],
    ["citation_sources.tsv", Buffer.from("doi\ttitle\tyear\n10.1000/reference\tExample study\t2026\n")],
  ]);
  assert.equal(profile.acceptQuality(quality), true);
  assert.equal(profile.acceptQuality(new Map([...quality, ["doi_metadata.json", json([source, source])]])), false);
  assert.equal(profile.acceptQuality(new Map([...quality, ["doi_metadata.json", json([{ ...source, year: 2024 }])]])), false);
  const downstream = new Map([...quality, ["citation_audit.json", json(expected)]]);
  assert.equal(profile.acceptDownstream(downstream), true);
  assert.equal(profile.acceptDownstream(new Map([...downstream, ["citation_audit.json", json(expected.toReversed())]])), false);
  assert.equal(profile.acceptDownstream(new Map([...downstream, ["citation_audit.json", json([{ ...expected[0], year_match: false }, expected[1]])]])), false);
  const summary = { total: 2, match: 1, mismatch: 0, unresolved: 1 };
  assert.equal(profile.acceptDelivery(new Map([...downstream, ["citation_summary.json", json(summary)]])), true);
  assert.equal(profile.acceptDelivery(new Map([...downstream, ["citation_summary.json", json({ ...summary, unresolved: 0 })]])), false);
});
