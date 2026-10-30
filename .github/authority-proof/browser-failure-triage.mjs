import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Replay the existing failing assertions unchanged. Passing alone does not establish
// a repair or rule out an earlier-file interaction in the original broad shard.
const cases = {
  "tools-loading": {
    file: "ui/src/e2e/settings-loading-skeletons.e2e.test.ts",
    title: "renders both Agent Tools data loads as skeletons",
    config: "test/vitest/vitest.ui-e2e.config.ts",
    runtime: "node",
  },
  "context-desktop": {
    file: "ui/src/e2e/session-context-breakdown.e2e.test.ts",
    title: "shows a scoped, non-overlapping breakdown (1440 px)",
    config: "test/vitest/vitest.ui-e2e.config.ts",
    runtime: "node",
  },
  "context-mobile": {
    file: "ui/src/e2e/session-context-breakdown.e2e.test.ts",
    title: "shows a scoped, non-overlapping breakdown (390 px)",
    config: "test/vitest/vitest.ui-e2e.config.ts",
    runtime: "node",
  },
};

const output = process.env.TRIAGE_OUTPUT;
assert.ok(output, "TRIAGE_OUTPUT is required");
const revision = process.env.TRIAGE_REVISION;
const side = process.env.TRIAGE_SIDE;
assert.equal(
  revision,
  {
    base: "24fa8e716fc4d8b655a21d8edd063c50f04efcfb",
    candidate: "a6edbf2109ae92b1cd7a8fd936f87778322c96f0",
  }[side],
);
assert.ok(side === "base" || side === "candidate");
assert.equal(spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(), revision);
const sourceSha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const resultPath = (id) => path.join(output, `${id}-result.json`);
const write = (file, data) => fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
const [mode, id] = process.argv.slice(2);

if (mode === "run") {
  assert.ok(Object.hasOwn(cases, id), "Unknown triage case");
  const selected = cases[id];
  const report = path.join(output, `${id}-vitest.json`);
  assert.ok(
    !fs.existsSync(report) && !fs.existsSync(resultPath(id)),
    "Do not overwrite an attempt",
  );
  const args = [
    "scripts/run-vitest.mjs",
    "run",
    "--config",
    selected.config,
    "--configLoader",
    "runner",
    selected.file,
    "--maxWorkers=1",
    "--testNamePattern",
    `${selected.title.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`,
    "--reporter=default",
    "--reporter=json",
    `--outputFile=${report}`,
  ];
  const log = fs.openSync(path.join(output, `${id}.log`), "wx");
  console.log(`Starting ${side}/${id}: ${selected.title} (${selected.runtime})`);
  const started = Date.now();
  let child;
  try {
    child = spawnSync(process.execPath, args, {
      env: { ...process.env, OPENCLAW_VITEST_RUNTIME: selected.runtime },
      stdio: ["ignore", log, log],
    });
  } finally {
    fs.closeSync(log);
  }
  let assertions = [];
  let reportError;
  try {
    const parsed = JSON.parse(fs.readFileSync(report, "utf8"));
    assertions = parsed.testResults
      .flatMap((suite) => suite.assertionResults)
      .filter((test) => test.title === selected.title);
  } catch (error) {
    reportError = String(error);
  }
  const assertion = assertions.length === 1 ? assertions[0] : undefined;
  const outcome =
    assertion?.status === "failed"
      ? "failed"
      : assertion?.status === "passed" && child.status === 0
        ? "passed"
        : "incomplete";
  const result = {
    side,
    revision,
    id,
    ...selected,
    sourceSha256: sourceSha256(selected.file),
    args,
    outcome,
    elapsedMs: Date.now() - started,
    exitCode: child.status,
    signal: child.signal,
    error: child.error?.message,
    reportError,
    matchedAssertions: assertions.length,
    assertions: assertions.map(({ fullName, status, failureMessages }) => ({
      fullName,
      status,
      failureMessages,
    })),
  };
  write(resultPath(id), result);
  console.log(JSON.stringify(result, null, 2));
  // Keep ordinary failures red while the workflow's later cases still run.
  process.exitCode = outcome === "passed" ? 0 : child.status || 1;
} else {
  assert.equal(mode, "summary");
  const results = Object.keys(cases).map((caseId) =>
    fs.existsSync(resultPath(caseId))
      ? JSON.parse(fs.readFileSync(resultPath(caseId), "utf8"))
      : { id: caseId, outcome: "not_run" },
  );
  const summary = {
    side,
    revision,
    scope: "Supplemental 3 of 9 original failing cases; the initial 6 are not rerun.",
    initialComparison: "https://github.com/lucafucci/openclaw/actions/runs/41086999798",
    sources: Object.fromEntries(Object.values(cases).map(({ file }) => [file, sourceSha256(file)])),
    originalRun: "https://github.com/openclaw/openclaw/actions/runs/41081967801",
    limitation:
      "Focused replay excludes other files and original shard concurrency/order. A pass is not proof of a fix.",
    results,
  };
  write(path.join(output, "summary.json"), summary);
  const lines = [
    `### Supplemental browser failure triage: ${side}`,
    "",
    `Revision: \`${revision}\``,
    "",
    summary.scope,
    "",
    "| Case | Outcome |",
    "| --- | --- |",
    ...results.map((result) => `| ${result.id} | ${result.outcome} |`),
    "",
    summary.limitation,
    "",
  ];
  console.log(lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n"));
  }
  process.exitCode = results.every((result) => result.outcome === "passed") ? 0 : 1;
}
