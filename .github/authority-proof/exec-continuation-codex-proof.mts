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
async function readSyntheticDiagnostics() {
  const log = await fs.readFile(path.join(reportOutput, "gateway-runtime.log"), "utf8").catch(() => "");
  return log.split("\n")
    .filter((line) => /error|failed|unavailable|harness|session event|exec:/i.test(line))
    .filter((line) => !/credential|private.key/i.test(line))
    .slice(-30).map((line) => line.replace(/\u001b\[[0-9;]*m/g, "").slice(0, 1800));
}
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
  // The production installer owns package provenance, capability acceptance and
  // the persisted plugin index. A load.paths entry has config origin, not global.
  const installEnv = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: path.join(home, ".codex"),
    LANG: "C.UTF-8",
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: configPath,
  };
  await fs.writeFile(configPath, JSON.stringify({
    gateway: { mode: "local" },
    update: { checkOnStart: false },
    plugins: { allow: ["openai"], slots: { memory: "none" } },
  }), { mode: 0o600 });
  const installDiagnostics: Array<Record<string, unknown>> = [];
  async function runPluginCli(args: string[], timeoutMs: number): Promise<string> {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let overflow = false;
    const child = spawn(process.execPath, ["dist/index.js", "plugins", ...args], {
      cwd: runtime, env: installEnv, stdio: ["ignore", "pipe", "pipe"], detached: true,
    });
    const killGroup = () => {
      if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
      }
    };
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, timeoutMs);
    const maxOutput = 4 * 1024 * 1024;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > maxOutput) { overflow = true; stdout = stdout.slice(0, maxOutput); killGroup(); }
    });
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-65536); });
    let spawnError: Error | undefined;
    child.once("error", (error) => { spawnError = error; });
    const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
    clearTimeout(timer);
    const diagnosticLines = `${stdout}\n${stderr}`.split("\n")
      .filter((line) => /error|fail|warn|installed|download|codex|capabilit/i.test(line))
      .filter((line) => !/token|credential|authorization|private.key/i.test(line))
      .slice(-20).map((line) => line.replace(/\u001b\[[0-9;]*m/g, "").slice(0, 1200));
    installDiagnostics.push({ command: args[0], code, timedOut, overflow,
      durationMs: Date.now() - startedAt, errorType: spawnError?.name,
      diagnosticLines: args[0] === "list" && code === 0 ? [] : diagnosticLines });
    await fs.writeFile(path.join(output, "plugin-install-result.json"), JSON.stringify(installDiagnostics, null, 2));
    assert.equal(spawnError, undefined, "plugin CLI failed to start");
    assert.equal(timedOut, false, "plugin CLI deadline exceeded");
    assert.equal(overflow, false, "plugin CLI output exceeded the fixture bound");
    assert.equal(code, 0, "plugin CLI failed; inspect plugin-install-result.json");
    return stdout;
  }
  stage = "official-codex-plugin-install";
  await runPluginCli(["install", "npm:@openclaw/codex@2026.10.8", "--pin", "--accept-capabilities"], 240000);
  stage = "official-codex-plugin-discovery";
  const inventory = JSON.parse(await runPluginCli(["list", "--json"], 60000));
  const installed = inventory.plugins.filter((entry: { id?: string }) => entry.id === "codex");
  assert.equal(installed.length, 1, "exactly one managed Codex plugin must be discovered");
  const plugin = installed[0];
  assert.equal(plugin.origin, "global");
  assert.equal(plugin.version, "2026.10.8");
  assert.equal(typeof plugin.rootDir, "string");
  const codexPlugin = await fs.realpath(plugin.rootDir);
  const relativePluginPath = path.relative(await fs.realpath(state), codexPlugin);
  assert.ok(relativePluginPath && relativePluginPath !== ".." && !relativePluginPath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePluginPath), "installed plugin must remain inside disposable state");
  const installedConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(installedConfig.plugins?.load?.paths?.length ?? 0, 0, "managed plugin discovery must not use load.paths");
  const codexPackage = JSON.parse(await fs.readFile(path.join(codexPlugin, "package.json"), "utf8"));
  assert.equal(codexPackage.name, "@openclaw/codex");
  assert.equal(codexPackage.version, "2026.10.8");
  const nativeRoot = path.resolve(codexPlugin, "../../@openai/codex");
  const nativePackage = JSON.parse(await fs.readFile(path.join(nativeRoot, "package.json"), "utf8"));
  assert.equal(nativePackage.version, "0.160.0");
  const codexLauncher = await fs.realpath(path.join(nativeRoot, "bin/codex.js"));
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
  const nativeUserAgents = new Set<string>();
  let advertisedHostTools: string[] = [];
  stage = "synthetic-provider-setup";
  const provider = createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(request.url === "/v1/responses" ? 426 : 404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body: {
        model: string;
        input?: Array<{ type?: string; output?: unknown }>;
        tools?: Array<{ type?: string; name?: string }>;
      } = JSON.parse(
        Buffer.concat(chunks).toString("utf8"),
      );
      assert.equal(body.model, "gpt-5.5");
      nativeUserAgents.add(String(request.headers["user-agent"] ?? ""));
      const toolNames = (body.tools ?? [])
        .filter((tool) => tool.type === "function")
        .map((tool) => tool.name);
      if (calls === 0) {
        await fs.writeFile(path.join(output, "native-tool-catalog.json"), JSON.stringify({
          model: body.model,
          userAgent: String(request.headers["user-agent"] ?? ""),
          tools: (body.tools ?? []).map(({ type, name }) => ({ type, name })),
        }, null, 2));
      }
      assert.ok(toolNames.includes("gateway_exec"), "native Codex must advertise host gateway_exec");
      assert.ok(toolNames.includes("gateway_process"), "native Codex must advertise host gateway_process");
      advertisedHostTools = ["gateway_exec", "gateway_process"];
      assert.ok(scenarioStarted, "unexpected model call outside a scenario");
      outputs.push(
        ...(body.input ?? [])
          .filter((x) => x.type === "function_call_output")
          .map((x) => typeof x.output === "string" ? x.output : JSON.stringify(x.output ?? "")),
      );
      calls++;
      if (calls === 1) {
        writeToolCall(response, "gateway_exec", {
          command: `${process.execPath} -e 'setTimeout(() => console.log("BACKGROUND_FINISHED"), 15000)'`,
          yieldMs: 1000,
          timeoutSeconds: 30,
        });
      } else if (calls === 3) {
        writeToolCall(response, "gateway_exec", { command: "printf RESUME_TOOL_OK", yieldMs: 1000 });
      } else {
        writeOpenAiResponsesText(response, {
          text: calls === 2 ? "WAITING_FOR_BACKGROUND" : "RESUMED_WITH_AUTHORITY",
          messageId: randomUUID(),
          responseId: randomUUID(),
        });
      }
    })().catch((error) => {
      providerFailure = error;
      console.error("SYNTHETIC_PROVIDER_ASSERTION", error instanceof assert.AssertionError ? error.message.split("\n")[0] : "provider transport failure");
      response.writeHead(500).end("Synthetic provider failure");
    });
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const providerPort = (provider.address() as AddressInfo).port;
  const reservation = tcpServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as AddressInfo).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const modelConfig = createOpenAiResponsesModelConfig({
    baseUrl: `http://127.0.0.1:${providerPort}`,
    providerId: "runtime-proof",
    modelId: "operator",
    reasoning: false,
    toolProfile: "full",
  });
  const config = { ...installedConfig, ...modelConfig };
  // Native Codex admits the official OpenAI provider. Only its app-server transport
  // is redirected to the synthetic loopback server, following the upstream fixture.
  config.agents.defaults.workspace = workspace;
  config.agents.defaults.model = { primary: "openai/gpt-5.5" };
  config.agents.defaults.models = { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } };
  config.agents.defaults.utilityModel = "";
  config.agents.defaults.contextInjection = "never";
  config.models.providers = {
    openai: {
      baseUrl: "https://api.openai.com/v1",
      apiKey: "synthetic-local-only",
      api: "openai-responses",
      models: [{ ...config.models.providers["runtime-proof"].models[0], id: "gpt-5.5", name: "Synthetic native Codex model" }],
    },
  };
  config.models.catalogRefresh = { enabled: false };
  config.agents.entries = { main: {} };
  config.tools = {
    profile: "full",
    codeMode: false,
    toolSearch: false,
    exec: { host: "gateway", security: "full", ask: "off", notifyOnExit: true },
  };
  config.cron = { enabled: false };
  config.logging = { level: "debug", consoleLevel: "debug" };
  config.update = { checkOnStart: false };
  config.plugins = {
    ...installedConfig.plugins,
    allow: [...new Set([...(installedConfig.plugins?.allow ?? []), "openai", "codex"])],
    slots: { ...installedConfig.plugins?.slots, memory: "none" },
    entries: {
      ...installedConfig.plugins?.entries,
      codex: {
        ...installedConfig.plugins?.entries?.codex,
        enabled: true,
        config: {
          ...installedConfig.plugins?.entries?.codex?.config,
          codexDynamicToolsLoading: "direct",
          sessionCatalog: { enabled: false },
          appServer: {
            command: codexLauncher,
            args: ["app-server", "--listen", "stdio://",
              "-c", `openai_base_url="http://127.0.0.1:${providerPort}/v1"`,
              "-c", "analytics.enabled=false",
              "-c", "feedback.enabled=false",
              "-c", "features.shell_snapshot=false"],
          },
        },
      },
    },
  };
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
    USERPROFILE: home,
    CODEX_HOME: path.join(home, ".codex"),
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1,localhost,::1",
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
    console.log("FIRST_TURN", JSON.stringify({ status: first.status, error: first.error, calls }));
    console.log("SYNTHETIC_TOOL_RESULTS", JSON.stringify(outputs.map((value) => value.slice(0, 4000))));
    assert.equal(first.status, "ok");
    assert.equal(calls, 2, "first turn must start a background command and finish");
    assert.ok(
      outputs.some((x) => x.includes("Command still running (session ")),
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
    // This Gateway uses only the synthetic fixture. Keep diagnostic events bounded,
    // excluding configuration, handshake and credential records from the artifact.
    const diagnosticLines = (await fs.readFile(path.join(output, "gateway-runtime.log"), "utf8"))
      .split("\n")
      .filter((line) => /session event|exec:|lane task error|embedded run|harness|BACKGROUND_FINISHED|cancel/i.test(line))
      .filter((line) => !/token|credential|authorization|private.key|https?:\/\//i.test(line))
      .slice(-40)
      .map((line) => line.replace(/\u001b\[[0-9;]*m/g, "").slice(0, 1500));
    const summary = {
      stage,
      packageVersion: packageInfo.version,
      pluginVersion: codexPackage.version,
      nativeCodexVersion: nativePackage.version,
      nativeUserAgents: [...nativeUserAgents],
      advertisedHostTools,
      configuredRuntime: "codex",
      toolProfile: "full",
      nodeVersion: process.version,
      workflowRevision: process.env.PROOF_WORKFLOW_REVISION,
      calls,
      failure,
      checks,
      diagnosticLines,
      resumed: outputs.some((x) => x.includes("RESUME_TOOL_OK")),
      inference: "synthetic; compiled Gateway, native Codex app-server and host process real",
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
          errorMessage: error instanceof Error ? error.message.slice(0, 1800) : undefined,
          diagnosticLines: await readSyntheticDiagnostics(),
          workflowRevision: process.env.PROOF_WORKFLOW_REVISION,
          nodeVersion: process.version,
        },
        null,
        2,
      ),
    );
  }
  console.error("FAIL native Codex exec continuation proof; inspect the bounded result.json verdict.");
  process.exitCode = 1;
}
