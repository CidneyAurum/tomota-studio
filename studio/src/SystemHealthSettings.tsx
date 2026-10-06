import { useEffect, useState } from "react";
import { AlertTriangle, Clock3, DatabaseBackup, Gauge, HardDrive, LoaderCircle, RefreshCw, ShieldCheck } from "lucide-react";

import { api, post } from "./api";
import { RuntimeRecoveryPanel } from "./RuntimeRecoveryPanel";

type StageMetric = {stage: string; total: number; succeeded: number; failed: number; timedOut: number; retries: number; firstPassRate: number; medianSeconds: number | null; p95Seconds: number | null};
type Snapshot = {id: string; path: string; createdAt: string; sizeBytes: number};
type RuntimeActivity = {active: number; queued: number; localActive: number; externalActive: number; limit: number};
type SnapshotPolicy = {encrypted: false; retentionCount: number; maxTotalBytes: number; reserveFreeBytes: number; availableBytes: number; currentTotalBytes: number; estimatedSnapshotBytes: number; canCreate: boolean; blockedReason: string};

const sizeLabel = (bytes: number) => bytes > 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : bytes > 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
const duration = (seconds: number | null) => seconds === null ? "—" : seconds >= 60 ? `${Math.floor(seconds / 60)}分${seconds % 60}秒` : `${seconds}秒`;

export function SystemHealthSettings({busy, run}: {busy: string; run: (key: string, task: () => Promise<void>) => void}) {
  const [metrics, setMetrics] = useState<{stages: StageMetric[]; runtime: RuntimeActivity} | null>(null);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [policy, setPolicy] = useState<SnapshotPolicy | null>(null);
  const load = async () => {
    const [metricValue, backupValue] = await Promise.all([api<{stages: StageMetric[]; runtime: RuntimeActivity}>("/api/metrics/stages"), api<{snapshots: Snapshot[]; policy: SnapshotPolicy}>("/api/backups")]);
    setMetrics(metricValue); setSnapshots(backupValue.snapshots); setPolicy(backupValue.policy);
  };
  useEffect(() => { run("health-initial", load); }, []);
  const backup = () => run("studio-backup", async () => { const value = await post<{snapshots: Snapshot[]; policy: SnapshotPolicy}>("/api/backups"); setSnapshots(value.snapshots); setPolicy(value.policy); });
  const refresh = () => run("health-refresh", load);
  return <div className="system-health-grid">
    <RuntimeRecoveryPanel/>
    <section className="panel runtime-metrics-panel">
      <div className="panel-title"><div><span>阶段运行指标</span><strong>一次通过率、重试、超时与 P95</strong></div><button className="icon-button" aria-label="刷新运行指标" onClick={refresh}>{busy === "health-refresh" ? <LoaderCircle className="spin"/> : <RefreshCw/>}</button></div>
      <div className="runtime-capacity"><Gauge/><span>本地 AGY 子进程 <b>{metrics?.runtime.localActive || 0}/{metrics?.runtime.limit || 2}</b></span><span>外部请求 <b>{metrics?.runtime.externalActive || 0}</b></span><span>全部运行中 <b>{metrics?.runtime.active || 0}</b></span><span>排队 <b>{metrics?.runtime.queued || 0}</b></span></div>
      <div className="stage-metric-table"><header><span>阶段</span><span>一次通过</span><span>重试/超时</span><span>中位/P95</span></header>{metrics?.stages.length ? metrics.stages.slice(0, 14).map((item) => <div key={item.stage}><strong>{item.stage}</strong><span>{item.firstPassRate}%</span><span>{item.retries} / {item.timedOut}</span><span>{duration(item.medianSeconds)} / {duration(item.p95Seconds)}</span></div>) : <p className="empty-note">尚无任务样本；执行后会自动形成阶段基准。</p>}</div>
    </section>
    <section className="panel backup-settings-panel">
      <div className="panel-title"><div><span>整库安全快照</span><strong>数据库、书稿、作者库、配置与任务产物</strong></div><DatabaseBackup/></div>
      <p>无运行任务时每天自动保留一份，默认保留最近 {policy?.retentionCount || 7} 份。快照写入项目的 <code>backups</code> 目录，不包含账号 Cookie、Token 或验证码。</p>
      <div className="snapshot-security-warning"><AlertTriangle/><div><strong>作品快照未加密</strong><span>正文、大纲、Canon 与任务产物是本地明文文件，请勿复制到不可信网盘、U 盘或共享目录。API Key 仍只以 Windows DPAPI 密文存在。</span></div></div>
      <div className="snapshot-budget"><HardDrive/><span>快照占用 <b>{sizeLabel(policy?.currentTotalBytes || 0)}</b> / {sizeLabel(policy?.maxTotalBytes || 0)}</span><span>磁盘可用 <b>{sizeLabel(policy?.availableBytes || 0)}</b></span></div>
      {policy && !policy.canCreate && <p className="snapshot-blocked">当前无法创建：{policy.blockedReason}</p>}
      <button className="secondary wide" onClick={backup} disabled={busy === "studio-backup" || Boolean(metrics?.runtime.active || metrics?.runtime.queued) || policy?.canCreate === false}>{busy === "studio-backup" ? <LoaderCircle className="spin"/> : <ShieldCheck/>}立即创建一致性快照</button>
      <div className="snapshot-list">{snapshots.slice(0, 7).map((item) => <article key={item.id}><Clock3/><div><strong>{new Date(item.createdAt).toLocaleString("zh-CN")}</strong><code>{item.id}</code></div><span>{sizeLabel(item.sizeBytes)}</span></article>)}{!snapshots.length && <p className="empty-note">尚无整库快照。</p>}</div>
    </section>
  </div>;
}
