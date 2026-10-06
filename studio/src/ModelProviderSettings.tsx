import { useMemo, useState } from "react";
import { Bot, KeyRound, LoaderCircle, Plus, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";

import { del, post, put } from "./api";
import type { ModelProviderKind, ModelRole, ModelRouteRecord, ModelSettingsSnapshot } from "./types";

const ROLE_COPY: Record<ModelRole, {title: string; description: string}> = {
  generation: {title: "生成模型", description: "规划、正文、返工、风格提炼与去 AI 味改写"},
  review: {title: "审查模型", description: "设计、逻辑、人物、对白、连续性和冷审"},
  workbench: {title: "工作台助手模型", description: "理解指令、整理反馈、解释阻塞和生成操作计划"},
  review_arbitration: {title: "审查仲裁模型", description: "双候选盲审和修复稿复审；默认跟随审查模型"},
};

const DEFAULT_BASE: Record<ModelProviderKind, string> = {
  openai_compatible: "https://api.openai.com/v1",
  openai_responses: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
};

export function ModelProviderSettings({snapshot, onChange, busy, run}: {
  snapshot?: ModelSettingsSnapshot;
  onChange: (value: ModelSettingsSnapshot) => void;
  busy: string;
  run: (key: string, task: () => Promise<void>) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<ModelProviderKind>("openai_compatible");
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE.openai_compatible);
  const [apiKey, setApiKey] = useState("");
  const [keyUpdates, setKeyUpdates] = useState<Record<string, string>>({});
  const providers = snapshot?.providers || [];
  const routes = snapshot?.routes || [];
  const byId = useMemo(() => new Map(providers.map((item) => [item.id, item])), [providers]);

  const refresh = (providerId: string) => run(`model-refresh-${providerId}`, async () => onChange(await post<ModelSettingsSnapshot>(`/api/model-providers/${providerId}/models/refresh`)));
  const remove = (providerId: string) => run(`model-delete-${providerId}`, async () => onChange(await del<ModelSettingsSnapshot>(`/api/model-providers/${providerId}`)));
  const updateKey = (providerId: string) => run(`model-key-${providerId}`, async () => {
    const provider = byId.get(providerId);
    if (!provider) return;
    const value = await put<ModelSettingsSnapshot>(`/api/model-providers/${providerId}`, {label: provider.label, kind: provider.kind, baseUrl: provider.baseUrl, apiKey: keyUpdates[providerId] || ""});
    onChange(value);
    onChange(await post<ModelSettingsSnapshot>(`/api/model-providers/${providerId}/models/refresh`));
    setKeyUpdates((current) => ({...current, [providerId]: ""}));
  });
  const create = () => run("model-create", async () => {
    const value = await post<ModelSettingsSnapshot & {createdProviderId: string}>("/api/model-providers", {label, kind, baseUrl, apiKey});
    onChange(value);
    if (value.createdProviderId) onChange(await post<ModelSettingsSnapshot>(`/api/model-providers/${value.createdProviderId}/models/refresh`));
    setAdding(false); setLabel(""); setApiKey("");
  });
  const updateRoute = (route: ModelRouteRecord, changes: Partial<ModelRouteRecord>) => run(`model-route-${route.role}`, async () => {
    const next = {...route, ...changes};
    const provider = byId.get(next.providerId);
    if (provider && !provider.models.includes(next.modelId)) next.modelId = provider.models[0] || "";
    onChange(await put<ModelSettingsSnapshot>(`/api/model-routes/${route.role}`, next));
  });

  const routeCard = (role: ModelRole) => {
    const route = routes.find((item) => item.role === role) || {role, providerId: role === "review_arbitration" ? "inherit_review" : "agy", modelId: "", fallbackEnabled: false, updatedAt: ""};
    const provider = byId.get(route.providerId);
    return <article className="model-role-card" key={role}>
      <div className="model-role-copy"><span>{ROLE_COPY[role].title}</span><p>{ROLE_COPY[role].description}</p></div>
      <div className="model-route-controls">
        <label><span>运行来源</span><select value={route.providerId} onChange={(event) => void updateRoute(route, {providerId: event.target.value, modelId: ""})}>
          {role === "review_arbitration" && <option value="inherit_review">跟随审查模型</option>}
          <option value="agy">本地 Antigravity</option>
          {providers.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select></label>
        {provider && <label><span>模型</span><select value={route.modelId} onChange={(event) => void updateRoute(route, {modelId: event.target.value})} disabled={!provider.models.length}>
          {!provider.models.length && <option value="">请先拉取模型</option>}
          {provider.models.map((model) => <option key={model} value={model}>{model}</option>)}
        </select></label>}
        {provider && <label className="model-fallback"><input type="checkbox" checked={route.fallbackEnabled} onChange={(event) => void updateRoute(route, {fallbackEnabled: event.target.checked})}/><span>外部模型失败时，显式回退本地 AGY</span></label>}
      </div>
    </article>;
  };

  return <section className="panel model-settings-panel">
    <div className="panel-title"><div><span>模型职责与供应商</span><strong>默认全部使用本地 Antigravity</strong></div><Bot/></div>
    <p className="settings-card-intro">按职责选择模型，而不是按每个流程阶段拆分。外部模型只负责生成或审查，Tomota 仍独立执行结构、证据、Canon 与状态机校验。</p>
    <div className="model-role-grid">{routeCard("generation")}{routeCard("review")}{routeCard("workbench")}{routeCard("review_arbitration")}</div>
    <div className="model-provider-head"><div><span>外部供应商</span><p>API Key 仅以 Windows 当前用户加密形式保存在本机，不会由接口返回。</p></div><button className="secondary small" onClick={() => setAdding((value) => !value)}><Plus/>{adding ? "取消" : "新增供应商"}</button></div>
    {adding && <div className="model-provider-form">
      <label><span>名称</span><input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="例如 OpenAI 主账号"/></label>
      <label><span>协议</span><select value={kind} onChange={(event) => { const next = event.target.value as ModelProviderKind; setKind(next); setBaseUrl(DEFAULT_BASE[next]); }}><option value="openai_compatible">OpenAI-compatible · Chat Completions</option><option value="openai_responses">OpenAI · Responses API</option><option value="anthropic">Anthropic</option><option value="gemini">Gemini</option></select></label>
      <label className="provider-url"><span>API 地址</span><input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)}/></label>
      <label className="provider-key"><span>API Key</span><input type="password" autoComplete="new-password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="只在保存时发送到本机服务"/></label>
      <button className="primary" disabled={!label.trim() || !apiKey.trim() || busy === "model-create"} onClick={create}>{busy === "model-create" ? <LoaderCircle className="spin"/> : <KeyRound/>}保存并拉取模型</button>
    </div>}
    <div className="model-provider-list">
      {providers.map((provider) => <article key={provider.id}>
        <div className={`provider-state ${provider.status}`}><ShieldCheck/></div>
        <div className="provider-main"><strong>{provider.label}</strong><span>{provider.kind.replaceAll("_", "-")} · {provider.models.length} 个模型</span><code>{provider.baseUrl}</code>{provider.error && <p>{provider.error}</p>}<details className="provider-key-update"><summary>更换 API Key</summary><div><input type="password" autoComplete="new-password" value={keyUpdates[provider.id] || ""} onChange={(event) => setKeyUpdates((current) => ({...current, [provider.id]: event.target.value}))} placeholder="新密钥只发送到本机服务"/><button className="secondary small" disabled={!keyUpdates[provider.id]?.trim() || busy === `model-key-${provider.id}`} onClick={() => updateKey(provider.id)}><KeyRound/>更新</button></div></details></div>
        <div className="provider-actions"><button className="secondary small" disabled={busy === `model-refresh-${provider.id}`} onClick={() => refresh(provider.id)}>{busy === `model-refresh-${provider.id}` ? <LoaderCircle className="spin"/> : <RefreshCw/>}连接并拉取模型</button><button className="icon-button danger-icon" aria-label={`删除 ${provider.label}`} onClick={() => remove(provider.id)}><Trash2/></button></div>
      </article>)}
      {!providers.length && <div className="empty-note">尚未添加外部供应商。三类职责均继续使用本地 Antigravity。</div>}
    </div>
  </section>;
}
