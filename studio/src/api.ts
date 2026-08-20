export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || `请求失败：${response.status}`);
  return value as T;
}

export const post = <T>(path: string, value: unknown = {}) => api<T>(path, { method: "POST", body: JSON.stringify(value) });
