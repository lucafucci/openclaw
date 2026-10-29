import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { X509Certificate, randomUUID } from "node:crypto";
import { openSync, closeSync } from "node:fs";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as tcpServer, connect as tcpConnect, type AddressInfo } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const reportOutput = path.resolve(process.argv[2]);
let stage = "load-runtime";
async function main() {
  const output = path.resolve(process.argv[2]);
  const runtime = path.resolve(process.argv[3]);
  await fs.mkdir(output, { recursive: true });
  const packageInfo = JSON.parse(await fs.readFile(path.join(runtime, "package.json"), "utf8"));
  assert.equal(packageInfo.version, "2026.10.8", "proof chunk exports are pinned to this package");
  const root = await fs.mkdtemp(path.join(output, "runtime-state-"));
  const state = path.join(root, "state");
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  await Promise.all([state, home, workspace].map((p) => fs.mkdir(p, { recursive: true })));
  const configPath = path.join(state, "openclaw.json");
  // Client credentials also belong to this disposable proof, never the operator's state.
  process.env.OPENCLAW_STATE_DIR = state;
  process.env.OPENCLAW_CONFIG_PATH = configPath;
  const { t: GatewayClient } = await import(
    pathToFileURL(path.join(runtime, "dist/client-BpcH-Scn.mjs")).href
  );
  const { r: loadOrCreateDeviceIdentity } = await import(
    pathToFileURL(path.join(runtime, "dist/device-identity-Ca8SdV6c.mjs")).href
  );
  const {
    TEST_TLS_CERT_PEM,
    TEST_TLS_KEY_PEM,
    writeToolCall,
    writeOpenAiResponsesText,
    createOpenAiResponsesModelConfig,
  } = await import("./exec-continuation-fixtures.mts");
  const certPath = path.join(root, "cert.pem");
  const keyPath = path.join(root, "key.pem");
  await fs.writeFile(certPath, TEST_TLS_CERT_PEM);
  await fs.writeFile(keyPath, TEST_TLS_KEY_PEM, { mode: 0o600 });
  const tlsFingerprint = new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256;
  const token = "synthetic-disposable-runtime-gateway-token";
  const checks: Record<string, boolean> = {};
  const record = (name: string) => {
    checks[name] = true;
    console.log(`PASS ${name}`);
  };
  let scenarioStarted = false;
  let calls = 0;
  const outputs: string[] = [];
  let providerFailure: unknown;
  stage = "synthetic-provider-setup";
  const provider = createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body: { model: string; input?: Array<{ type?: string; output?: string }> } = JSON.parse(
        Buffer.concat(chunks).toString("utf8"),
      );
      if (body.model === "metadata") {
        writeOpenAiResponsesText(response, {
          text: "Automation proof",
          messageId: randomUUID(),
          responseId: randomUUID(),
        });
        return;
      }
      assert.equal(body.model, "operator");
      assert.ok(scenarioStarted, "unexpected model call outside a scenario");
      outputs.push(
        ...(body.input ?? [])
          .filter((x) => x.type === "function_call_output")
          .map((x) => x.output ?? ""),
      );
      calls++;
      if (calls === 1) {
        writeToolCall(response, "exec", {
          command: `${process.execPath} -e 'setTimeout(() => console.log("BACKGROUND_FINISHED"), 15000)'`,
          yieldMs: 1000,
          timeoutSeconds: 30,
        });
      } else if (calls === 3) {
        writeToolCall(response, "exec", { command: "printf RESUME_TOOL_OK", yieldMs: 1000 });
      } else {
        writeOpenAiResponsesText(response, {
          text: calls === 2 ? "WAITING_FOR_BACKGROUND" : "RESUMED_WITH_AUTHORITY",
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
  const providerPort = (provider.address() as AddressInfo).port;
  const reservation = tcpServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as AddressInfo).port;
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
  config.tools = {
    allow: ["exec"],
    codeMode: false,
    toolSearch: false,
    exec: { host: "gateway", security: "full", ask: "off", notifyOnExit: true },
  };
  config.cron = { enabled: false };
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
  stage = "gateway-startup";
  const logFd = openSync(path.join(output, "gateway-runtime.log"), "w", 0o600);
  const child = spawn(
    process.execPath,
    ["dist/index.js", "gateway", "run", "--port", String(port), "--bind", "loopback"],
    { cwd: runtime, env, stdio: ["ignore", logFd, logFd], detached: true },
  );
  closeSync(logFd);
  const childDone = new Promise<void>((resolve) => child.once("close", () => resolve()));
  let childError: Error | undefined;
  child.once("error", (error) => {
    childError = error;
  });
  type Client = InstanceType<typeof GatewayClient>;
  type Hello = { auth: { scopes: string[] } };
  const clients: Client[] = [];
  async function connect(options: Record<string, unknown>) {
    let client: Client | undefined;
    try {
      return await new Promise<{ client: Client; hello: Hello }>((resolve, reject) => {
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
          onHelloOk: (hello: Hello) => {
            clearTimeout(timer);
            resolve({ client: client!, hello });
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
    stage = "local-client-authentication";
    const local = await connect({
      deviceIdentity: loadOrCreateDeviceIdentity({
        path: path.join(state, "bootstrap", "client", "credentials.sqlite"),
      }),
    });
    const admin = local.client;
    await admin.request("health", {});
    record("compiled_gateway_authenticated_rpc");
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
      let pairError: unknown;
      try {
        await connect(options);
      } catch (error) {
        pairError = error;
      }
      assert.ok(pairError, "remote Control UI must require explicit pairing");
      const pending = await admin.request("device.pair.list", {});
      const request = pending.pending.find(
        (item: { deviceId: string; requestId: string }) => item.deviceId === identity.deviceId,
      );
      assert.ok(request, "remote handshake must create a real pairing request");
      await admin.request("device.pair.approve", { requestId: request.requestId });
      const connected = await connect(options);
      assert.deepEqual(connected.hello.auth.scopes, scopes);
      return { client: connected.client, identity };
    }
    stage = "remote-control-ui-pairing";
    const manager = await controlUi("manager", ["operator.admin"]);
    stage = "foreground-exec-turn";
    scenarioStarted = true;
    const sessionKey = `agent:main:background-proof-${randomUUID()}`;
    const started = await manager.client.request("chat.send", {
      sessionKey,
      message: "Start the background fixture and report when it finishes",
      idempotencyKey: randomUUID(),
    });
    const first = await admin.request(
      "agent.wait",
      { runId: started.runId, timeoutMs: 60000 },
      { timeoutMs: 65000 },
    );
    console.log("FIRST_TURN", JSON.stringify({ status: first.status, calls }));
    assert.equal(first.status, "ok");
    assert.equal(calls, 2, "first turn must start a background command and finish");
    assert.ok(
      outputs.some((x) => x.includes("running")),
      "command must actually be backgrounded",
    );
    stage = "background-exec-continuation";
    await manager.client.stopAndWait();
    record("original_client_disconnected_after_background_start");
    const deadline2 = Date.now() + 45000;
    let failure = false;
    while (Date.now() < deadline2) {
      const log = await fs.readFile(path.join(output, "gateway-runtime.log"), "utf8");
      failure = log.includes("Gateway caller authority is no longer active");
      if (failure || calls >= 4) break;
      await delay(250);
    }
    const summary = {
      stage,
      packageVersion: packageInfo.version,
      nodeVersion: process.version,
      workflowRevision: process.env.PROOF_WORKFLOW_REVISION,
      calls,
      failure,
      checks,
      resumed: outputs.some((x) => x.includes("RESUME_TOOL_OK")),
      inference: "synthetic; compiled Gateway and process real",
    };
    await fs.writeFile(path.join(output, "result.json"), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary));
    assert.equal(providerFailure, undefined);
    assert.equal(failure, false, "background follow-up reused inactive Gateway authority");
    assert.ok(summary.resumed, "background completion did not execute authorized follow-up");
  } finally {
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
}
try {
  await main();
} catch (error) {
  await fs.mkdir(reportOutput, { recursive: true });
  const resultPath = path.join(reportOutput, "result.json");
  try {
    await fs.access(resultPath);
  } catch {
    await fs.writeFile(
      resultPath,
      JSON.stringify(
        {
          completed: false,
          stage,
          assertion:
            error instanceof assert.AssertionError ? error.message.split("\n")[0] : undefined,
          errorType: error instanceof Error ? error.name : "UnknownError",
          workflowRevision: process.env.PROOF_WORKFLOW_REVISION,
          nodeVersion: process.version,
        },
        null,
        2,
      ),
    );
  }
  console.error("FAIL exec continuation proof; inspect the bounded result.json verdict.");
  process.exitCode = 1;
}
