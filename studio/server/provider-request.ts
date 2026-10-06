import { setTimeout as delay } from "node:timers/promises";

/** Keep machine-readable HTTP facts separate from provider-controlled text. */
export class ProviderHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs: number | null = null,
    readonly unsupportedJsonFormat = false,
  ) { super(message); this.name = "ProviderHttpError"; }

  get authenticationRequired(): boolean { return this.status === 401 || this.status === 403; }
  get transient(): boolean { return [429, 500, 502, 503, 504].includes(this.status); }
}

function retryAfter(value: string | null): number | null {
  if (!value?.trim()) return null;
  const raw = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw) * 1000;
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function unsupportedFormat(status: number, error: Record<string, unknown>, message: string): boolean {
  if (status !== 400 && status !== 422) return false;
  const param = String(error.param || "");
  if (param && !/^response_format(?:\.|$)/i.test(param)) return false;
  if (param && /^(unsupported_parameter|unsupported_value|unknown_parameter|unrecognized_parameter)$/.test(String(error.code || ""))) return true;
  const format = "(?:response_format|json_object)";
  const rejection = "(?:not supported|does not support|doesn't support|unsupported|unrecognized|unknown parameter|not allowed|不支持|无法识别)";
  return new RegExp(`${format}.{0,100}${rejection}|${rejection}.{0,100}${format}`, "i").test(message);
}

export async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  let value: unknown;
  try { value = JSON.parse(text); } catch {
    // Gateways often return HTML for 429/5xx. Preserve status without echoing it.
    if (!response.ok) throw new ProviderHttpError(`供应商请求失败（HTTP ${response.status}，响应不是 JSON）`, response.status, retryAfter(response.headers.get("retry-after")));
    throw new Error(`供应商返回的不是 JSON（HTTP ${response.status}）`);
  }
  if (!response.ok) {
    const record = value && !Array.isArray(value) && typeof value === "object" ? value as Record<string, unknown> : {};
    const nested = record.error && !Array.isArray(record.error) && typeof record.error === "object" ? record.error as Record<string, unknown> : {};
    const message = String(nested.message || record.message || "供应商请求失败");
    throw new ProviderHttpError(`HTTP ${response.status}：${message}`, response.status, retryAfter(response.headers.get("retry-after")), unsupportedFormat(response.status, nested, message));
  }
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("供应商返回的 JSON 顶层不是对象");
  return value as Record<string, unknown>;
}

type Wait = (milliseconds: number, signal: AbortSignal) => Promise<void>;
const wait: Wait = async (milliseconds, signal) => { await delay(milliseconds, undefined, {signal}); };

/** At most two transient retries and one explicitly justified format fallback.
 * The retry counter and overall abort deadline are shared across all attempts.
 * Unknown transport failures are not replayed: generation may already be billed.
 */
export async function requestProviderJson(
  url: string, headers: Record<string, string>, payload: Record<string, unknown>, signal: AbortSignal,
  allowFormatFallback = false, sleep: Wait = wait,
): Promise<Record<string, unknown>> {
  let body = payload;
  let transientRetries = 0;
  let formatFallbackUsed = false;
  for (;;) {
    signal.throwIfAborted();
    try {
      return await responseJson(await fetch(url, {method: "POST", headers, redirect: "error", signal, body: JSON.stringify(body)}));
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof ProviderHttpError)) throw error;
      if (allowFormatFallback && !formatFallbackUsed && Object.hasOwn(body, "response_format") && error.unsupportedJsonFormat) {
        const {response_format: _unsupported, ...compatible} = body;
        body = compatible;
        formatFallbackUsed = true;
        continue;
      }
      if (!error.transient || transientRetries >= 2) throw error;
      const milliseconds = Math.max([1000, 5000][transientRetries], error.retryAfterMs ?? 0);
      // Do not shorten a server-requested cooldown, or hold a task indefinitely.
      if (!Number.isFinite(milliseconds) || milliseconds > 60_000) throw error;
      transientRetries += 1;
      await sleep(milliseconds, signal);
    }
  }
}
