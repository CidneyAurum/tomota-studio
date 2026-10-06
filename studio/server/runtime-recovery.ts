import {createHash} from "node:crypto";
import {lstat, readFile, readdir, realpath} from "node:fs/promises";
import {join, relative, resolve} from "node:path";

export interface RecoveryEntry {
  marker: string; bookId: string | null; scope: "file" | "book" | "unknown";
  state: "unconfirmed" | "committed_cleanup" | "rollback_cleanup" | "invalid";
  message: string; command: string | null;
}
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

// Diagnostics only: never infer that an "active" marker proves a process is
// alive or dead, and never delete a marker or restore data while Studio runs.
export async function recoveryDiagnostics(root: string, python: string, source = join(root, "src")): Promise<{entries: RecoveryEntry[]; truncated: boolean}> {
  const base = await realpath(resolve(root)), directory = join(base, ".tomota-locks");
  let names: string[];
  try {
    if ((await lstat(directory)).isSymbolicLink()) throw new Error("事务标记目录是链接，需人工检查");
    names = (await readdir(directory)).filter(name => name.endsWith(".owner.json")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {entries: [], truncated: false};
    throw error;
  }
  const entries: RecoveryEntry[] = [];
  for (const name of names.slice(0, 100)) {
    const marker = join(directory, name);
    try {
      const info = await lstat(marker);
      if (!/^[a-f0-9]{64}\.owner\.json$/.test(name) || !info.isFile() || info.isSymbolicLink() || info.size > 65536) throw new Error("不安全或过大的事务标记");
      const value = JSON.parse(await readFile(marker, "utf8")) as Record<string, unknown>;
      const bookId = String(value.book_id || "");
      if (!/^[A-Za-z0-9_-]+$/.test(bookId) || !/^[a-f0-9]{32}$/.test(String(value.token || ""))) throw new Error("作品编号或事务格式无效");
      const lockRoot = process.platform === "win32" ? base.toLowerCase() : base;
      const key = createHash("sha256").update(`${lockRoot}\0${bookId}`).digest("hex");
      if (name !== `${key}.owner.json`) throw new Error("标记与作品不匹配");
      const snapshot = resolve(String(value.snapshot || ""));
      const snapshotName = relative(join(base, ".planning-staging"), snapshot);
      if (!snapshotName || /[\\/]/.test(snapshotName) || snapshotName.startsWith("..")) throw new Error("恢复快照路径无效");
      if (value.scope !== undefined && value.scope !== "book" && value.scope !== "file") throw new Error("未知事务范围");
      const state = value.decision === "commit" ? "committed_cleanup" : value.restored === true ? "rollback_cleanup" : "unconfirmed";
      entries.push({marker, bookId, scope: value.scope === "file" ? "file" : "book", state,
        message: state === "committed_cleanup" ? "已记录提交，仍有清理待确认；不要重复原操作。" : state === "rollback_cleanup" ? "已记录补偿，仍有清理待确认。" : "存在未完成事务，可能仍在执行；请先退出所有写入者再恢复。",
        command: `$env:PYTHONPATH=${quote(resolve(source))}; & ${quote(python)} -B -m tomota.book_transaction --root ${quote(base)} --book-id ${quote(bookId)} --recover`});
    } catch {
      entries.push({marker, bookId: null, scope: "unknown", state: "invalid", message: "标记无法安全解析，请保留现场并人工检查，不要直接删除。", command: null});
    }
  }
  return {entries, truncated: names.length > 100};
}
