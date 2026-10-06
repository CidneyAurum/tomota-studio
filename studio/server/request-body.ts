/** Read a bounded JSON object from an HTTP byte stream. */
export async function readJsonObjectBody(request: AsyncIterable<Uint8Array>, maxBytes = 5 * 1024 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new Error("请求内容超过大小限制");
    chunks.push(Buffer.from(chunk));
  }
  let text: string;
  try { text = new TextDecoder("utf-8", {fatal: true}).decode(Buffer.concat(chunks, size)); }
  catch { throw new Error("请求正文不是有效的 UTF-8 文本"); }
  if (!text) return {};
  const value = JSON.parse(text) as unknown;
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("请求正文必须是 JSON 对象");
  return value as Record<string, unknown>;
}
