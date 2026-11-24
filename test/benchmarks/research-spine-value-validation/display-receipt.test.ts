import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { findDisplayEvidence, findDisplayReceipt, retireDisplayEvidence } from "./display-receipt.ts";

const table = Buffer.from("id,valid\r\ns1,3\r\ns2,4\r\n");
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const version = hash(table);
const call = { role: "assistant", tool_calls: [{ id: "display", function: { name: "run_shell" } }] };
const result = (stdout: string, fields: Record<string, unknown> = {}) => ({ role: "tool", name: "run_shell", tool_call_id: "display",
  content: JSON.stringify({ executionId: "display", state: "completed", exitCode: 0, ...fields }) + "\nstdout:\n" + stdout });
const complete = result("QC summary\nid,valid\ns1,3\ns2,4\n");

test("display receipt binds the paired result bytes to the accepted artifact revision", () => {
  assert.deepEqual(findDisplayReceipt([call, complete], table, version), {
    toolCallId: "display", contentSha256: hash(complete.content), artifactSha256: version,
  });
  assert.equal(findDisplayReceipt([call, complete], table, hash("other version")), undefined);
  assert.equal(findDisplayReceipt([call, complete], Buffer.from("id,valid\ns1,4\ns2,4\n"), version), undefined);
});

test("failed, partial, stderr-only or unpaired displays leave the review pending", () => {
  const fixtures = [[call, result(table.toString(), { exitCode: 1 })], [call, result("id,valid\ns1,3\n")],
    [call, result("no review\nstderr:\n" + table.toString())], [call, result(table.toString(), { executionId: "other" })],
    [complete], [complete, call], [call, call, complete], [call, complete, complete]];
  for (const history of fixtures) assert.equal(findDisplayReceipt(history, table, version), undefined);
});


test("display evidence retains only the matching call and its original result", () => {
  const extraCall = { id: "unrelated", function: { name: "run_shell", arguments: "{}" } };
  const displayCall = { id: "display", function: { name: "run_shell", arguments: '{"command":"cat site_qc.csv"}' } };
  const assistant = { role: "assistant", content: "Previous reasoning", tool_calls: [extraCall, displayCall] };
  const otherResult = { ...complete, tool_call_id: "unrelated", content: "unrelated output" };
  const evidence = findDisplayEvidence([assistant, otherResult, complete], table, version);
  assert.deepEqual(evidence?.messages, [{ role: "assistant", content: null, tool_calls: [displayCall] }, complete]);
  assert.notEqual(evidence?.messages[1], complete);
});


test("retirement removes only the intact selected pair and is idempotent", () => {
  const evidence = findDisplayEvidence([call, complete], table, version)!;
  const user = { role: "user", content: "Continue." };
  const groupResult = { role: "tool", name: "run_shell", tool_call_id: "group", content: "group output" };
  const history = [...evidence.messages, user, groupResult];
  const projected = retireDisplayEvidence(history, evidence.receipt);
  assert.deepEqual(projected, [user, groupResult]);
  assert.equal(history.length, 4);
  assert.equal(retireDisplayEvidence(projected, evidence.receipt), projected);
  const bad = [evidence.messages[0], { ...evidence.messages[1], content: "wrong" }, user];
  assert.equal(retireDisplayEvidence(bad, evidence.receipt), bad);
  const ambiguous = [...evidence.messages, ...evidence.messages];
  assert.equal(retireDisplayEvidence(ambiguous, evidence.receipt), ambiguous);
});
