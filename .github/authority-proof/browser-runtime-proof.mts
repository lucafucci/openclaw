import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { X509Certificate, randomUUID } from "node:crypto";
import { openSync, closeSync } from "node:fs";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as tcpServer, connect as tcpConnect } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const repo = process.cwd();
const output = path.resolve(process.argv[2]);
const root = await fs.mkdtemp(path.join(output, "runtime-state-"));
const state = path.join(root, "state");
const home = path.join(root, "home");
const workspace = path.join(root, "workspace");
await Promise.all([state, home, workspace].map((p) => fs.mkdir(p, { recursive: true })));
const configPath = path.join(state, "openclaw.json");
// Client credentials also belong to this disposable proof, never the operator's state.
process.env.OPENCLAW_STATE_DIR = state;
process.env.OPENCLAW_CONFIG_PATH = configPath;
const load = (p: string) => import(pathToFileURL(path.join(repo, p)).href);
const { GatewayClient } = await load("src/gateway/client.ts");
const { loadOrCreateDeviceIdentity } = await load("src/infra/device-identity.ts");
const { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } = await load("test/helpers/tls-fixture.ts");
const { writeToolCall } = await load("src/gateway/gateway-provider-fixture.test-support.ts");
const { writeOpenAiResponsesText } = await load("test/helpers/openai-responses-sse.ts");
const { createOpenAiResponsesModelConfig } = await load(
  "test/helpers/openai-responses-model-fixture.ts",
);
const certPath = path.join(root, "cert.pem");
const keyPath = path.join(root, "key.pem");
await fs.writeFile(certPath, TEST_TLS_CERT_PEM);
await fs.writeFile(keyPath, TEST_TLS_KEY_PEM, { mode: 0o600 });
const tlsFingerprint = new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256;
const token = "synthetic-disposable-runtime-gateway-token";
const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const checks: Record<string, boolean> = {};
const record = (name: string) => {
  checks[name] = true;
  console.log(`PASS ${name}`);
};
let phase: any;
let calls = 0;
let outputs: string[] = [];
let release: (() => void) | undefined;
let entered: (() => void) | undefined;
let held: Promise<void>;
let modelEntered: Promise<void>;
let providerFailure: unknown;
const provider = createServer((request, response) => {
  void (async () => {
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (body.model === "metadata") {
      writeOpenAiResponsesText(response, {
        text: "Automation proof",
        messageId: randomUUID(),
        responseId: randomUUID(),
      });
      return;
    }
    assert.equal(body.model, "operator");
    assert.ok(phase, "unexpected model call outside a scenario");
    outputs.push(
      ...(body.input ?? [])
        .filter((x: any) => x.type === "function_call_output")
        .map((x: any) => x.output ?? ""),
    );
    calls++;
    if (calls === 1) {
      if (phase.revoke) {
        entered!();
        await held;
      }
      writeToolCall(response, "automations", {
        action: phase.action,
        jobId: phase.jobId,
        ...(phase.job ? { job: phase.job } : {}),
      });
    } else {
      writeOpenAiResponsesText(response, {
        text: "Automation proof complete.",
        messageId: randomUUID(),
        responseId: randomUUID(),
      });
    }
  })().catch((error) => {
    providerFailure = error;
    response.writeHead(500).end("Synthetic provider failure");
  });
});
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
const providerPort = (provider.address() as any).port;
const reservation = tcpServer();
await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
const port = (reservation.address() as any).port;
await new Promise<void>((resolve) => reservation.close(() => resolve()));
const config = createOpenAiResponsesModelConfig({
  baseUrl: `http://127.0.0.1:${providerPort}`,
  providerId: "runtime-proof",
  modelId: "operator",
  reasoning: false,
  toolProfile: "full",
});
config.agents.defaults.workspace = workspace;
config.agents.defaults.utilityModel = "runtime-proof/metadata";
config.agents.defaults.contextInjection = "never";
config.agents.defaults.models["runtime-proof/metadata"] = { agentRuntime: { id: "openclaw" } };
config.models.providers["runtime-proof"].models.push({
  ...config.models.providers["runtime-proof"].models[0],
  id: "metadata",
  name: "metadata",
});
config.models.catalogRefresh = { enabled: false };
config.agents.entries = { main: {} };
config.tools = { allow: ["automations"], codeMode: false, toolSearch: false };
config.update = { checkOnStart: false };
config.plugins = { allow: ["openai"], slots: { memory: "none" } };
config.gateway = {
  mode: "local",
  auth: { mode: "token", token },
  trustedProxies: ["127.0.0.1"],
  tls: { enabled: true, autoGenerate: false, certPath, keyPath },
  controlUi: { enabled: false, allowedOrigins: ["https://control-ui.fixture.invalid"] },
};
await fs.writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
// Normal compiled entrypoint. No Vitest, minimal-Gateway or skip-subsystem environment flags.
const env = {
  PATH: process.env.PATH,
  HOME: home,
  LANG: "C.UTF-8",
  OPENCLAW_STATE_DIR: state,
  OPENCLAW_CONFIG_PATH: configPath,
  OPENCLAW_GATEWAY_TOKEN: token,
};
const logFd = openSync(path.join(output, "gateway-runtime.log"), "w", 0o600);
const child = spawn(
  process.execPath,
  ["dist/index.js", "gateway", "run", "--port", String(port), "--bind", "loopback"],
  { cwd: repo, env, stdio: ["ignore", logFd, logFd], detached: true },
);
closeSync(logFd);
const childDone = new Promise<void>((resolve) => child.once("close", () => resolve()));
let childError: Error | undefined;
child.once("error", (error) => {
  childError = error;
});
const clients: any[] = [];
async function connect(options: any) {
  let client: any;
  try {
    return await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Client handshake deadline exceeded")),
        30_000,
      );
      client = new GatewayClient({
        url: `wss://127.0.0.1:${port}`,
        token,
        tlsFingerprint,
        clientName: "cli",
        mode: "cli",
        scopes: ["operator.admin"],
        ...options,
        onHelloOk: (hello: any) => {
          clearTimeout(timer);
          resolve({ client, hello });
        },
        onConnectError: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      clients.push(client);
      client.start();
    });
  } catch (error) {
    await client?.stopAndWait();
    throw error;
  }
}
async function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: any;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
try {
  const deadline = Date.now() + 120_000;
  let listening = false;
  while (Date.now() < deadline) {
    if (childError) throw childError;
    assert.equal(child.exitCode, null, "compiled Gateway exited before readiness");
    listening = await new Promise<boolean>((resolve) => {
      const socket = tcpConnect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (listening) break;
    await delay(200);
  }
  assert.ok(listening, "compiled Gateway never bound");
  const local = await connect({
    deviceIdentity: loadOrCreateDeviceIdentity({
      path: path.join(state, "bootstrap", "client", "credentials.sqlite"),
    }),
  });
  const admin = local.client;
  await admin.request("health", {});
  record("compiled_gateway_authenticated_rpc");
  const job = await admin.request("cron.add", {
    name: "Foreign-session confidential fixture",
    enabled: false,
    schedule: { kind: "every", everyMs: 3600000 },
    sessionTarget: "session:agent:main:foreign-owner",
    sessionKey: "agent:main:foreign-owner",
    payload: { kind: "agentTurn", message: "Foreign private payload" },
    delivery: { mode: "none" },
  });
  async function controlUi(name: string, scopes: string[]) {
    const identity = loadOrCreateDeviceIdentity({
      path: path.join(state, name, "client", "credentials.sqlite"),
    });
    const options = {
      clientName: "openclaw-control-ui",
      mode: "webchat",
      platform: "browser",
      origin: "https://control-ui.fixture.invalid",
      scopes,
      deviceIdentity: identity,
      edgeAuthHeaders: { "x-forwarded-for": "203.0.113.42", "x-forwarded-proto": "https" },
    };
    let pairError: any;
    try {
      await connect(options);
    } catch (error) {
      pairError = error;
    }
    assert.ok(pairError, "remote Control UI must require explicit pairing");
    const pending = await admin.request("device.pair.list", {});
    const request = pending.pending.find((item: any) => item.deviceId === identity.deviceId);
    assert.ok(request, "remote handshake must create a real pairing request");
    await admin.request("device.pair.approve", { requestId: request.requestId });
    const connected = await connect(options);
    assert.deepEqual(connected.hello.auth.scopes, scopes);
    return { client: connected.client, identity };
  }
  let manager = await controlUi("manager", ["operator.admin"]);
  const writer = await controlUi("writer", ["operator.write"]);
  record("remote_control_ui_pairing_and_effective_scopes");
  async function run(client: any, label: string, action: string, revoke = false) {
    phase = {
      action,
      jobId: job.id,
      ...(action === "update" ? { job: { name: `${label} update` } } : {}),
      revoke,
    };
    calls = 0;
    outputs = [];
    if (revoke) {
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
      modelEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
    }
    const started = await client.request("chat.send", {
      sessionKey: `agent:main:runtime-${label}-${action}`,
      message: `${action} the existing automation`,
      idempotencyKey: randomUUID(),
    });
    if (revoke) {
      await bounded(modelEntered, 60_000, "revocation gate not reached");
      await admin.request("device.token.revoke", {
        deviceId: manager.identity.deviceId,
        role: "operator",
      });
      release!();
    }
    const finished = await admin.request(
      "agent.wait",
      { runId: started.runId, timeoutMs: 60000 },
      { timeoutMs: 65000 },
    );
    assert.notEqual(finished.status, "timeout", "agent did not finish");
    if (revoke) {
      console.log(
        "Revoked turn terminal:",
        JSON.stringify({
          status: finished.status,
          error: finished.error,
          stopReason: finished.stopReason,
        }),
      );
      assert.equal(calls, 1, "revocation must stop before another model request");
      assert.equal(finished.status, "error", "revoked turn must terminate with an error");
      let revokedSourceRecorded = false;
      const logDeadline = Date.now() + 10_000;
      while (Date.now() < logDeadline) {
        const gatewayLog = await fs.readFile(path.join(output, "gateway-runtime.log"), "utf8");
        revokedSourceRecorded = gatewayLog
          .split("\n")
          .some(
            (line) =>
              line.includes(started.runId) &&
              line.includes("operator source authority is no longer active"),
          );
        if (revokedSourceRecorded) break;
        await delay(100);
      }
      assert.ok(
        revokedSourceRecorded,
        "Gateway must record revoked source authority for this exact run",
      );
    } else {
      assert.equal(finished.status, "ok", "ordinary turn must finish successfully");
      assert.ok(calls >= 2, "model must receive the real tool result");
    }
    if (providerFailure) throw providerFailure;
    return outputs.join("\n");
  }
  assert.match(await run(manager.client, "manager", "get"), /Foreign-session confidential fixture/);
  record("control_ui_admin_reads_foreign_job");
  await run(manager.client, "manager", "update");
  assert.equal((await admin.request("cron.get", { id: job.id })).name, "manager update");
  record("control_ui_admin_update_persisted");
  const denied = await run(writer.client, "writer", "get");
  assert.ok(!denied.includes("Foreign private payload") && !denied.includes("manager update"));
  assert.match(denied, /automations needs the owner's authority/);
  record("write_only_foreign_read_denied_without_disclosure");
  assert.match(
    await run(writer.client, "writer", "update"),
    /automations needs the owner's authority/,
  );
  assert.equal((await admin.request("cron.get", { id: job.id })).name, "manager update");
  record("write_only_update_not_persisted");
  const revoked = await run(manager.client, "revoked", "update", true);
  assert.equal((await admin.request("cron.get", { id: job.id })).name, "manager update");
  assert.ok(!revoked.includes("Foreign private payload"));
  record("revocation_before_tool_result_prevents_persisted_update");
  manager = await controlUi("manager-read", ["operator.admin"]);
  const revokedRead = await run(manager.client, "revoked-read", "get", true);
  assert.equal(revokedRead, "", "revoked read must publish no tool result to the provider");
  record("revocation_before_foreign_read_prevents_disclosure");
  const summary = {
    revision,
    entrypoint: "node dist/index.js gateway run",
    gatewayProcess: "separate compiled process",
    inference: "synthetic local Responses server",
    client: "Control UI protocol client; browser flow tested separately",
    checks,
  };
  await fs.writeFile(
    path.join(output, "runtime-summary.json"),
    JSON.stringify(summary, null, 2) + "\n",
  );
  console.log(JSON.stringify(summary));
} finally {
  release?.();
  await Promise.allSettled(clients.map((client) => client.stopAndWait()));
  if (child.pid && child.exitCode === null) {
    process.kill(-child.pid, "SIGTERM");
    const killTimer = setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
    }, 10_000);
    await childDone;
    clearTimeout(killTimer);
  }
  provider.closeAllConnections();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
}
