import { spawnSync } from "node:child_process";

import { StudioStore } from "./store.js";
import { ProviderHttpError, requestProviderJson, responseJson } from "./provider-request.js";
import type { ModelProviderKind, ModelProviderRecord, ModelRole, ModelRouteRecord } from "./types.js";

export interface SecretVault {
  protect(secret: string): string;
  unprotect(payload: string): string;
}

export class WindowsDpapiVault implements SecretVault {
  private run(mode: "protect" | "unprotect", payload: string): string {
    if (process.platform !== "win32") throw new Error("当前版本仅支持在 Windows 当前用户安全存储中保存 API Key");
    const powershell = process.env.TOMOTA_POWERSHELL || "powershell.exe";
    const prefix = "[void][Reflection.Assembly]::LoadWithPartialName('System.Security');$raw=[Convert]::FromBase64String($env:TOMOTA_SECRET_PAYLOAD);";
    const script = mode === "protect"
      ? `${prefix}$out=[System.Security.Cryptography.ProtectedData]::Protect($raw,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($out))`
      : `${prefix}$out=[System.Security.Cryptography.ProtectedData]::Unprotect($raw,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($out))`;
    const input = mode === "protect" ? Buffer.from(payload, "utf8").toString("base64") : payload;
    const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8", windowsHide: true, timeout: 15_000,
      env: {...process.env, TOMOTA_SECRET_PAYLOAD: input},
    });
    if (result.status !== 0 || result.error) throw new Error(`系统安全存储不可用：${String(result.error?.message || result.stderr || "DPAPI 执行失败").trim()}`);
    const output = String(result.stdout || "").trim();
    if (!output) throw new Error("系统安全存储没有返回有效结果");
    return mode === "protect" ? output : Buffer.from(output, "base64").toString("utf8");
  }

  protect(secret: string): string { return this.run("protect", secret); }
  unprotect(payload: string): string { return this.run("unprotect", payload); }
}

const DEFAULT_URLS: Record<ModelProviderKind, string> = {
  openai_compatible: "https://api.openai.com/v1",
  openai_responses: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
};

function normalizedBaseUrl(kind: ModelProviderKind, input: string): string {
  const raw = input.trim() || DEFAULT_URLS[kind];
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("供应商地址不是有效 URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("供应商地址只允许不含账号密码的 HTTP/HTTPS URL");
  url.search = ""; url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function endpoint(base: string, suffix: string): string {
  return `${base.replace(/\/$/, "")}/${suffix.replace(/^\//, "")}`;
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (fenced?.[1] || trimmed).trim();
}

function sanitizedError(error: unknown, secret: string): Error {
  const variants = [...new Set([
    secret,
    Buffer.from(secret, "utf8").toString("base64"),
    Buffer.from(secret, "utf8").toString("base64url"),
    encodeURIComponent(secret),
  ].filter(Boolean))].sort((left, right) => right.length - left.length);
  let message = error instanceof Error ? error.message : String(error);
  for (const value of variants) message = message.replaceAll(value, "[REDACTED]");
  if (error instanceof ProviderHttpError) return new ProviderHttpError(message, error.status, error.retryAfterMs, error.unsupportedJsonFormat);
  return new Error(message);
}

function extractText(kind: ModelProviderKind, value: Record<string, unknown>): string {
  if (kind === "openai_compatible") {
    const choices = Array.isArray(value.choices) ? value.choices : [];
    const first = choices[0] && typeof choices[0] === "object" ? choices[0] as Record<string, unknown> : {};
    const message = first.message && typeof first.message === "object" ? first.message as Record<string, unknown> : {};
    if (typeof message.content === "string") return stripJsonFence(message.content);
    if (Array.isArray(message.content)) return stripJsonFence(message.content.map((item) => typeof item === "object" && item ? String((item as Record<string, unknown>).text || "") : "").join(""));
  } else if (kind === "openai_responses") {
    if (typeof value.output_text === "string") return stripJsonFence(value.output_text);
    const output = Array.isArray(value.output) ? value.output : [];
    const text = output.flatMap((item) => {
      const content = item && typeof item === "object" && Array.isArray((item as Record<string, unknown>).content) ? (item as Record<string, unknown>).content as unknown[] : [];
      return content.map((part) => part && typeof part === "object" ? String((part as Record<string, unknown>).text || (part as Record<string, unknown>).output_text || "") : "");
    }).join("");
    if (text) return stripJsonFence(text);
  } else if (kind === "anthropic") {
    const content = Array.isArray(value.content) ? value.content : [];
    return stripJsonFence(content.map((item) => typeof item === "object" && item ? String((item as Record<string, unknown>).text || "") : "").join(""));
  } else {
    const candidates = Array.isArray(value.candidates) ? value.candidates : [];
    const first = candidates[0] && typeof candidates[0] === "object" ? candidates[0] as Record<string, unknown> : {};
    const content = first.content && typeof first.content === "object" ? first.content as Record<string, unknown> : {};
    const parts = Array.isArray(content.parts) ? content.parts : [];
    return stripJsonFence(parts.map((item) => typeof item === "object" && item ? String((item as Record<string, unknown>).text || "") : "").join(""));
  }
  throw new Error("供应商响应中没有可读取的文本产物");
}

export class ModelProviderService {
  constructor(private readonly store: StudioStore, private readonly vault: SecretVault = new WindowsDpapiVault()) {}

  snapshot(): {providers: ModelProviderRecord[]; routes: ModelRouteRecord[]; localProvider: {id: "agy"; label: string; kind: "local"}} {
    return {providers: this.store.listModelProviders(), routes: this.store.listModelRoutes(), localProvider: {id: "agy", label: "本地 Antigravity", kind: "local"}};
  }

  saveProvider(value: {id?: string; label?: string; kind?: string; baseUrl?: string; apiKey?: string}): ModelProviderRecord {
    const kinds = new Set<ModelProviderKind>(["openai_compatible", "openai_responses", "anthropic", "gemini"]);
    const kind = String(value.kind || "openai_compatible") as ModelProviderKind;
    if (!kinds.has(kind)) throw new Error("不支持的模型供应商协议");
    const label = String(value.label || "").trim();
    if (!label || label.length > 80) throw new Error("供应商名称必须为 1—80 个字符");
    const apiKey = value.apiKey === undefined ? undefined : String(value.apiKey).trim();
    if (!value.id && !apiKey) throw new Error("新增供应商必须提供 API Key");
    return this.store.saveModelProvider({
      id: value.id, label, kind, baseUrl: normalizedBaseUrl(kind, String(value.baseUrl || "")),
      ...(apiKey ? {encryptedApiKey: this.vault.protect(apiKey)} : {}),
    });
  }

  deleteProvider(id: string): void { this.store.deleteModelProvider(id); }

  saveRoute(value: {role?: string; providerId?: string; modelId?: string; fallbackEnabled?: boolean}): ModelRouteRecord {
    const roles = new Set<ModelRole>(["generation", "review", "workbench", "review_arbitration"]);
    const role = String(value.role || "") as ModelRole;
    if (!roles.has(role)) throw new Error("模型职责无效");
    return this.store.saveModelRoute({role, providerId: String(value.providerId || "agy"), modelId: String(value.modelId || ""), fallbackEnabled: value.fallbackEnabled === true});
  }

  private providerSecret(id: string): {provider: ModelProviderRecord; apiKey: string} {
    const provider = this.store.getModelProvider(id);
    if (!provider) throw new Error("模型供应商不存在");
    const encrypted = this.store.getEncryptedModelProviderKey(id);
    if (!encrypted) throw new Error("供应商尚未配置 API Key");
    return {provider, apiKey: this.vault.unprotect(encrypted)};
  }

  async refreshModels(id: string): Promise<ModelProviderRecord> {
    const {provider, apiKey} = this.providerSecret(id);
    try {
      const headers: Record<string, string> = {Accept: "application/json"};
      let url: string;
      if (["openai_compatible", "openai_responses"].includes(provider.kind)) { headers.Authorization = `Bearer ${apiKey}`; url = endpoint(provider.baseUrl, "models"); }
      else if (provider.kind === "anthropic") { headers["x-api-key"] = apiKey; headers["anthropic-version"] = "2023-06-01"; url = endpoint(provider.baseUrl, "models"); }
      else { headers["x-goog-api-key"] = apiKey; url = endpoint(provider.baseUrl, "models"); }
      const value = await responseJson(await fetch(url, {headers, redirect: "error", signal: AbortSignal.timeout(30_000)}));
      const source = Array.isArray(value.data) ? value.data : Array.isArray(value.models) ? value.models : [];
      const models = source.map((item) => {
        if (!item || typeof item !== "object") return "";
        const record = item as Record<string, unknown>;
        const raw = String(record.id || record.name || "");
        return provider.kind === "gemini" ? raw.replace(/^models\//, "") : raw;
      }).filter(Boolean).sort();
      if (!models.length) throw new Error("供应商连接成功，但没有返回可选择的模型");
      return this.store.updateModelProviderProbe(id, {models, status: "ready"});
    } catch (error) {
      const safe = sanitizedError(error, apiKey);
      this.store.updateModelProviderProbe(id, {status: "error", error: safe.message});
      throw safe;
    }
  }

  route(role: ModelRole): ModelRouteRecord {
    const selected = this.store.getModelRoute(role);
    if (role === "review_arbitration" && selected.providerId === "inherit_review") {
      const review = this.store.getModelRoute("review");
      return {...review, role, fallbackEnabled: selected.fallbackEnabled || review.fallbackEnabled};
    }
    return selected;
  }

  async generateJson(role: ModelRole, prompt: string, signal?: AbortSignal): Promise<{text: string; route: ModelRouteRecord; provider: ModelProviderRecord}> {
    const route = this.route(role);
    if (route.providerId === "agy") throw new Error("本地 AGY 路由不应调用外部模型适配器");
    const {provider, apiKey} = this.providerSecret(route.providerId);
    if (!route.modelId) throw new Error("当前职责没有选择模型");
    if (provider.status !== "ready" || !provider.models.includes(route.modelId)) throw new Error("所选供应商或模型尚未通过最近一次连接检查");
    const timeout = AbortSignal.timeout(20 * 60_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const system = "你是 Tomota 的隔离任务执行模型。完整执行用户提供的任务文件，只返回一个符合任务约束的 JSON 对象。禁止 Markdown 围栏、解释、工具调用或额外文本。Tomota 会独立校验，不能自行宣称通过。";
    let url: string; let headers: Record<string, string>; let payload: Record<string, unknown>;
    if (provider.kind === "openai_compatible") {
      url = endpoint(provider.baseUrl, "chat/completions");
      headers = {Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json"};
      payload = {model: route.modelId, messages: [{role: "system", content: system}, {role: "user", content: prompt}], response_format: {type: "json_object"}};
    } else if (provider.kind === "openai_responses") {
      url = endpoint(provider.baseUrl, "responses");
      headers = {Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json"};
      payload = {model: route.modelId, input: [{role: "system", content: system}, {role: "user", content: prompt}]};
    } else if (provider.kind === "anthropic") {
      url = endpoint(provider.baseUrl, "messages");
      headers = {"x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json"};
      payload = {model: route.modelId, max_tokens: 32_000, system, messages: [{role: "user", content: prompt}]};
    } else {
      url = endpoint(provider.baseUrl, `models/${encodeURIComponent(route.modelId)}:generateContent`);
      headers = {"x-goog-api-key": apiKey, "Content-Type": "application/json"};
      payload = {systemInstruction: {parts: [{text: system}]}, contents: [{role: "user", parts: [{text: prompt}]}], generationConfig: {responseMimeType: "application/json"}};
    }
    let value: Record<string, unknown>;
    try {
      value = await requestProviderJson(url, headers, payload, combined, provider.kind === "openai_compatible");
    } catch (error) {
      throw sanitizedError(error, apiKey);
    }
    const text = extractText(provider.kind, value);
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error();
    } catch { throw new Error("模型没有返回有效的 JSON 对象；Tomota 已拒绝产物"); }
    return {text, route, provider};
  }
}
