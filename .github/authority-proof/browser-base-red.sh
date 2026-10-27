#!/usr/bin/env bash
set -euo pipefail
proof_output=${1:?evidence directory required}
repo=$PWD
base=${2:?exact base commit required}
[[ $base =~ ^[a-f0-9]{40}$ ]]
baseline="$proof_output/base-red-worktree"
git worktree add --detach "$baseline" "$base"
trap 'git worktree remove --force "$baseline"' EXIT
ln -s "$repo/node_modules" "$baseline/node_modules"
ln -s "$repo/ui/node_modules" "$baseline/ui/node_modules"
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
assert.equal(failures.length,2,"only the two fresh-input regressions should fail on main");
for(const test of failures) {
  assert.match(test.fullName,/sends current .* without consuming the recovery marker/);
  assert.match(test.failureMessages.join("\n"),/__controlUiReconnectResume/);
}
assert.equal(tests.filter(test=>test.status==="passed").length,3);
console.log("PASS base-red: both fresh-input regressions fail on the recovery marker; all three negative controls pass");
JS
