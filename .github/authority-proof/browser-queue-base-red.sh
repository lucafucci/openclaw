#!/usr/bin/env bash
set -euo pipefail
proof_output=${1:?evidence directory required}
base=${2:?previous PR commit required}
[[ $base == 436ef3edba92532ebd95114bbcc0a5a0fa1f5aa5 ]]
baseline="$proof_output/queue-base-red-worktree"
git worktree add --detach "$baseline" "$base"
trap 'git worktree remove --force "$baseline"' EXIT
# The previous published PR supplies production and its own frozen dependency graph.
pnpm --dir "$baseline" install --frozen-lockfile
cp ui/src/pages/chat/chat-send-submit.test.ts "$baseline/ui/src/pages/chat/chat-send-submit.test.ts"
set +e
pnpm --dir "$baseline/ui" test --maxWorkers=1 src/pages/chat/chat-send-submit.test.ts --testNamePattern='retains online Queue submission authority|does not treat an explicit retry of failed|keeps failed pre-transport steer retries recovered' --reporter=json --outputFile="$proof_output/queue-base-red-vitest.json"
result=$?
set -e
[[ $result == 1 ]]
node --input-type=module - "$proof_output/queue-base-red-vitest.json" <<'JS'
import fs from "node:fs";
import assert from "node:assert/strict";
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const tests = report.testResults.flatMap(file => file.assertionResults)
  .filter(test => test.status !== "pending" && test.status !== "skipped");
assert.equal(tests.length, 6, "all Queue and retry controls must execute");
const failures = tests.filter(test => test.status === "failed");
assert.deepEqual(failures.map(test => test.title), [
  "retains online Queue submission authority only in its original document and connection (current)",
]);
assert.match(failures[0].failureMessages.join("\n"), /__controlUiReconnectResume/);
assert.deepEqual(tests.filter(test => test.status === "passed").map(test => test.title).sort(), [
  "retains online Queue submission authority only in its original document and connection (reconnected)",
  "retains online Queue submission authority only in its original document and connection (reloaded)",
  "does not treat an explicit retry of failed durable input as a fresh submission",
  "does not treat an explicit retry of failed memory input as a fresh submission",
  "keeps failed pre-transport steer retries recovered",
].sort());
console.log("PASS Queue base-red: live queued input loses freshness on previous PR; reconnect, reload, durable/memory and pre-transport steer retry controls pass");
JS
