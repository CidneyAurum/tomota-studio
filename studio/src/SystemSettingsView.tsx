import { Bot, Fingerprint, LoaderCircle, LogIn, RefreshCw } from "lucide-react";

import { post } from "./api";
import { ModelProviderSettings } from "./ModelProviderSettings";
import { SystemHealthSettings } from "./SystemHealthSettings";
import { StatusPill } from "./ui-status";

export function SystemSettingsView({settings, onSettings, busy, run}: {settings: Record<string, any> | null; onSettings: (value: Record<string, any>) => void; busy: string; run: (key: string, task: () => Promise<void>) => void}) {
  const probeAntigravity = () => run("agy-probe", async () => {
    const antigravity = await post<Record<string, unknown>>("/api/antigravity/probe");
    onSettings({...settings, antigravity});
  });
  const skill = settings?.skill?.manifest || {};
  const skillLock = settings?.skill?.lock || {};
  const agy = settings?.antigravity || {};
  const refreshSkillLock = () => run("skill-refresh-lock", async () => {
    const skillStatus = await post<Record<string, unknown>>("/api/skill/refresh-lock");
    onSettings({...settings, skill: skillStatus});
  });
  return <>
    <section className="section-head large"><div><p className="eyebrow">LOCAL SYSTEM</p><h1>系统设置</h1><p>这里只管理全局运行时、Skill 锁定与浏览器环境，不读取或修改当前作品。</p></div></section>
    <div className="settings-grid system-settings-grid">
      <section className="panel setting-card agy-setting"><div className="setting-icon"><Bot/></div><div><span>Google Antigravity</span><h3>{agy.execution === "ready" ? "已连接，可以运行" : agy.reason === "unsupported_region" ? "Google 拒绝当前网络地区" : agy.execution === "blocked" ? "当前不可运行" : agy.installed ? "CLI 已安装，等待运行检测" : "尚未安装 AGY CLI"}</h3><p>{agy.message || "本地 Antigravity 是默认模型运行时；外部供应商必须由用户显式配置。"}</p>{agy.recovery && <p>{agy.recovery}</p>}<code>{agy.executable || "%LOCALAPPDATA%\\agy\\bin"}{agy.version ? ` · v${agy.version}` : ""}</code><div className="setup-links">{agy.installed && <button className="secondary small" onClick={probeAntigravity} disabled={busy === "agy-probe"}>{busy === "agy-probe" ? <LoaderCircle className="spin"/> : <RefreshCw/>}重新检测</button>}<a href="https://antigravity.google/docs/cli/install" target="_blank" rel="noreferrer">官方说明</a></div></div><StatusPill value={agy.execution === "ready" ? "succeeded" : agy.reason === "unsupported_region" ? "failed" : agy.auth === "authenticated" ? "authenticated" : agy.installed ? "unknown" : "failed"}/></section>
      <section className="panel setting-card"><div className="setting-icon"><Fingerprint/></div><div><span>写作 Skill</span><h3>{skill.skill_name || "未检测到写作 Skill"}</h3><p>{skillLock.ok ? "当前写作 Skill 已与 Tomota 校验锁定。" : skillLock.status === "missing_lock" ? "首次使用需要建立本机 Skill 锁。" : "当前 Skill 与上次锁定版本不同，请确认后重新锁定。"}</p><code>{String(skill.skill_version_hash || skillLock.current_hash || "等待状态检查").slice(0, 30)}</code>{!skillLock.ok && <div className="setup-links"><button className="secondary small" onClick={refreshSkillLock} disabled={busy === "skill-refresh-lock"}>{busy === "skill-refresh-lock" ? <LoaderCircle className="spin"/> : <RefreshCw/>}重新锁定当前 Skill</button></div>}</div><StatusPill value={skillLock.ok ? "succeeded" : skillLock.status === "missing_lock" ? "unknown" : "failed"}/></section>
      <section className="panel setting-card"><div className="setting-icon"><LogIn/></div><div><span>番茄专用浏览器</span><h3>{settings?.fanqie?.browserInstalled ? "Chrome / Edge 可用" : "未检测到浏览器"}</h3><p>独立可见会话；Cookie、Token 和验证码接口被禁用。</p><code>{settings?.fanqie?.profileDirectory || "—"}</code></div><StatusPill value={settings?.fanqie?.browserInstalled ? "succeeded" : "failed"}/></section>
    </div>
    <ModelProviderSettings snapshot={settings?.models} onChange={(models) => onSettings({...settings, models})} busy={busy} run={run}/>
    <SystemHealthSettings busy={busy} run={run}/>
  </>;
}
