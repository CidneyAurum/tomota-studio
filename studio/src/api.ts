export class ApiError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(message: string, code = "request_failed", details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.details = details;
  }
}

const pendingReads = new Map<string, Promise<unknown>>();

async function request<T>(path: string, options: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(value.error || `请求失败：${response.status}`, String(value.code || "request_failed"), value);
  return value as T;
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const method = (options.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    pendingReads.clear();
    try {return await request<T>(path, options);}
    finally {pendingReads.clear();}
  }
  // Do not merge requests with custom headers, signals or fetch semantics.
  if (method !== "GET" || Object.keys(options).length) return request<T>(path, options);
  const prior = pendingReads.get(path);
  if (prior) return prior as Promise<T>;
  const current = request<T>(path, options);
  pendingReads.set(path, current);
  try {return await current;}
  finally {if (pendingReads.get(path) === current) pendingReads.delete(path);}
}

export const post = <T>(path: string, value: unknown = {}) => api<T>(path, { method: "POST", body: JSON.stringify(value) });
export const put = <T>(path: string, value: unknown = {}) => api<T>(path, { method: "PUT", body: JSON.stringify(value) });
export const del = <T>(path: string) => api<T>(path, { method: "DELETE" });

export async function uploadAuthorSource<T>(authorId: string, file: File): Promise<T> {
  pendingReads.clear();
  try {
    const response = await fetch(`/api/authors/${encodeURIComponent(authorId)}/sources?filename=${encodeURIComponent(file.name)}`, {
      method: "POST",
      headers: {"Content-Type": "application/octet-stream", "X-Tomota-Rights-Confirmed": "true"},
      body: file,
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(value.error || `上传失败：${response.status}`);
    return value as T;
  } finally {pendingReads.clear();}
}
