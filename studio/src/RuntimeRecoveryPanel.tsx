import {useCallback, useEffect, useState} from "react";
import {api} from "./api";

type Diagnostics = {entries: Array<{marker: string; bookId: string | null; scope: string; state: string; message: string; command: string | null}>; truncated: boolean};

export function RuntimeRecoveryPanel({compact = false}: {compact?: boolean}) {
  const [data, setData] = useState<Diagnostics | null>(null);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try {
      const value = await api<Diagnostics>("/api/runtime/recovery");
      if (!Array.isArray(value.entries)) throw new Error("诊断响应格式无效");
      setData(value); setError("");
    }
    catch (failure) {setError(failure instanceof Error ? failure.message : String(failure));}
  }, []);
  useEffect(() => {void refresh();}, [refresh]);
  if (compact) {
    if (error) return <aside role="alert" className="snapshot-security-warning">无法检查事务恢复记录：{error}。请到“系统设置 → 事务恢复诊断”查看。</aside>;
    return data?.entries.length ? <aside role="alert" className="snapshot-security-warning">检测到 {data.entries.length} 条未完成事务记录。请到“系统设置 → 事务恢复诊断”查看；不要重复重建或删除锁文件。</aside> : null;
  }
  return <section className="panel backup-settings-panel" aria-label="事务恢复诊断">
    <div className="panel-title"><strong>事务恢复诊断</strong><button className="secondary small" onClick={() => void refresh()}>刷新事务诊断</button></div>
    <p>这里只读检查，不会自动回滚。恢复前先保存编辑，退出所有桌面、网页后台与 CLI 写入进程，并保留两份数据库及隐藏事务目录。</p>
    {error && <p role="alert">诊断失败：{error}</p>}
    {data && !data.entries.length && <p>未发现未完成的作品事务。</p>}
    {data?.entries.map(entry => <article key={entry.marker} className="recovery-entry">
      <strong>{entry.bookId || "未知作品"} · {entry.scope === "file" ? "单文件事务" : "作品事务"}</strong>
      <p>{entry.message}</p><code>{entry.marker}</code>
      {entry.command && <><p>退出所有写入者后，在 PowerShell 中执行：</p><pre style={{whiteSpace: "pre-wrap", overflowWrap: "anywhere"}}>{entry.command}</pre></>}
    </article>)}
    {data?.truncated && <p role="alert">记录超过 100 条，当前只展示前 100 条，请人工检查目录。</p>}
  </section>;
}
