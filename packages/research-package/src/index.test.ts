import test from "node:test";
import assert from "node:assert/strict";
import { createResearchPackage, importResearchPackage, inspectResearchPackage, sha256 } from "./index.js";
import { createPluginScope } from "@sciencediscovery/plugin-sdk";
import { researchPackagePlugin } from "./plugin.js";

test("exports and imports a deterministic evidence package", () => {
  const object = new TextEncoder().encode("print('hello')\n");
  const input = { source: { projectId: "p1", sessionIds: ["s1"], title: "Demo" }, createdAt: "2026-01-01T00:00:00.000Z",
    records: { claims: [{ id: "c1", text: "A result" }], provenance: { runId: "r1" } }, objects: [{ path: `objects/${sha256(object)}`, bytes: object }] };
  const first = createResearchPackage(input); const second = createResearchPackage(input);
  assert.deepEqual(first.bytes, second.bytes);
  const inspection = inspectResearchPackage(first.bytes); assert.equal(inspection.valid, true); assert.equal(inspection.objectCount, 1);
  const imported = importResearchPackage(first.bytes); assert.deepEqual(imported.records, input.records); assert.deepEqual(imported.objects.get(sha256(object)), object);
  assert.equal(imported.manifest.packageKind, "evidence"); assert.equal(imported.receipt.sourcePackageChecksum, first.receipt.packageChecksum);
});

test("rejects tampered package bytes and unsafe objects", () => {
  const object = new TextEncoder().encode("data");
  const result = createResearchPackage({ source: { projectId: "p", title: "x" }, records: {}, objects: [{ path: sha256(object), bytes: object }] });
  const tampered = Uint8Array.from(result.bytes); tampered[tampered.length - 20] = (tampered[tampered.length - 20]! ^ 1);
  assert.throws(() => inspectResearchPackage(tampered), /Invalid|checksum|archive/);
  assert.throws(() => createResearchPackage({ source: { projectId: "p", title: "x" }, records: {}, objects: [{ path: "objects/not-a-hash", bytes: object }] }), /SHA-256/);
});

test("exposes the provider through the trusted plugin host", async () => {
  const scope = await createPluginScope([researchPackagePlugin]);
  assert.equal(scope.manifests[0]?.id, "research-package");
  assert.equal(scope.contributions[0]?.provider.extension, ".sdresearch");
  await scope.dispose();
});
