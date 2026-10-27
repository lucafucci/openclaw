#!/usr/bin/env bash
set -euo pipefail
proof_output=${1:?evidence directory required}
base=${2:?exact base commit required}
[[ $base =~ ^[a-f0-9]{40}$ ]]
baseline="$proof_output/base-red-worktree"
git worktree add --detach "$baseline" "$base"
trap 'git worktree remove --force "$baseline"' EXIT
# Workspace packages own their dependencies (for example markdown-core's micromark).
# Install the base's frozen graph so workspace links cannot borrow candidate source.
pnpm --dir "$baseline" install --frozen-lockfile
cp ui/src/pages/chat/chat-send-submit.test.ts "$baseline/ui/src/pages/chat/chat-send-submit.test.ts"
# Execute the committed regression against unchanged main production code.
set +e
pnpm --dir "$baseline/ui" test --maxWorkers=1 src/pages/chat/chat-send-submit.test.ts --testNamePattern='fresh input after reconnect' --reporter=json --outputFile="$proof_output/base-red-vitest.json"
result=$?
set -e
[[ $result == 1 ]]
node --input-type=module - "$proof_output/base-red-vitest.json" <<'JS'
import fs from "node:fs";
import assert from "node:assert/strict";
const report=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
const tests=report.testResults.flatMap(file=>file.assertionResults).filter(test=>test.status!=="pending"&&test.status!=="skipped");
const failures=tests.filter(test=>test.status==="failed");
assert.equal(tests.length,5,"all five recovery contracts must execute");
const expectedFailures = [
  "resumes the displayed session for current List my automations as fresh input",
  "resumes the displayed session for current /approve approval-1 allow-once as fresh input",
  "keeps a restored offline submission marked as recovery",
  "does not treat an explicit retry of failed input as a fresh submission",
];
assert.equal(failures.length,4,"fresh input, restored input, and explicit retry must fail on main");
assert.deepEqual(failures.map(test=>test.title).sort(),expectedFailures.sort());
for(const test of failures) {
  assert.match(test.failureMessages.join("\n"),/__controlUiReconnectResume/);
}
const passed=tests.filter(test=>test.status==="passed");
assert.deepEqual(passed.map(test=>test.title),[
  "does not retain fresh authority across a connection change during preparation",
]);
console.log("PASS base-red: all four expected regressions fail on the recovery marker; the connection-change control passes");
JS
