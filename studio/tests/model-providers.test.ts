import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { AntigravityRunner } from "../server/antigravity.js";
import { ModelProviderService, type SecretVault } from "../server/model-providers.js";
import { ProviderHttpError, requestProviderJson } from "../server/provider-request.js";
import { StudioStore } from "../server/store.js";

const waitFor = async (predicate: () => boolean, timeout = 4_000): Promise<void> => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error("timed out waiting for model job");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

// Deliberately test-only: production has no plaintext/base64 vault fallback.
class TestSecretVault implements SecretVault {
  protect(secret: string): string { return Buffer.from(secret, "utf8").toString("base64"); }
  unprotect(payload: string): string { return Buffer.from(payload, "base64").toString("utf8"); }
}

const processExists = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
};

test("provider HTTP retries distinguish configuration, compatibility and transient failures", async (t) => {
  const priorFetch = globalThis.fetch;
  const payload = {model: "fixture", messages: [{role: "user", content: "unchanged"}], response_format: {type: "json_object"}};
  const ok = () => new Response(JSON.stringify({choices: [{message: {content: "{}"}}]}));
  const failure = (status: number, message = "fixture failure", headers = {}) => new Response(JSON.stringify({error: {message}}), {status, headers});
  const run = async (respond: (attempt: number) => Response, options: {abort?: boolean; realWait?: boolean; fallback?: boolean} = {}) => {
    const bodies: Record<string, unknown>[] = [];
    const waits: number[] = [];
    const controller = new AbortController();
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      assert.equal(init?.redirect, "error");
      bodies.push(JSON.parse(String(init?.body)));
      if (options.realWait) setTimeout(() => controller.abort(), 5);
      return respond(bodies.length);
    }) as typeof fetch;
    let error: unknown;
    try {
      await requestProviderJson("https://fixture.invalid", {}, payload, controller.signal, options.fallback !== false,
        options.realWait ? undefined : async (ms, signal) => { waits.push(ms); if (options.abort) controller.abort(); signal.throwIfAborted(); });
    } catch (caught) { error = caught; }
    return {bodies, waits, error};
  };
  try {
    for (const status of [400, 401, 403, 404, 422, 501]) await t.test(`HTTP ${status} is not blindly retried`, async () => {
      const result = await run(() => failure(status));
      assert.equal(result.bodies.length, 1);
      assert.deepEqual(result.bodies[0], payload);
      assert.deepEqual(result.waits, []);
      assert.ok(result.error instanceof ProviderHttpError);
      assert.equal(result.error.status, status);
    });
    for (const status of [429, 500, 502, 503, 504]) await t.test(`HTTP ${status} retries the identical request with bounded backoff`, async () => {
      const result = await run(() => failure(status, "response_format unsupported"));
      assert.equal(result.bodies.length, 3);
      assert.ok(result.bodies.every(body => JSON.stringify(body) === JSON.stringify(payload)));
      assert.deepEqual(result.waits, [1000, 5000]);
      assert.ok(result.error instanceof ProviderHttpError);
      assert.equal(result.error.status, status);
    });
    await t.test("only explicit format rejection removes the parameter once", async () => {
      for (const status of [400, 422]) {
        const result = await run(attempt => attempt === 1 ? failure(status, "response_format is not supported") : ok());
        assert.equal(result.error, undefined);
        assert.equal(result.bodies.length, 2);
        const {response_format: _format, ...rest} = payload;
        assert.deepEqual(result.bodies[1], rest);
        assert.deepEqual(result.waits, []);
      }
      const repeated = await run(() => failure(400, "response_format is not supported"));
      assert.equal(repeated.bodies.length, 2);
      const unrelated = await run(() => new Response(JSON.stringify({error: {param: "temperature", code: "unsupported_parameter", message: "use response_format with unsupported temperature"}}), {status: 400}));
      assert.equal(unrelated.bodies.length, 1);
      const disabled = await run(() => failure(400, "response_format is not supported"), {fallback: false});
      assert.equal(disabled.bodies.length, 1);
    });
    await t.test("compatibility fallback does not reset the transient retry limit", async () => {
      const result = await run(attempt => attempt === 2 ? failure(400, "response_format is not supported") : failure(503));
      assert.equal(result.bodies.length, 4);
      assert.deepEqual(result.waits, [1000, 5000]);
      assert.ok(Object.hasOwn(result.bodies[1], "response_format"));
      assert.ok(!Object.hasOwn(result.bodies[2], "response_format"));
    });
    await t.test("Retry-After is honored or stops the task rather than retrying too early", async () => {
      const seconds = await run(attempt => attempt === 1 ? failure(429, "limited", {"Retry-After": "12"}) : ok());
      assert.equal(seconds.error, undefined);
      assert.deepEqual(seconds.waits, [12000]);
      const excessive = await run(() => failure(429, "limited", {"Retry-After": "120"}));
      assert.equal(excessive.bodies.length, 1);
      assert.deepEqual(excessive.waits, []);
      const date = new Date(Date.now() + 30_000).toUTCString();
      const dated = await run(attempt => attempt === 1 ? failure(503, "busy", {"Retry-After": date}) : ok());
      assert.ok(dated.waits[0] >= 28000 && dated.waits[0] <= 30000);
      const malformed = await run(attempt => attempt === 1 ? failure(503, "busy", {"Retry-After": "unknown"}) : ok());
      assert.deepEqual(malformed.waits, [1000]);
    });
    await t.test("HTML gateway errors retain status; invalid successful responses are not replayed", async () => {
      const gateway = await run(attempt => attempt === 1 ? new Response("<html>gateway</html>", {status: 502}) : ok());
      assert.equal(gateway.error, undefined);
      assert.deepEqual(gateway.waits, [1000]);
      const invalid = await run(() => new Response("not JSON"));
      assert.equal(invalid.bodies.length, 1);
      assert.match(String(invalid.error), /不是 JSON/);
    });
    await t.test("network errors and cancellation never trigger format fallback or another request", async () => {
      const network = await run(() => {throw new TypeError("fetch failed");});
      assert.equal(network.bodies.length, 1);
      assert.deepEqual(network.waits, []);
      const cancelled = await run(() => failure(503), {abort: true});
      assert.equal(cancelled.bodies.length, 1);
      const real = await run(() => failure(503), {realWait: true});
      assert.equal(real.bodies.length, 1);
      assert.equal((real.error as Error).name, "AbortError");
      const controller = new AbortController(); controller.abort();
      let requests = 0;
      globalThis.fetch = (async () => {requests++; return ok();}) as typeof fetch;
      await assert.rejects(requestProviderJson("https://fixture.invalid", {}, payload, controller.signal));
      assert.equal(requests, 0);
    });
  } finally { globalThis.fetch = priorFetch; }
});

test("external HTTP authentication errors retain classification after redaction and reach the job status", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-model-auth-"));
  const priorFetch = globalThis.fetch;
  const store = new StudioStore(root);
  try {
    const secret = "fixture-private-key";
    let requests = 0;
    globalThis.fetch = (async () => {requests++; return new Response(JSON.stringify({error: {message: secret}}), {status: 401});}) as typeof fetch;
    const service = new ModelProviderService(store, new TestSecretVault());
    const provider = service.saveProvider({label: "Fixture", kind: "openai_compatible", baseUrl: "https://fixture.invalid", apiKey: secret});
    store.updateModelProviderProbe(provider.id, {status: "ready", models: ["fixture"]});
    service.saveRoute({role: "workbench", providerId: provider.id, modelId: "fixture", fallbackEnabled: false});
    await assert.rejects(service.generateJson("workbench", "fixture"), (error: Error) => {
      assert.ok(error instanceof ProviderHttpError);
      assert.equal(error.authenticationRequired, true);
      assert.match(error.message, /HTTP 401/);
      assert.ok(!error.message.includes(secret));
      return true;
    });
    const runner = new AntigravityRunner(root, store, {} as never, {modelProviders: service, executable: "missing-agy-for-test"});
    const job = await runner.agent.start("选择 demo 作品", {bookId: "demo"});
    await waitFor(() => !["queued", "running"].includes(store.getJob(job.id)?.status || ""));
    assert.equal(store.getJob(job.id)?.status, "auth_required");
    assert.ok(!store.getJob(job.id)?.error.includes(secret));
    assert.equal(requests, 2, "one request for each explicit generation, no automatic authentication retry");
  } finally { globalThis.fetch = priorFetch; store.db.close(); await rm(root, {recursive: true, force: true}); }
});

test("model roles default to local AGY and provider secrets never leave the store boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-model-store-"));
  try {
    const store = new StudioStore(root);
    const service = new ModelProviderService(store, new TestSecretVault());
    assert.deepEqual(service.snapshot().routes.map((item) => [item.role, item.providerId]), [
      ["generation", "agy"], ["review", "agy"], ["workbench", "agy"], ["review_arbitration", "inherit_review"],
    ]);
    const provider = service.saveProvider({label: "兼容网关", kind: "openai_compatible", baseUrl: "https://gateway.example/v1", apiKey: "super-secret"});
    assert.equal(provider.apiKeyConfigured, true);
    assert.equal(JSON.stringify(service.snapshot()).includes("super-secret"), false);
    assert.notEqual(store.getEncryptedModelProviderKey(provider.id), "super-secret");
    store.updateModelProviderProbe(provider.id, {status: "ready", models: ["model-a"]});
    const route = service.saveRoute({role: "review", providerId: provider.id, modelId: "model-a"});
    assert.equal(route.providerId, provider.id);
    assert.throws(() => service.saveRoute({role: "generation", providerId: provider.id, modelId: "fabricated-model"}), /模型列表/);
    assert.throws(() => service.deleteProvider(provider.id), /仍被 review 使用/);
    store.db.close();
  } finally { await rm(root, {recursive: true, force: true}); }
});

test("OpenAI-compatible models are discovered and external workbench output still passes Tomota validation", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-model-runner-"));
  const priorFetch = globalThis.fetch;
  try {
    const requests: Array<{url: string; authorization: string; body: string}> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({url, authorization: String((init?.headers as Record<string, string> | undefined)?.Authorization || ""), body: String(init?.body || "")});
      if (url.endsWith("/models")) return new Response(JSON.stringify({data: [{id: "reasoner-one"}, {id: "writer-two"}]}), {status: 200, headers: {"Content-Type": "application/json"}});
      return new Response(JSON.stringify({choices: [{message: {content: JSON.stringify({
        stage: "workbench_agent", summary: "切换到作品", reasoning: ["用户指定了目标作品"],
        actions: [{type: "select_project", bookId: "demo"}], warnings: [],
      })}}]}), {status: 200, headers: {"Content-Type": "application/json"}});
    }) as typeof fetch;
    const store = new StudioStore(root);
    const service = new ModelProviderService(store, new TestSecretVault());
    const provider = service.saveProvider({label: "测试网关", kind: "openai_compatible", baseUrl: "https://gateway.example/v1", apiKey: "key-one"});
    const refreshed = await service.refreshModels(provider.id);
    assert.deepEqual(refreshed.models, ["reasoner-one", "writer-two"]);
    service.saveRoute({role: "workbench", providerId: provider.id, modelId: "reasoner-one"});
    const runner = new AntigravityRunner(root, store, {} as never, {modelProviders: service, executable: "missing-agy-for-test"});
    const job = await runner.agent.start("选择 demo 作品", {bookId: "demo"});
    await waitFor(() => !["queued", "running"].includes(store.getJob(job.id)?.status || ""));
    assert.equal(store.getJob(job.id)?.status, "succeeded");
    assert.equal(store.getJobResult(job.id).lineage.modelRole, "workbench");
    assert.equal(store.getJobResult(job.id).lineage.modelProviderId, provider.id);
    assert.equal(store.getJobResult(job.id).lineage.modelId, "reasoner-one");
    assert.equal((await runner.agent.result(job.id)).artifact?.actions[0].type, "select_project");
    assert.ok(requests.every((item) => item.authorization === "Bearer key-one"));
    assert.equal(store.listEvents(job.id).some((item) => item.message.includes("Tomota 独立校验")), true);
    store.db.close();
  } finally {
    globalThis.fetch = priorFetch;
    await rm(root, {recursive: true, force: true});
  }
});

test("invalid external model JSON fails closed without silently falling back", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-model-fail-"));
  const priorFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({choices: [{message: {content: "not-json"}}]}), {status: 200, headers: {"Content-Type": "application/json"}})) as typeof fetch;
    const store = new StudioStore(root);
    const service = new ModelProviderService(store, new TestSecretVault());
    const provider = service.saveProvider({label: "坏网关", kind: "openai_compatible", baseUrl: "https://gateway.example/v1", apiKey: "key-two"});
    store.updateModelProviderProbe(provider.id, {status: "ready", models: ["bad-model"]});
    service.saveRoute({role: "workbench", providerId: provider.id, modelId: "bad-model", fallbackEnabled: false});
    const runner = new AntigravityRunner(root, store, {} as never, {modelProviders: service, executable: "missing-agy-for-test"});
    const job = await runner.agent.start("选择 demo 作品", {bookId: "demo"});
    await waitFor(() => !["queued", "running"].includes(store.getJob(job.id)?.status || ""));
    assert.equal(store.getJob(job.id)?.status, "failed");
    assert.match(store.getJob(job.id)?.error || "", /有效的 JSON/);
    assert.equal(store.listEvents(job.id).some((item) => item.message.includes("未静默切换模型")), true);
    store.db.close();
  } finally {
    globalThis.fetch = priorFetch;
    await rm(root, {recursive: true, force: true});
  }
});

test("local AGY jobs are concurrency-limited and a hung process is terminated by the watchdog", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-watchdog-"));
  const childPidPath = join(root, "agy-child.pid");
  try {
    const hanging = join(root, "hang.mjs");
    await writeFile(hanging, `
      import {spawn} from "node:child_process";
      import {writeFileSync} from "node:fs";
      const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {stdio: "ignore", windowsHide: true});
      writeFileSync(process.argv[2], String(worker.pid));
      setInterval(() => {}, 1000);
    `, "utf8");
    const store = new StudioStore(root);
    const service = new ModelProviderService(store, new TestSecretVault());
    const runner = new AntigravityRunner(root, store, {} as never, {
      modelProviders: service, executable: process.execPath, prefixArgs: [hanging, childPidPath],
      maxLocalConcurrency: 1, watchdogMinimumMs: 100, watchdogFallbackMs: 120,
    });
    const first = await runner.agent.start("选择 demo 作品", {bookId: "demo"});
    const second = await runner.agent.start("选择 demo 作品", {bookId: "demo"});
    assert.equal(store.getJob(first.id)?.status, "running");
    assert.equal(store.getJob(second.id)?.status, "queued");
    assert.deepEqual(runner.status().concurrency, {active: 1, queued: 1, limit: 1});
    await waitFor(() => store.getJob(first.id)?.status === "timeout");
    await waitFor(() => store.getJob(second.id)?.status === "timeout");
    await waitFor(() => runner.status().concurrency.active === 0);
    assert.match(store.getJob(first.id)?.error || "", /动态看门狗/);
    assert.equal(store.listEvents(second.id).some((item) => item.message.includes("受控队列")), true);
    if (process.platform === "win32") {
      const childPid = Number(await readFile(childPidPath, "utf8"));
      await waitFor(() => !processExists(childPid));
      assert.equal(processExists(childPid), false, "Windows watchdog must terminate the AGY process tree");
    }
    store.db.close();
  } finally {
    if (process.platform === "win32") {
      const childPid = Number(await readFile(childPidPath, "utf8").catch(() => "0"));
      if (childPid && processExists(childPid)) spawnSync("taskkill.exe", ["/PID", String(childPid), "/T", "/F"], {stdio: "ignore", windowsHide: true});
    }
    await rm(root, {recursive: true, force: true});
  }
});

test("provider errors redact literal, base64, base64url and URL-encoded API keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-model-redaction-"));
  const priorFetch = globalThis.fetch;
  try {
    const secret = "key+/=?secret";
    const variants = [secret, Buffer.from(secret).toString("base64"), Buffer.from(secret).toString("base64url"), encodeURIComponent(secret)];
    globalThis.fetch = (async () => new Response(JSON.stringify({error: {message: variants.join(" | ")}}), {status: 401, headers: {"Content-Type": "application/json"}})) as typeof fetch;
    const store = new StudioStore(root);
    const service = new ModelProviderService(store, new TestSecretVault());
    const provider = service.saveProvider({label: "脱敏测试", kind: "openai_compatible", baseUrl: "https://gateway.example/v1", apiKey: secret});
    await assert.rejects(service.refreshModels(provider.id), (error: Error) => {
      assert.ok(variants.every((value) => !error.message.includes(value)));
      assert.match(error.message, /\[REDACTED\]/);
      return true;
    });
    const storedError = store.getModelProvider(provider.id)?.error || "";
    assert.ok(variants.every((value) => !storedError.includes(value)));
    store.db.close();
  } finally {
    globalThis.fetch = priorFetch;
    await rm(root, {recursive: true, force: true});
  }
});
