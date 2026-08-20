import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArchiveRestore, BookOpen, BookPlus, Bot, Check, ChevronRight, CircleAlert, Clock3, FilePenLine,
  Fingerprint, Gauge, Layers3, LibraryBig, ListTree, LoaderCircle, LogIn, MessageSquare, PanelLeftClose, Play, Plus, RefreshCw,
  RotateCcw, Save, Send, Settings2, ShieldCheck, Sparkles, Square, Trash2, UploadCloud, X,
} from "lucide-react";

import { api, post } from "./api";
import type { AgentJob, BatchPreview, FanqieAccount, FanqieSession, JobEvent, MasterOutline, ProjectDetail, ProjectFile, ProjectSummary, VolumeOutline, WorkflowFeedback } from "./types";

type View = "overview" | "planning" | "workflow" | "workspace" | "fanqie" | "settings";

const stages = [
  ["story_foundation", "故事圣经"], ["chapter_design", "章节设计"], ["design_review", "设计审查"],
  ["draft", "正文生成"], ["review_logic", "逻辑审查"], ["review_voice", "人物与去 AI"],
  ["review_continuity", "伏笔与承接"], ["cold_review", "无提示冷审"], ["canon_update", "Canon 更新"],
];

const stageLabel = (value?: string | null) => stages.find(([key]) => key === value)?.[1] || ({
  revise_logic: "逻辑返工", revise_voice: "人物返工", revise_continuity: "承接返工", revise_cold: "冷审返工",
  arc_review: "三章阶段审查", completed: "全部完成",
} as Record<string, string>)[value || ""] || value || "尚未开始";

const statusLabel = (value?: string) => ({
  running: "运行中", queued: "排队中", approved: "已通过", blocked: "已阻塞", completed: "已完成",
  succeeded: "已校验", failed: "失败", cancelled: "已取消", interrupted: "已中断", auth_required: "需要登录",
  logged_in: "已登录", human_action_required: "需要人工处理", unknown: "未检查",
  ui_changed: "页面已变化", idle: "未同步", authenticated: "已认证", planned: "待生成",
  reviewed_pending_approval: "已审完待批准", scheduled: "已排期", submitted: "已提交平台",
  published: "已发布", modified_after_review: "审后有修改", waiting_for_generation: "等待生成",
  prompt_ready: "已规划待生成", draft_unreviewed: "已有正文 · 待严格审查", legacy_unreviewed: "已有正文 · 待严格审查",
} as Record<string, string>)[value || ""] || value || "未知";

const chapterAlreadyHandled = (status?: string) => ["approved", "reviewed_pending_approval", "scheduled", "submitted", "published"].includes(status || "");

function StatusPill({ value }: {value?: string}) {
  return <span className={`status-pill status-${value || "unknown"}`}><span />{statusLabel(value)}</span>;
}

function fmtDate(value?: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function wordBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function App() {
  const [view, setView] = useState<View>("overview");
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [settings, setSettings] = useState<Record<string, any> | null>(null);
  const [fanqie, setFanqie] = useState<FanqieSession | null>(null);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<{kind: "ok" | "error"; text: string} | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [newBookOpen, setNewBookOpen] = useState(false);
  const detailRequest = useRef(0);

  const loadProjects = useCallback(async () => {
    const value = await api<ProjectSummary[]>("/api/projects");
    setProjects(value);
    setSelectedId((prior) => prior && value.some((item) => item.id === prior) ? prior : value[0]?.id || "");
  }, []);

  const loadDetail = useCallback(async (bookId: string) => {
    if (!bookId) return;
    const request = ++detailRequest.current;
    const value = await api<ProjectDetail>(`/api/projects/${bookId}`);
    if (request === detailRequest.current && value.book.id === bookId) setDetail(value);
  }, []);

  const refreshAll = useCallback(async () => {
    try {
      await loadProjects();
      if (selectedId) await loadDetail(selectedId);
    } catch (error) { setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) }); }
  }, [loadDetail, loadProjects, selectedId]);

  useEffect(() => { void loadProjects(); void api<Record<string, any>>("/api/settings").then(setSettings); void api<FanqieSession>("/api/fanqie/session").then(setFanqie); }, [loadProjects]);
  useEffect(() => { setDetail(null); if (selectedId) void loadDetail(selectedId); }, [loadDetail, selectedId]);
  useEffect(() => {
    if (!detail?.workflows?.some((item) => item.status === "running")) return;
    const timer = window.setInterval(() => { if (selectedId) void loadDetail(selectedId); void loadProjects(); }, 3000);
    return () => window.clearInterval(timer);
  }, [detail?.workflows, loadDetail, loadProjects]);

  const selected = projects.find((item) => item.id === selectedId);
  const latestRun = detail?.workflows?.[0] || selected?.latestWorkflow || null;
  const agyReady = settings?.antigravity?.execution === "ready";

  const run = async (key: string, task: () => Promise<void>) => {
    setBusy(key); setNotice(null);
    try { await task(); } catch (error) { setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) }); }
    finally { setBusy(""); }
  };

  const nav: Array<[View, string, typeof Gauge]> = [
    ["overview", "作品总览", Gauge], ["planning", "全书与分卷", Layers3], ["workflow", "严格流水线", Bot], ["workspace", "作品工作区", FilePenLine],
    ["fanqie", "番茄运营", UploadCloud], ["settings", "系统设置", Settings2],
  ];

  return <div className={`app-shell ${sidebarOpen ? "" : "sidebar-collapsed"}`}>
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">T</div>
        <div><strong>Tomota</strong><span>STUDIO</span></div>
      </div>
      <nav aria-label="主导航">
        {nav.map(([key, label, Icon]) => <button key={key} className={view === key ? "active" : ""} onClick={() => setView(key)} title={label}>
          <Icon size={19}/><span>{label}</span>{view === key && <ChevronRight size={14}/>}
        </button>)}
      </nav>
      <div className="sidebar-foot">
        <span className="local-dot"/>仅限本机
        <small>127.0.0.1</small>
      </div>
    </aside>

    <main>
      <header className="topbar">
        <button className="icon-button" onClick={() => setSidebarOpen((value) => !value)} aria-label="切换侧栏"><PanelLeftClose size={18}/></button>
        <div className="book-switcher">
          <LibraryBig size={17}/>
          <select value={selectedId} onChange={(event) => setSelectedId(event.target.value)} aria-label="当前作品">
            {projects.map((project) => <option value={project.id} key={project.id}>{project.title}</option>)}
          </select>
        </div>
        <div className="topbar-actions">
          <button className="secondary topbar-create" onClick={() => setNewBookOpen(true)}><BookPlus/>新建作品</button>
          <div className={`agy-chip ${agyReady ? "ready" : "missing"}`}><Bot size={15}/>{agyReady ? "Antigravity 已连接" : settings?.antigravity?.reason === "unsupported_region" ? "Antigravity 地区受限" : settings?.antigravity?.execution === "blocked" ? "Antigravity 不可运行" : settings?.antigravity?.installed ? "Antigravity 待检测" : "Antigravity 未接入"}</div>
          <button className="icon-button" onClick={() => void refreshAll()} aria-label="刷新"><RefreshCw size={17}/></button>
        </div>
      </header>

      {notice && <div className={`notice ${notice.kind}`}><span>{notice.text}</span><button onClick={() => setNotice(null)} aria-label="关闭"><X size={16}/></button></div>}

      <div className="page">
        {view === "overview" && <Overview projects={projects} selected={selected} onSelect={(bookId) => { setSelectedId(bookId); setView("workflow"); }}/>}
        {view === "planning" && <PlanningView project={selected} detail={detail} busy={busy} run={run} onRefresh={refreshAll}/>}
        {view === "workflow" && <WorkflowView project={selected} detail={detail} runId={latestRun?.id} busy={busy} run={run} onRefresh={refreshAll} onPlan={() => setView("planning")}/>}
        {view === "workspace" && <WorkspaceView project={selected} detail={detail} onRefresh={() => selectedId ? loadDetail(selectedId) : Promise.resolve()}/>}
        {view === "fanqie" && <FanqieView project={selected} detail={detail} session={fanqie} busy={busy} run={run} setSession={setFanqie} onRefresh={refreshAll}/>}
        {view === "settings" && <SettingsView project={selected} settings={settings} onSettings={setSettings} busy={busy} run={run}/>}
      </div>
    </main>
    {newBookOpen && <NewBookModal busy={busy} run={run} onClose={() => setNewBookOpen(false)} onCreated={async (bookId) => { setNewBookOpen(false); await loadProjects(); setSelectedId(bookId); await loadDetail(bookId); setView("planning"); }}/>}
  </div>;
}

const blankMaster = (): MasterOutline => ({
  version: 1, completion_mode: "open_ended", target_chapters: null, premise: "", core_conflict: "",
  ending_direction: "未锁定", major_beats: [], volumes: [], rolling_plan: {window_size: 5, planned_through: 0},
});

type PlanningScope = "new_book" | "book" | "volume" | "chapter";
type PlanningMessage = {role: "user" | "assistant"; text: string; proposal?: Record<string, any>; warnings?: string[]};

const planningFieldLabels: Record<string, string> = {
  title: "标题", genre: "题材", synopsis: "简介", premise: "故事核心", core_conflict: "主冲突", ending_direction: "结局方向",
  major_beats: "关键节点", volumes: "分卷方案", volume_id: "所属卷", objective: "目标", main_conflict: "本卷冲突",
  character_change: "人物变化", foreshadowing: "伏笔动作", ending: "卷末落点", chapter_number: "章节", obstacle: "阻碍",
  change: "本章变化", new_information: "新增信息", chapter_hook: "章末钩子", next_first_beat: "下一章第一拍",
  current_character_goal: "人物目标", relationship_state: "关系状态", body_information_state: "身体/信息状态",
  unresolved_foreshadowing: "未解决伏笔", ending_type: "结尾类型", target_word_count: "目标字数", problem_tags: "关注点",
};

function ProposalPreview({proposal}: {proposal: Record<string, any>}) {
  return <div className="proposal-preview">{Object.entries(proposal).map(([key, value]) => {
    const rendered = key === "volumes" && Array.isArray(value)
      ? value.map((item: any) => `${item.title}：${item.objective}`).join("\n")
      : Array.isArray(value) ? value.join("\n") : String(value ?? "");
    return <div key={key}><span>{planningFieldLabels[key] || key}</span><p>{rendered}</p></div>;
  })}</div>;
}

function PlanningAssistant({scope, context, onApply, onClose}: {scope: PlanningScope; context: Record<string, unknown>; onApply: (proposal: Record<string, any>) => void; onClose: () => void}) {
  const scopeName = {new_book: "新书创意", book: "全书总纲", volume: "当前卷纲", chapter: "当前章纲"}[scope];
  const quick = scope === "new_book" ? ["根据我的创意做一套可连载的新书方案", "先问我三个关键问题再规划"] : scope === "book" ? ["补全当前总纲的空白", "强化主冲突与长线悬念"] : scope === "volume" ? ["补全本卷目标、冲突和卷末落点", "检查本卷与全书主线是否脱节"] : ["生成可直接执行的章纲", "强化本章选择、后果与章末钩子"];
  const [messages, setMessages] = useState<PlanningMessage[]>([{role: "assistant", text: `我是 ${scopeName} 共创助手。你可以直接说想保留什么、改变什么，我会先给候选方案，不会自动覆盖。`}]);
  const [input, setInput] = useState(quick[0]);
  const [mode, setMode] = useState<"fill" | "rewrite">("fill");
  const [job, setJob] = useState<AgentJob | null>(null);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [error, setError] = useState("");
  const resolved = useRef("");

  const sendPrompt = async () => {
    const text = input.trim();
    if (!text || job && ["queued", "running"].includes(job.status)) return;
    const nextMessages = [...messages, {role: "user", text} as PlanningMessage];
    setMessages(nextMessages); setInput(""); setError(""); setEvents([]);
    try {
      const result = await post<{job: AgentJob}>("/api/planning/generate", {
        bookId: scope === "new_book" ? undefined : String(context.bookId || ""), scope, mode, instruction: text,
        context: {...context, conversation: nextMessages.slice(-8).map((item) => ({role: item.role, text: item.text, proposal: item.proposal}))},
      });
      setJob(result.job);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  useEffect(() => {
    if (!job) return;
    let disposed = false;
    const load = async () => {
      try {
        const result = await api<{job: AgentJob; events: JobEvent[]; artifact: {proposal?: Record<string, any>; rationale?: string[]; warnings?: string[]} | null}>(`/api/planning/jobs/${job.id}`);
        if (disposed) return;
        setJob(result.job); setEvents(result.events || []);
        if (result.job.status === "succeeded" && result.artifact?.proposal && resolved.current !== result.job.id) {
          resolved.current = result.job.id;
          const rationale = Array.isArray(result.artifact.rationale) ? result.artifact.rationale.join("\n") : "候选规划已生成。";
          setMessages((prior) => [...prior, {role: "assistant", text: rationale, proposal: result.artifact!.proposal, warnings: result.artifact?.warnings || []}]);
        } else if (["failed", "auth_required", "cancelled", "interrupted"].includes(result.job.status) && resolved.current !== result.job.id) {
          resolved.current = result.job.id;
          setError(result.job.error || `任务状态：${statusLabel(result.job.status)}`);
        }
      } catch (reason) { if (!disposed) setError(reason instanceof Error ? reason.message : String(reason)); }
    };
    void load();
    const timer = ["queued", "running"].includes(job.status) ? window.setInterval(() => void load(), 1200) : undefined;
    return () => { disposed = true; if (timer) window.clearInterval(timer); };
  }, [job?.id, job?.status]);

  const latest = [...messages].reverse().find((item) => item.proposal)?.proposal;
  const active = Boolean(job && ["queued", "running"].includes(job.status));
  return <div className="assistant-backdrop" role="dialog" aria-modal="true" aria-label={`${scopeName} AI 共创`}><aside className="planning-assistant">
    <div className="assistant-head"><div><p className="eyebrow">ANTIGRAVITY CO-CREATION</p><h2>{scopeName} AI 共创</h2><span>对话生成候选方案 · 应用前不修改任何项目文件</span></div><button className="icon-button" onClick={onClose} aria-label="关闭 AI 共创"><X/></button></div>
    <div className="assistant-quick">{quick.map((item) => <button key={item} onClick={() => setInput(item)}>{item}</button>)}</div>
    <div className="assistant-messages">{messages.map((message, index) => <article className={message.role} key={index}><b>{message.role === "user" ? "你" : "Antigravity"}</b><p>{message.text}</p>{message.proposal && <ProposalPreview proposal={message.proposal}/>} {message.warnings?.length ? <small>待决定：{message.warnings.join("；")}</small> : null}</article>)}
      {active && <article className="assistant thinking"><b>Antigravity</b><p><LoaderCircle className="spin"/>正在分析当前层级与对话，已运行事件 {events.length} 条…</p><small>{events.at(-1)?.message || "任务已排队"}</small></article>}
      {error && <div className="assistant-error"><CircleAlert/>{error}</div>}
    </div>
    <div className="assistant-compose"><div><select value={mode} onChange={(event) => setMode(event.target.value as "fill" | "rewrite")}><option value="fill">补全空白，保留已有设定</option><option value="rewrite">重做当前层</option></select>{active && <button className="secondary small" onClick={() => void post(`/api/jobs/${job!.id}/cancel`).then(() => setJob({...job!, status: "cancelled"}))}><Square/>停止</button>}</div><textarea value={input} onChange={(event) => setInput(event.target.value)} placeholder="继续提出要求，例如：不要锁定结局，把人物矛盾提前……"/><div><span>AI 只生成候选；应用后仍需保存三级大纲。</span><button className="primary" disabled={active || !input.trim()} onClick={() => void sendPrompt()}><Send/>发送给 AI</button></div></div>
    <div className="assistant-foot"><button className="secondary" onClick={onClose}>稍后再说</button><button className="primary" disabled={!latest || active} onClick={() => { if (latest) onApply(latest); }}><Sparkles/>应用最新候选到表单</button></div>
  </aside></div>;
}

function NewBookModal({busy, run, onClose, onCreated}: {busy: string; run: (key: string, task: () => Promise<void>) => void; onClose: () => void; onCreated: (bookId: string) => Promise<void>}) {
  const [form, setForm] = useState({title: "", author: "", genre: "", synopsis: "", completionMode: "open_ended", targetChapters: ""});
  const [outline, setOutline] = useState<MasterOutline>(blankMaster());
  const [assistantOpen, setAssistantOpen] = useState(false);
  const create = () => run("new-book", async () => {
    if (!form.title.trim()) throw new Error("请填写作品标题，或先用 AI 共创生成候选");
    const master = {...outline};
    master.completion_mode = form.completionMode as "open_ended" | "fixed";
    master.target_chapters = form.completionMode === "fixed" ? Number(form.targetChapters) || null : null;
    master.premise = master.premise || form.synopsis.trim();
    const created = await post<{book: {id: string}}>("/api/projects", {
      title: form.title.trim(),
      metadata: {author: form.author.trim(), synopsis: form.synopsis.trim(), genre: form.genre.trim(), completion_mode: form.completionMode, target_chapters: master.target_chapters},
      outline: master, chapters: [],
    });
    await onCreated(created.book.id);
  });
  return <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="新建作品"><div className="book-modal">
    <div className="modal-head"><div><p className="eyebrow">NEW SERIAL</p><h2>新建作品</h2><span>可以直接描述创意并与 AI 共创；内部编号由系统自动生成。</span></div><div className="modal-head-actions"><button className="secondary" onClick={() => setAssistantOpen(true)}><MessageSquare/>AI 共创新书</button><button className="icon-button" onClick={onClose} aria-label="关闭"><X/></button></div></div>
    <div className="book-form">
      <label><span>作品标题</span><input value={form.title} onChange={(event) => setForm({...form, title: event.target.value})} placeholder="读者看到的书名"/></label>
      <label><span>作者名</span><input value={form.author} onChange={(event) => setForm({...form, author: event.target.value})}/></label>
      <label><span>题材/标签</span><input value={form.genre} onChange={(event) => setForm({...form, genre: event.target.value})} placeholder="奇幻 / 悬疑 / 轻小说"/></label>
      <label className="wide-field"><span>初始创意或简介</span><textarea value={form.synopsis} onChange={(event) => setForm({...form, synopsis: event.target.value})} placeholder="写核心钩子即可，后续可继续修改"/></label>
      <label><span>连载方式</span><select value={form.completionMode} onChange={(event) => setForm({...form, completionMode: event.target.value})}><option value="open_ended">开放式连载（推荐）</option><option value="fixed">预设目标章数</option></select><small>开放式只规划滚动窗口，不把已规划章数当作完结章数</small></label>
      {form.completionMode === "fixed" && <label><span>目标章数</span><input type="number" min="1" value={form.targetChapters} onChange={(event) => setForm({...form, targetChapters: event.target.value})}/></label>}
    </div>
    <div className="modal-foot"><p><ShieldCheck/>创建后进入“全书与分卷”，再建立卷纲和章节章纲。</p><button className="primary" disabled={busy === "new-book"} onClick={create}>{busy === "new-book" ? <LoaderCircle className="spin"/> : <BookPlus/>}创建并进入规划</button></div>
    {assistantOpen && <PlanningAssistant scope="new_book" context={{form, outline}} onClose={() => setAssistantOpen(false)} onApply={(proposal) => {
      setForm((prior) => ({...prior, title: String(proposal.title || prior.title), genre: String(proposal.genre || prior.genre), synopsis: String(proposal.synopsis || prior.synopsis)}));
      setOutline((prior) => ({...prior, premise: String(proposal.premise || prior.premise), core_conflict: String(proposal.core_conflict || prior.core_conflict), ending_direction: String(proposal.ending_direction || prior.ending_direction), major_beats: Array.isArray(proposal.major_beats) ? proposal.major_beats.map(String) : prior.major_beats, volumes: Array.isArray(proposal.volumes) ? proposal.volumes.map((item: any, index: number) => ({...item, volume_id: `volume-${index + 1}`})) : prior.volumes}));
      setAssistantOpen(false);
    }}/>}
  </div></div>;
}

function PlanningView({project, detail, busy, run, onRefresh}: {project?: ProjectSummary; detail: ProjectDetail | null; busy: string; run: (key: string, task: () => Promise<void>) => void; onRefresh: () => Promise<void>}) {
  const [book, setBook] = useState({title: "", author: "", synopsis: "", genre: "", completionMode: "open_ended", targetChapters: ""});
  const [master, setMaster] = useState<MasterOutline>(blankMaster());
  const [chapters, setChapters] = useState<Array<Record<string, any>>>([]);
  const [selection, setSelection] = useState<{level: "book" | "volume" | "chapter"; id: string}>({level: "book", id: "book"});
  const [assistantOpen, setAssistantOpen] = useState(false);

  useEffect(() => {
    if (!detail?.book) return;
    const metadata = detail.book.metadata || {};
    setBook({title: detail.book.title, author: String(metadata.author || ""), synopsis: String(metadata.synopsis || ""), genre: String(metadata.genre || ""), completionMode: String(metadata.completion_mode || "open_ended"), targetChapters: metadata.target_chapters ? String(metadata.target_chapters) : ""});
    setMaster(detail.outline?.master || blankMaster());
    setChapters((detail.outline?.chapters || []).map((item: any) => ({...(item.contract || item)})));
    setSelection({level: "book", id: "book"});
  }, [detail?.book.id, detail?.book.updated_at, detail?.outline?.master?.updated_at]);

  const volumes = master.volumes || [];
  const selectedVolume = selection.level === "volume" ? volumes.find((item) => item.volume_id === selection.id) : null;
  const selectedChapter = selection.level === "chapter" ? chapters.find((item) => String(item.chapter_number) === selection.id) : null;
  const chapterGroups = volumes.map((volume) => ({volume, chapters: chapters.filter((item) => String(item.volume_id || "volume-1") === volume.volume_id)}));
  const ungrouped = chapters.filter((item) => !volumes.some((volume) => volume.volume_id === String(item.volume_id || "volume-1")));

  const addVolume = () => {
    const index = volumes.length + 1;
    const volume: VolumeOutline = {volume_id: `volume-${index}`, title: `第 ${index} 卷`, objective: "", main_conflict: "", character_change: "", foreshadowing: "", ending: ""};
    setMaster({...master, volumes: [...volumes, volume]});
    setSelection({level: "volume", id: volume.volume_id});
  };
  const updateVolume = (patchValue: Partial<VolumeOutline>) => {
    setMaster({...master, volumes: volumes.map((item) => item.volume_id === selection.id ? {...item, ...patchValue} : item)});
  };
  const addChapter = (volumeId?: string) => {
    const number = Math.max(0, ...chapters.map((item) => Number(item.chapter_number) || 0)) + 1;
    const volume = volumeId || selectedVolume?.volume_id || volumes[0]?.volume_id || "volume-1";
    if (!volumes.length) {
      const initial: VolumeOutline = {volume_id: "volume-1", title: "第 1 卷", objective: "", main_conflict: "", character_change: "", foreshadowing: "", ending: ""};
      setMaster({...master, volumes: [initial], rolling_plan: {...master.rolling_plan, planned_through: number}});
    } else setMaster({...master, rolling_plan: {...master.rolling_plan, planned_through: number}});
    setChapters([...chapters, {chapter_number: number, volume_id: volume, title: `第 ${number} 章`, objective: "待规划", obstacle: "待规划", change: "待规划", next_first_beat: "待规划", target_word_count: 2800, problem_tags: []}]);
    setSelection({level: "chapter", id: String(number)});
  };
  const updateChapter = (patchValue: Record<string, unknown>) => setChapters(chapters.map((item) => String(item.chapter_number) === selection.id ? {...item, ...patchValue} : item));
  const save = () => run("planning-save", async () => {
    if (!project) throw new Error("请先选择作品");
    const completionMode = book.completionMode as "open_ended" | "fixed";
    const target = completionMode === "fixed" ? Number(book.targetChapters) || null : null;
    await api(`/api/projects/${project.id}`, {method: "PUT", body: JSON.stringify({title: book.title, metadata: {author: book.author, synopsis: book.synopsis, genre: book.genre, completion_mode: completionMode, target_chapters: target}})});
    await api(`/api/projects/${project.id}/outline`, {method: "PUT", body: JSON.stringify({master: {...master, completion_mode: completionMode, target_chapters: target, premise: master.premise || book.synopsis}, chapters})});
    await onRefresh();
  });
  const applyAIProposal = (proposal: Record<string, any>) => {
    if (selection.level === "book") {
      setBook((prior) => ({...prior, synopsis: String(proposal.synopsis || prior.synopsis), genre: String(proposal.genre || prior.genre)}));
      setMaster((prior) => ({...prior, premise: String(proposal.premise || prior.premise), core_conflict: String(proposal.core_conflict || prior.core_conflict), ending_direction: String(proposal.ending_direction || prior.ending_direction), major_beats: Array.isArray(proposal.major_beats) ? proposal.major_beats.map(String) : prior.major_beats, volumes: Array.isArray(proposal.volumes) ? proposal.volumes.map((item: any, index: number) => ({...item, volume_id: `volume-${index + 1}`})) : prior.volumes}));
    } else if (selection.level === "volume" && selectedVolume) updateVolume({...proposal, volume_id: selectedVolume.volume_id} as Partial<VolumeOutline>);
    else if (selectedChapter) updateChapter({...proposal, chapter_number: selectedChapter.chapter_number, volume_id: selectedChapter.volume_id});
    setAssistantOpen(false);
  };
  const selectedForAI = selection.level === "book" ? {book, master} : selection.level === "volume" ? selectedVolume : selectedChapter;
  const aiScopeLabel = selection.level === "book" ? "全书" : selection.level === "volume" ? "本卷" : "本章";

  return <>
    <section className="section-head large"><div><p className="eyebrow">THREE-LEVEL OUTLINE</p><h1>全书 · 分卷 · 章节</h1><p>已规划范围只是下一段可执行路线，不等于全书完结章数。</p></div><div className="planning-head-actions"><button className="secondary" disabled={!project} onClick={() => setAssistantOpen(true)}><MessageSquare/>AI 共创{aiScopeLabel}</button><button className="primary" disabled={!project || busy === "planning-save"} onClick={save}>{busy === "planning-save" ? <LoaderCircle className="spin"/> : <Save/>}保存三级大纲</button></div></section>
    <div className="planning-layout">
      <aside className="panel outline-tree">
        <button className={selection.level === "book" ? "active" : ""} onClick={() => setSelection({level: "book", id: "book"})}><BookOpen/><span><strong>全书</strong><small>{book.completionMode === "fixed" ? `目标 ${book.targetChapters || "—"} 章` : "开放式连载"}</small></span></button>
        {chapterGroups.map(({volume, chapters: items}) => <div className="volume-node" key={volume.volume_id}>
          <button className={selection.level === "volume" && selection.id === volume.volume_id ? "active" : ""} onClick={() => setSelection({level: "volume", id: volume.volume_id})}><Layers3/><span><strong>{volume.title}</strong><small>{items.length} 章已规划</small></span></button>
          <div>{items.map((chapter) => <button className={selection.level === "chapter" && selection.id === String(chapter.chapter_number) ? "active" : ""} onClick={() => setSelection({level: "chapter", id: String(chapter.chapter_number)})} key={chapter.chapter_number}><span className="chapter-dot"/><span><strong>第 {chapter.chapter_number} 章</strong><small>{String(chapter.title || "待命名")}</small></span></button>)}</div>
          <button className="tree-add" onClick={() => addChapter(volume.volume_id)}><Plus/>给本卷添加一章</button>
        </div>)}
        {ungrouped.map((chapter) => <button key={chapter.chapter_number} onClick={() => setSelection({level: "chapter", id: String(chapter.chapter_number)})}><span className="chapter-dot"/><span><strong>第 {chapter.chapter_number} 章</strong><small>未分卷</small></span></button>)}
        <button className="tree-add major" onClick={addVolume}><Plus/>添加一卷</button>
      </aside>
      <section className="panel outline-editor">
        {selection.level === "book" && <>
          <div className="panel-title"><div><span>全书层</span><strong>作品资料与总纲</strong></div><BookOpen/></div>
          <div className="outline-form">
            <label><span>作品标题</span><input value={book.title} onChange={(event) => setBook({...book, title: event.target.value})}/></label><label><span>作者名</span><input value={book.author} onChange={(event) => setBook({...book, author: event.target.value})}/></label>
            <label><span>题材/标签</span><input value={book.genre} onChange={(event) => setBook({...book, genre: event.target.value})}/></label><label><span>连载方式</span><select value={book.completionMode} onChange={(event) => setBook({...book, completionMode: event.target.value})}><option value="open_ended">开放式连载</option><option value="fixed">预设目标章数</option></select></label>
            {book.completionMode === "fixed" && <label><span>目标章数</span><input type="number" min="1" value={book.targetChapters} onChange={(event) => setBook({...book, targetChapters: event.target.value})}/></label>}
            <label className="wide-field"><span>作品简介</span><textarea value={book.synopsis} onChange={(event) => setBook({...book, synopsis: event.target.value})}/></label>
            <label className="wide-field"><span>故事核心</span><textarea value={master.premise} onChange={(event) => setMaster({...master, premise: event.target.value})} placeholder="一句话故事核、主角欲望与主要代价"/></label>
            <label className="wide-field"><span>全书主冲突</span><textarea value={master.core_conflict} onChange={(event) => setMaster({...master, core_conflict: event.target.value})}/></label>
            <label><span>结局方向</span><input value={master.ending_direction} onChange={(event) => setMaster({...master, ending_direction: event.target.value})} placeholder="可写未锁定"/></label><label><span>滚动规划窗口</span><input type="number" min="1" max="20" value={master.rolling_plan.window_size} onChange={(event) => setMaster({...master, rolling_plan: {...master.rolling_plan, window_size: Number(event.target.value)}})}/><small>只决定每次向后细化几章，不是总章数</small></label>
            <label className="wide-field"><span>全书关键节点（每行一项）</span><textarea value={master.major_beats.join("\n")} onChange={(event) => setMaster({...master, major_beats: event.target.value.split("\n")})}/></label>
          </div>
        </>}
        {selectedVolume && <><div className="panel-title"><div><span>分卷层</span><strong>{selectedVolume.title}卷纲</strong></div><Layers3/></div><div className="outline-form">
          <label><span>卷名</span><input value={selectedVolume.title} onChange={(event) => updateVolume({title: event.target.value})}/></label><label><span>卷编号</span><input value={selectedVolume.volume_id} readOnly/></label>
          <label className="wide-field"><span>本卷目标</span><textarea value={selectedVolume.objective} onChange={(event) => updateVolume({objective: event.target.value})}/></label><label className="wide-field"><span>本卷主冲突</span><textarea value={selectedVolume.main_conflict} onChange={(event) => updateVolume({main_conflict: event.target.value})}/></label>
          <label><span>人物变化</span><textarea value={selectedVolume.character_change} onChange={(event) => updateVolume({character_change: event.target.value})}/></label><label><span>伏笔推进/兑现</span><textarea value={selectedVolume.foreshadowing} onChange={(event) => updateVolume({foreshadowing: event.target.value})}/></label>
          <label className="wide-field"><span>卷末落点与下一卷入口</span><textarea value={selectedVolume.ending} onChange={(event) => updateVolume({ending: event.target.value})}/></label>
        </div></>}
        {selectedChapter && <><div className="panel-title"><div><span>章节层</span><strong>第 {selectedChapter.chapter_number} 章章纲</strong></div><ListTree/></div><div className="outline-form">
          <label><span>章节标题</span><input value={selectedChapter.title || ""} onChange={(event) => updateChapter({title: event.target.value})}/></label><label><span>所属卷</span><select value={selectedChapter.volume_id || "volume-1"} onChange={(event) => updateChapter({volume_id: event.target.value})}>{volumes.map((volume) => <option value={volume.volume_id} key={volume.volume_id}>{volume.title}</option>)}</select></label>
          <label className="wide-field"><span>本章目标</span><textarea value={selectedChapter.objective || ""} onChange={(event) => updateChapter({objective: event.target.value})}/></label><label><span>阻碍</span><textarea value={selectedChapter.obstacle || ""} onChange={(event) => updateChapter({obstacle: event.target.value})}/></label><label><span>本章变化</span><textarea value={selectedChapter.change || ""} onChange={(event) => updateChapter({change: event.target.value})}/></label>
          <label><span>章末钩子</span><textarea value={selectedChapter.chapter_hook || ""} onChange={(event) => updateChapter({chapter_hook: event.target.value})}/></label><label><span>下一章第一拍</span><textarea value={selectedChapter.next_first_beat || ""} onChange={(event) => updateChapter({next_first_beat: event.target.value})}/></label>
          <label><span>目标字数</span><input type="number" min="500" max="10000" value={selectedChapter.target_word_count || 2800} onChange={(event) => updateChapter({target_word_count: Number(event.target.value)})}/></label>
        </div></>}
        {!project && <div className="empty-state"><BookPlus/><h3>先新建或选择作品</h3><p>作品建立后可在这里维护全书、分卷和章节三级大纲。</p></div>}
      </section>
    </div>
    {assistantOpen && project && <PlanningAssistant scope={selection.level} context={{bookId: project.id, book, master, chapters, selected: selectedForAI}} onClose={() => setAssistantOpen(false)} onApply={applyAIProposal}/>}
  </>;
}

function Overview({ projects, selected, onSelect }: {projects: ProjectSummary[]; selected?: ProjectSummary; onSelect: (id: string) => void}) {
  const active = projects.filter((item) => item.latestWorkflow?.status === "running").length;
  const totalApproved = projects.reduce((sum, item) => sum + item.approvedCount, 0);
  const totalBlocked = projects.reduce((sum, item) => sum + item.blockedCount, 0);
  return <>
    <section className="hero-row">
      <div><p className="eyebrow">创作控制台</p><h1>每一章，都留下通过的证据。</h1><p>Antigravity 负责创作，Tomota 负责把关。阶段、返工和发布状态在这里完整可见。</p></div>
      <div className="hero-seal"><ShieldCheck/><span>严格模式</span><small>Fail closed</small></div>
    </section>
    <section className="stat-grid">
      <Metric label="本地作品" value={projects.length} note="原档保留" icon={LibraryBig}/>
      <Metric label="运行中流程" value={active} note="每书单任务" icon={Bot}/>
      <Metric label="严格通过" value={totalApproved} note="可进入发布预览" icon={Check}/>
      <Metric label="开放问题" value={totalBlocked} note="不会自动越过" icon={CircleAlert}/>
    </section>
    <section className="section-head"><div><p className="eyebrow">BOOKS</p><h2>作品进度</h2></div><span>{projects.length} 个本地项目</span></section>
    <div className="book-grid">
      {projects.map((project, index) => <article className={`book-card ${selected?.id === project.id ? "selected" : ""}`} key={project.id} onClick={() => onSelect(project.id)}>
        <div className={`book-spine tone-${index % 4}`}><span>{String(index + 1).padStart(2, "0")}</span></div>
        <div className="book-card-body">
          <div className="card-top"><span className="legacy-tag">{project.legacy ? "已迁移原档" : "Studio"}</span><StatusPill value={project.latestWorkflow?.status || "unknown"}/></div>
          <h3>{project.title}</h3><p>{String(project.metadata?.genre || "未设置题材")}</p>
          <div className="progress-label"><span>{stageLabel(project.latestWorkflow?.current_stage)}</span><b>{project.completionMode === "fixed" ? `${project.approvedCount}/${project.targetChapterCount || "—"} 章` : `已规划 ${project.plannedChapterCount ?? project.chapterCount} 章 · 开放式`}</b></div>
          <div className="progress-track" title={project.completionMode === "fixed" ? "全书目标进度" : "当前已规划范围内的通过进度，不代表全书完结比例"}><span style={{width: `${(project.completionMode === "fixed" ? Number(project.targetChapterCount) : Number(project.plannedChapterCount ?? project.chapterCount)) ? Math.min(100, Math.round(project.approvedCount / Number(project.completionMode === "fixed" ? project.targetChapterCount : project.plannedChapterCount ?? project.chapterCount) * 100)) : 0}%`}}/></div>
          <div className="book-stats"><span><b>{project.approvedCount}</b> 已通过</span><span><b>{project.blockedCount}</b> 待修复</span><span><b>{project.publishReadyCount}</b> 可发布</span></div>
        </div>
      </article>)}
    </div>
  </>;
}

function Metric({label, value, note, icon: Icon}: {label: string; value: number; note: string; icon: typeof Gauge}) {
  return <div className="metric"><div className="metric-icon"><Icon size={19}/></div><div><span>{label}</span><strong>{value}</strong><small>{note}</small></div></div>;
}

function WorkflowView({ project, detail, runId, busy, run, onRefresh, onPlan }: {project?: ProjectSummary; detail: ProjectDetail | null; runId?: string; busy: string; run: (key: string, task: () => Promise<void>) => void; onRefresh: () => Promise<void>; onPlan: () => void}) {
  const [selectedChapters, setSelectedChapters] = useState<number[]>([]);
  const [logs, setLogs] = useState<JobEvent[]>([]);
  const [feedback, setFeedback] = useState("");
  const [feedbackHistory, setFeedbackHistory] = useState<WorkflowFeedback[]>([]);
  const [now, setNow] = useState(Date.now());
  const latestJob = detail?.jobs?.[0];
  const workflow = detail?.workflows?.[0];
  const planned = (detail?.chapters || []).map((item: any) => ({...item, contract: item.contract || {}})).sort((a: any, b: any) => Number(a.chapter_number) - Number(b.chapter_number));
  const volumes = detail?.outline?.master?.volumes || [];
  const volumeGroups = volumes.map((volume) => ({volume, chapters: planned.filter((item: any) => String(item.contract?.volume_id || "volume-1") === volume.volume_id)}));

  useEffect(() => {
    const next = planned.find((item: any) => !chapterAlreadyHandled(String(item.status)));
    setSelectedChapters(next ? [Number(next.chapter_number)] : planned[0] ? [Number(planned[0].chapter_number)] : []);
  }, [project?.id]);
  useEffect(() => {
    if (!latestJob || !["running", "queued"].includes(latestJob.status)) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [latestJob?.id, latestJob?.status]);

  useEffect(() => {
    setLogs([]);
    if (!latestJob?.id) return;
    const source = new EventSource(`/api/jobs/${latestJob.id}/events`);
    const handler = (event: MessageEvent) => setLogs((prior) => [...prior.slice(-199), JSON.parse(event.data)]);
    for (const name of ["info", "stdout", "stderr", "error"]) source.addEventListener(name, handler as EventListener);
    return () => source.close();
  }, [latestJob?.id]);
  useEffect(() => {
    if (!runId) { setFeedbackHistory([]); return; }
    void api<{feedback: WorkflowFeedback[]}>(`/api/workflows/${runId}/feedback`).then((value) => setFeedbackHistory(value.feedback));
  }, [runId]);

  const currentIndex = stages.findIndex(([key]) => key === workflow?.current_stage);
  const start = () => run("start", async () => {
    if (!selectedChapters.length) throw new Error("请先在卷章选择器中选择本次处理章节");
    await post("/api/workflows", { bookId: project?.id, chapters: selectedChapters, maxRevisions: 5, autoRun: true });
    await onRefresh();
  });
  const continueRun = () => run("continue", async () => { await post(`/api/workflows/${runId}/run-next`); await onRefresh(); });
  const cancel = () => latestJob && run("cancel", async () => { await post(`/api/jobs/${latestJob.id}/cancel`); await onRefresh(); });
  const retry = () => latestJob && run("retry", async () => { await post(`/api/jobs/${latestJob.id}/retry`); await onRefresh(); });
  const submitFeedback = () => run("feedback", async () => {
    if (!runId) throw new Error("请先启动工作流");
    const result = await post<{feedbackHistory: WorkflowFeedback[]}>(`/api/workflows/${runId}/feedback`, {feedback});
    setFeedback(""); setFeedbackHistory(result.feedbackHistory); await onRefresh();
  });

  const elapsedSeconds = latestJob?.startedAt && ["running", "queued"].includes(latestJob.status) ? Math.max(0, Math.floor((now - new Date(latestJob.startedAt).getTime()) / 1000)) : latestJob?.startedAt && latestJob.finishedAt ? Math.max(0, Math.floor((new Date(latestJob.finishedAt).getTime() - new Date(latestJob.startedAt).getTime()) / 1000)) : 0;
  const sameStageDurations = (detail?.jobs || []).filter((item) => item.stage === latestJob?.stage && item.startedAt && item.finishedAt && item.status === "succeeded").map((item) => Math.round((new Date(item.finishedAt!).getTime() - new Date(item.startedAt!).getTime()) / 1000)).sort((a, b) => a - b);
  const usualSeconds = sameStageDurations.length ? sameStageDurations[Math.floor(sameStageDurations.length / 2)] : null;
  const slow = latestJob?.status === "running" && elapsedSeconds > Math.max(120, (usualSeconds || 60) * 2);
  const stageHistory = Array.isArray((detail?.workflowState as any)?.stage_history) ? (detail?.workflowState as any).stage_history.slice(-8).reverse() : [];
  const currentContract = planned.find((item: any) => Number(item.chapter_number) === Number(workflow?.current_chapter))?.contract || planned.find((item: any) => selectedChapters.includes(Number(item.chapter_number)))?.contract;
  const currentVolume = volumes.find((item) => item.volume_id === String(currentContract?.volume_id || "volume-1"));
  const volumeReady = Boolean(currentVolume?.objective && currentVolume?.main_conflict);

  return <>
    <section className="section-head large"><div><p className="eyebrow">STRICT PIPELINE</p><h1>严格写作流水线</h1><p>{project?.title || "请选择作品"}</p></div><div className="run-controls">
      {!workflow || workflow.status !== "running" ? <>
        <details className="chapter-picker"><summary><ListTree/>已选 {selectedChapters.length} 章</summary><div className="chapter-picker-popover">
          <div className="picker-help"><strong>本次处理哪些章节？</strong><span>这里只决定本次任务队列，不代表小说将在这些章节完结。</span></div>
          {volumeGroups.length ? volumeGroups.map(({volume, chapters: items}) => <section key={volume.volume_id}><div><b>{volume.title}</b><button onClick={() => setSelectedChapters(items.filter((item: any) => !chapterAlreadyHandled(String(item.status))).map((item: any) => Number(item.chapter_number)))}>选本卷未完成</button></div>
            {items.map((item: any) => {
              const handled = chapterAlreadyHandled(String(item.status));
              return <label key={item.chapter_number} className={handled ? "handled" : ""}><input type="checkbox" disabled={handled} checked={!handled && selectedChapters.includes(Number(item.chapter_number))} onChange={(event) => setSelectedChapters((prior) => event.target.checked ? [...new Set([...prior, Number(item.chapter_number)])].sort((a,b) => a-b) : prior.filter((number) => number !== Number(item.chapter_number)))}/><span>第 {item.chapter_number} 章</span><strong>{String(item.title)}</strong><small>{statusLabel(String(item.status))}</small></label>;
            })}
          </section>) : <div className="empty-mini">还没有章节章纲</div>}
          <div className="picker-actions"><button className="secondary small" onClick={() => { const next = planned.find((item: any) => !chapterAlreadyHandled(String(item.status))); setSelectedChapters(next ? [Number(next.chapter_number)] : []); }}>只选下一章</button><button className="secondary small" onClick={() => setSelectedChapters([])}>清空</button><button className="secondary small" onClick={onPlan}><Layers3/>去规划卷章</button></div>
        </div></details>
        <button className="primary" disabled={!project || !selectedChapters.length || busy === "start"} onClick={start}>{busy === "start" ? <LoaderCircle className="spin"/> : <Play/>}启动所选章节</button>
      </> : <>
        <button className="secondary" onClick={cancel} disabled={!latestJob || !["running", "queued"].includes(latestJob.status)}><Square/>停止</button>
        <button className="primary" onClick={continueRun} disabled={busy === "continue" || Boolean(latestJob && ["running", "queued"].includes(latestJob.status))}><Play/>继续自动运行</button>
      </>}
    </div></section>
    <div className="workflow-layout">
      <section className="panel pipeline-panel">
        <div className="panel-title"><div><span>当前流程</span><strong>{workflow?.id || "尚未启动"}</strong></div><StatusPill value={workflow?.status || "unknown"}/></div>
        <div className="stage-list hierarchical-stages">
          <div className="scope-head"><BookOpen/><span><b>全书层</b><small>故事圣经与总纲</small></span></div>
          {stages.slice(0, 1).map(([key, label], index) => {
            const done = currentIndex > index || workflow?.status === "completed";
            const current = workflow?.current_stage === key || (workflow?.current_stage?.startsWith("revise_") && index >= 4 && index <= 7);
            return <div className={`stage-row ${done ? "done" : ""} ${current ? "current" : ""}`} key={key}>
              <div className="stage-number">{done ? <Check size={14}/> : String(index + 1).padStart(2, "0")}</div>
              <div><strong>{label}</strong><span>{current ? `当前 · 第 ${workflow?.current_chapter || "—"} 章` : done ? "已通过证据闸门" : "等待前序阶段"}</span></div>
              {current && <div className="current-beacon"/>}
            </div>;
          })}
          <div className="scope-head"><Layers3/><span><b>分卷层</b><small>{currentVolume?.title || "尚未分卷"}</small></span></div>
          <div className={`stage-row scope-data ${volumeReady ? "done" : ""}`}><div className="stage-number">{volumeReady ? <Check size={14}/> : "卷"}</div><div><strong>本卷卷纲</strong><span>{volumeReady ? "目标、冲突与卷末落点已载入" : "请先到“全书与分卷”补齐卷纲"}</span></div></div>
          <div className="scope-head"><ListTree/><span><b>章节层</b><small>{workflow?.current_chapter ? `第 ${workflow.current_chapter} 章` : "等待选择章节"}</small></span></div>
          {stages.slice(1).map(([key, label], offset) => {
            const index = offset + 1;
            const done = currentIndex > index || workflow?.status === "completed";
            const current = workflow?.current_stage === key || (workflow?.current_stage?.startsWith("revise_") && index >= 4 && index <= 7);
            return <div className={`stage-row ${done ? "done" : ""} ${current ? "current" : ""}`} key={key}>
              <div className="stage-number">{done ? <Check size={14}/> : String(index + 1).padStart(2, "0")}</div>
              <div><strong>{label}</strong><span>{current ? `当前 · 第 ${workflow?.current_chapter || "—"} 章` : done ? "已通过证据闸门" : "等待前序阶段"}</span></div>
              {current && <div className="current-beacon"/>}
            </div>;
          })}
        </div>
        {workflow && <div className="revision-strip"><RotateCcw size={16}/><span>本章返工轮次</span><b>{String(detail?.workflowState?.revision_round ?? 0)} / {String(detail?.workflowState?.max_revisions ?? 5)}</b><small>达到上限将自动阻塞</small></div>}
      </section>

      <section className="panel agent-panel">
        <div className="panel-title"><div><span>Antigravity 任务</span><strong>{latestJob ? `${stageLabel(latestJob.stage)} · ${latestJob.id}` : "等待任务"}</strong></div>{latestJob && <StatusPill value={latestJob.status}/>}</div>
        {latestJob ? <>
          <div className="job-meta"><span><BookOpen/>第 {latestJob.chapter ?? "全书"} 章</span><span><Clock3/>{fmtDate(latestJob.startedAt || latestJob.createdAt)}</span><span><Fingerprint/>{latestJob.promptPath.split(/[\\/]/).pop()}</span></div>
          <div className={`runtime-summary ${slow ? "slow" : ""}`}><div><Clock3/><span><b>{Math.floor(elapsedSeconds / 60)}:{String(elapsedSeconds % 60).padStart(2, "0")}</b><small>本阶段已耗时</small></span></div><div><Gauge/><span><b>{usualSeconds ? `通常约 ${usualSeconds} 秒` : "正在建立基准"}</b><small>{slow ? "明显慢于历史同阶段，仍有心跳且未假死" : "每个质量闸门使用独立 AGY 会话"}</small></span></div></div>
          <div className="execution-steps"><span className="done"><Check/>装载隔离上下文</span><span className={latestJob.status === "running" ? "active" : "done"}><Bot/>分析与生成产物</span><span className={latestJob.status === "succeeded" ? "done" : "pending"}><Fingerprint/>JSON 结构检查</span><span className={latestJob.status === "succeeded" ? "done" : "pending"}><ShieldCheck/>Tomota 质量闸门</span></div>
          <div className="terminal" aria-live="polite">
            <div className="terminal-head"><span/><span/><span/><b>公开执行轨迹 / {latestJob.stage}</b></div>
            <div className="terminal-body">
              {logs.length ? logs.map((event) => <p className={event.level} key={event.id}><time>{new Date(event.createdAt).toLocaleTimeString("zh-CN")}</time>{event.message}</p>) : <p className="muted">等待任务输出…</p>}
              {latestJob.error && <p className="error"><time>停止</time>{latestJob.error}</p>}
            </div>
          </div>
          {stageHistory.length > 0 && <div className="decision-trace"><div><strong>最近流程决策</strong><span>展示阶段结论与返工原因，不展示模型隐藏思维原文</span></div>{stageHistory.map((item: any, index: number) => <article key={`${item.at}-${index}`}><time>{fmtDate(item.at)}</time><b>{stageLabel(String(item.stage))}</b><p>{String(item.result || "阶段已处理")}</p></article>)}</div>}
          <div className="job-actions">
            <span>产物只有通过 Tomota 校验后才会推进流程。</span>
            {["failed", "interrupted", "auth_required", "cancelled"].includes(latestJob.status) && <button className="secondary" onClick={retry} disabled={busy === "retry"}><RotateCcw/>幂等重试</button>}
          </div>
        </> : <div className="empty-state"><Bot/><h3>没有正在执行的生成任务</h3><p>启动流程后，Studio 会自动把每个独立阶段交给 Antigravity。</p></div>}
      </section>
    </div>
    <section className="panel feedback-panel">
      <div className="panel-title"><div><span>修改反馈</span><strong>{workflow?.status === "running" ? `反馈将绑定第 ${workflow.current_chapter ?? "—"} 章 · ${stageLabel(workflow.current_stage)}` : "反馈入口常驻；启动新流程后即可提交"}</strong></div><FilePenLine/></div>
      <div className="feedback-compose">
        <textarea value={feedback} onChange={(event) => setFeedback(event.target.value)} maxLength={4000} disabled={workflow?.status !== "running"} placeholder={workflow?.status === "running" ? "例如：姜也的语气再冷一点；删掉解释性对白；不要改动已经锁定的伏笔。" : "请先在页面上方选择章节并启动新流程，然后在这里提交修改要求。"} aria-label="当前阶段修改反馈"/>
        <div><span>{workflow?.status === "running" ? "提交后会保留当前流程记录，并按反馈重新执行本阶段；Tomota 质量闸门仍然有效。" : "已完成或尚未启动时不会偷偷改稿。请先启动目标章节的新流程，反馈会绑定到当时的章节与阶段。"}</span><button className="primary" disabled={workflow?.status !== "running" || !feedback.trim() || busy === "feedback"} onClick={submitFeedback}>{busy === "feedback" ? <LoaderCircle className="spin"/> : <RotateCcw/>}{workflow?.status !== "running" ? "等待启动新流程" : latestJob && ["running", "queued"].includes(latestJob.status) ? "中止当前任务并按反馈重跑" : "按反馈重跑当前阶段"}</button></div>
      </div>
      {feedbackHistory.length > 0 && <div className="feedback-history">{feedbackHistory.slice(0, 5).map((item) => <article key={item.id}><StatusPill value={item.status === "applied" ? "succeeded" : "queued"}/><span>第 {item.chapter ?? "—"} 章 · {stageLabel(item.stage)}</span><p>{item.content}</p></article>)}</div>}
    </section>
  </>;
}

function WorkspaceView({ project, detail, onRefresh }: {project?: ProjectSummary; detail: ProjectDetail | null; onRefresh: () => Promise<void>}) {
  const [selectedFile, setSelectedFile] = useState<ProjectFile | null>(null);
  const [fileValue, setFileValue] = useState<{content: string; hash: string; editable: boolean} | null>(null);
  const [fileBusy, setFileBusy] = useState(false);
  const [filter, setFilter] = useState("drafts");
  const groups = useMemo(() => [...new Set((detail?.files || []).map((item) => item.category))], [detail?.files]);
  const files = (detail?.files || []).filter((item) => item.category === filter);
  const selectedChapterNumber = selectedFile?.name.match(/^chapter-(\d+)\.md$/)?.[1];
  const selectedChapterRow = selectedChapterNumber ? detail?.chapters?.find((item: any) => Number(item.chapter_number) === Number(selectedChapterNumber)) as any : null;
  const selectedDraftUnreviewed = selectedFile?.category === "drafts" && selectedChapterRow && !selectedChapterRow.review_path && ["draft_unreviewed", "legacy_unreviewed", "planned", "prompt_ready", "modified_after_review"].includes(String(selectedChapterRow.status));
  useEffect(() => { setSelectedFile(null); setFileValue(null); setFilter("drafts"); }, [project?.id]);
  useEffect(() => { if (groups.length && !groups.includes(filter)) setFilter(groups[0]); }, [filter, groups]);

  const openFile = async (file: ProjectFile) => { setSelectedFile(file); setFileValue(await api(`/api/files?path=${encodeURIComponent(file.path)}`)); };
  useEffect(() => { const first = files[0]; if (first && (!selectedFile || selectedFile.category !== filter)) void openFile(first); }, [filter, project?.id, detail?.files]);
  const save = async () => {
    if (!selectedFile || !fileValue) return;
    setFileBusy(true);
    try {
      const next = await api<{hash: string}>("/api/files", { method: "PUT", body: JSON.stringify({ path: selectedFile.path, content: fileValue.content, expectedHash: fileValue.hash }) });
      setFileValue({ ...fileValue, hash: next.hash }); await onRefresh();
    } finally { setFileBusy(false); }
  };

  return <>
    <section className="section-head large"><div><p className="eyebrow">BOOK WORKSPACE</p><h1>作品工作区</h1><p>{project?.title} · Canon 与审查资产只读保护</p></div></section>
    <div className="workspace-layout">
      <aside className="panel file-panel">
        <div className="file-panel-head"><strong>作品内容</strong><select value={filter} onChange={(event) => setFilter(event.target.value)}>{groups.map((group) => <option value={group} key={group}>{detail?.files.find((item) => item.category === group)?.categoryLabel || group}</option>)}</select></div>
        <div className="file-list">{files.map((file) => <button className={selectedFile?.path === file.path ? "active" : ""} onClick={() => void openFile(file)} key={file.path}>
          <FilePenLine/><div><strong>{file.name}</strong><span>{file.categoryLabel} · {wordBytes(file.size)}</span></div>{!file.editable && <ShieldCheck className="lock"/>}
        </button>)}</div>
      </aside>
      <section className="panel editor-panel">
        {selectedFile && fileValue ? <>
          <div className="editor-head"><div><span>{selectedFile.categoryLabel}</span><strong>{selectedFile.name}</strong></div><button className="primary small" disabled={!fileValue.editable || fileBusy} onClick={() => void save()}><Save/>{fileValue.editable ? "保存版本" : "工作流资产只读"}</button></div>
          <textarea spellCheck={false} readOnly={!fileValue.editable} value={fileValue.content} onChange={(event) => setFileValue({...fileValue, content: event.target.value})}/>
          <div className="editor-foot"><span>SHA-256 {fileValue.hash.slice(0, 16)}…</span><span>{fileValue.editable ? "保存时校验版本哈希" : "由 Tomota 状态机维护"}</span></div>
        </> : <div className="empty-state"><BookOpen/><h3>选择一份作品资产</h3><p>正文和章纲可受控编辑；Canon、审查与流程记录保持只读。</p></div>}
      </section>
      <aside className="panel findings-panel">
        <div className="panel-title"><div><span>审查问题</span><strong>{selectedDraftUnreviewed ? "尚未严格审查" : `${detail?.findings?.length || 0} 条开放证据`}</strong></div></div>
        <div className="finding-list">{!selectedDraftUnreviewed && detail?.findings?.length ? detail.findings.slice(0, 30).map((finding, index) => <article key={`${finding.finding_id}-${index}`}>
          <div><span>{String(finding.gate || "review")}</span><b>{String(finding.category || "未分类")}</b></div>
          <p>“{String(finding.quote || "缺少引文") }”</p><small>{String(finding.location || "未定位")}</small><strong>{String(finding.repair_requirement || "需要明确修复要求")}</strong>
        </article>) : <div className="empty-mini">{selectedDraftUnreviewed ? <><CircleAlert/>正文已经存在，但还没有严格审查报告</> : <><Check/>当前索引中没有开放审查证据</>}</div>}</div>
      </aside>
    </div>
  </>;
}

function FanqieView({ project, detail, session, busy, run, setSession, onRefresh }: {project?: ProjectSummary; detail: ProjectDetail | null; session: FanqieSession | null; busy: string; run: (key: string, task: () => Promise<void>) => void; setSession: (value: FanqieSession) => void; onRefresh: () => Promise<void>}) {
  const [accounts, setAccounts] = useState<FanqieAccount[]>([]);
  const [works, setWorks] = useState<any[]>([]);
  const [localInfo, setLocalInfo] = useState<any>(null);
  const [workFields, setWorkFields] = useState({platformWorkId: "", title: "", synopsis: "", tags: "", coverPath: ""});
  const [workWrite, setWorkWrite] = useState<any>(null);
  const [workWriteToken, setWorkWriteToken] = useState("");
  const [selectedChapters, setSelectedChapters] = useState<number[]>([]);
  const [batch, setBatch] = useState<BatchPreview | null>(null);
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const [accountLabel, setAccountLabel] = useState("");
  const [schedule, setSchedule] = useState({mode: "scheduled", chaptersPerDay: 2, publishHour: 20, startAt: ""});
  const approved = (detail?.chapters || []).filter((item) => item.status === "approved" && item.review_path);
  useEffect(() => { void api<{accounts: FanqieAccount[]}>('/api/fanqie/accounts').then((value) => setAccounts(value.accounts)); }, []);
  useEffect(() => { void api<{works: any[]}>("/api/fanqie/works").then((value) => setWorks(value.works)); }, [session]);
  useEffect(() => { if (works.length && !workFields.platformWorkId) setWorkFields((prior) => ({...prior, platformWorkId: works[0].platformId})); }, [works, workFields.platformWorkId]);
  useEffect(() => { setAccountLabel(session?.accountLabel || ""); }, [session?.accountId, session?.accountLabel]);
  useEffect(() => {
    if (!project) return;
    void api<any>(`/api/fanqie/local/${project.id}`).then((value) => {
      setLocalInfo(value);
      const metadata = value.book?.metadata || {};
      setWorkFields({
        platformWorkId: value.platformWorks?.[0]?.platformId || "",
        title: String(value.book?.title || ""), synopsis: String(metadata.synopsis || ""), tags: String(metadata.genre || ""), coverPath: value.covers?.[0] || "",
      });
    });
  }, [project?.id]);

  const login = () => run("login", async () => setSession(await post("/api/fanqie/login/open")));
  const switchAccount = (accountId: string) => run("account-switch", async () => {
    const result = await post<{accounts: FanqieAccount[]; session: FanqieSession}>(`/api/fanqie/accounts/${accountId}/switch`);
    setAccounts(result.accounts); setSession(result.session); setWorks(result.session.visibleWorks); setWorkWrite(null); setBatch(null);
  });
  const addAccount = () => run("account-add", async () => {
    const result = await post<{accounts: FanqieAccount[]; session: FanqieSession}>("/api/fanqie/accounts", {label: `番茄账号 ${accounts.length + 1}`});
    setAccounts(result.accounts); setSession(result.session); setWorks([]);
    setSession(await post("/api/fanqie/login/open"));
  });
  const renameAccount = () => session && run("account-rename", async () => {
    const result = await post<{accounts: FanqieAccount[]; session: FanqieSession}>(`/api/fanqie/accounts/${session.accountId}/rename`, {label: accountLabel});
    setAccounts(result.accounts); setSession(result.session);
  });
  const closeAccount = () => session && run("account-close", async () => {
    const result = await post<{accounts: FanqieAccount[]; session: FanqieSession}>(`/api/fanqie/accounts/${session.accountId}/close`);
    setAccounts(result.accounts); setSession(result.session);
  });
  const archiveAccount = () => session && run("account-archive", async () => {
    const expected = `ARCHIVE ${session.accountId}`;
    const confirmation = window.prompt(`只归档 Tomota 中的账号入口，不删除浏览器资料，也不影响番茄云端。\n请输入：${expected}`) || "";
    if (!confirmation) return;
    const result = await post<{accounts: FanqieAccount[]; session: FanqieSession}>(`/api/fanqie/accounts/${session.accountId}/archive`, {confirmation});
    setAccounts(result.accounts); setSession(result.session); setWorks(result.session.visibleWorks); setBatch(null);
  });
  const sync = () => run("sync", async () => {
    const result = await post<{session: FanqieSession; works: any[]}>("/api/fanqie/sync", { bookIds: project ? [project.id] : [] });
    setSession(result.session); setWorks(result.works);
  });
  const prepare = () => run("prepare", async () => setBatch(await post("/api/fanqie/batches/preview", {bookId: project?.id, platformWorkId: workFields.platformWorkId, chapters: selectedChapters, schedule})));
  const previewWorkWrite = () => run("work-preview", async () => setWorkWrite(await post("/api/fanqie/works/preview-write", {bookId: project?.id, platformWorkId: workFields.platformWorkId, fields: {title: workFields.title, synopsis: workFields.synopsis, tags: workFields.tags, coverPath: workFields.coverPath}})));
  const executeWorkWrite = () => workWrite && run("work-write", async () => {
    await post(`/api/fanqie/batches/${workWrite.id}/confirm`, {operation: "write", token: workWriteToken});
    const result = await post<any>(`/api/fanqie/works/${workWrite.id}/execute`, {confirmation: workWriteToken});
    setWorkWrite(null); setWorkWriteToken("");
    if (result.status !== "submitted") throw new Error(result.message || "平台未返回明确成功状态");
  });
  const confirmAndExecute = () => batch && run("execute", async () => {
    const publish = tokens.publish || ""; const write = tokens.write || "";
    await post(`/api/fanqie/batches/${batch.batch_id}/confirm`, { operation: "publish", token: publish });
    await post(`/api/fanqie/batches/${batch.batch_id}/confirm`, { operation: "write", token: write });
    const chapterConfirmations: Record<string, string> = {};
    for (const chapter of batch.chapters) {
      const token = tokens[`chapter-${chapter.chapter_number}`] || "";
      await post(`/api/fanqie/batches/${batch.batch_id}/confirm`, { operation: "submit", token, chapter: chapter.chapter_number, hash: chapter.content_fingerprint });
      chapterConfirmations[String(chapter.chapter_number)] = token;
    }
    const result = await post<Record<string, unknown>>(`/api/fanqie/batches/${batch.batch_id}/execute`, { confirmation: publish, actionConfirmation: write, chapterConfirmations });
    setBatch(null); setTokens({}); await onRefresh(); setSession(await api("/api/fanqie/session"));
    if (!["submitted", "partial"].includes(String(result.status))) throw new Error(String(result.message || "平台未返回明确成功状态"));
  });

  return <>
    <section className="section-head large"><div><p className="eyebrow">FANQIE OPERATIONS</p><h1>番茄作品运营</h1><p>每个账号使用独立浏览器会话；切换后只显示该账号的作品。</p></div><div className="run-controls fanqie-controls"><select value={session?.accountId || accounts.find((item) => item.active)?.id || ""} onChange={(event) => switchAccount(event.target.value)} aria-label="番茄账号">{accounts.map((account) => <option value={account.id} key={account.id}>{account.label}</option>)}</select><button className="secondary" onClick={addAccount} disabled={busy === "account-add"}>＋ 添加账号</button><button className="secondary" onClick={login} disabled={busy === "login"}><LogIn/>打开登录</button><button className="primary" onClick={sync} disabled={busy === "sync"}><RefreshCw className={busy === "sync" ? "spin" : ""}/>同步</button></div></section>
    <div className="fanqie-grid">
      <section className="panel account-panel">
        <div className="panel-title"><div><span>{session?.accountLabel || "当前账号"}</span><strong>{session?.writerName || "番茄作家专区"}</strong></div><StatusPill value={session?.status || "unknown"}/></div>
        <div className="account-state"><div className="account-avatar">番</div><div><strong>{session?.message || "尚未检查专用浏览器"}</strong><span>{session?.writerUrl || "https://fanqienovel.com/main/writer/home"}</span><small>同步：{statusLabel(session?.lastSyncStatus || "idle")} · 扫码与验证仍在可见浏览器完成</small></div></div>
        <div className="account-manager">
          <label><span>本机显示名称</span><input value={accountLabel} onChange={(event) => setAccountLabel(event.target.value)} maxLength={32}/></label>
          <button className="secondary" onClick={renameAccount} disabled={!session || !accountLabel.trim() || busy === "account-rename"}><FilePenLine/>重命名</button>
          <button className="secondary" onClick={closeAccount} disabled={!session || busy === "account-close"}><Square/>关闭会话</button>
          <button className="secondary archive-account" onClick={archiveAccount} disabled={!session || accounts.length <= 1 || busy === "account-archive"}><ArchiveRestore/>归档入口</button>
          <small>账号之间使用不同浏览器资料目录；关闭或归档不会删除番茄云端内容，也不会导出 Cookie。</small>
        </div>
      </section>
      <section className="panel works-panel">
        <div className="panel-title"><div><span>平台作品</span><strong>{works.length} 部可见作品</strong></div><span className="read-only-tag">只读同步</span></div>
        <div className="platform-works">{works.length ? works.map((work) => <article key={work.platformId}><div><BookOpen/><span><strong>{work.title}</strong><small>ID {work.platformId}</small></span></div><StatusPill value={work.status}/></article>) : <div className="empty-mini">登录后执行“同步可见状态”</div>}</div>
      </section>
      {works.length > 0 ? <section className="panel metadata-panel">
        <div className="panel-title"><div><span>作品资料与封面</span><strong>先预览差异，再即时确认写入</strong></div><ShieldCheck/></div>
        <div className="metadata-form">
          <label><span>平台作品</span><select value={workFields.platformWorkId} onChange={(event) => setWorkFields({...workFields, platformWorkId: event.target.value})}><option value="">请选择同步到的作品</option>{works.map((work) => <option value={work.platformId} key={work.platformId}>{work.title} · {work.platformId}</option>)}</select></label>
          <label><span>作品标题</span><input value={workFields.title} onChange={(event) => setWorkFields({...workFields, title: event.target.value})}/></label>
          <label className="wide-field"><span>作品简介</span><textarea value={workFields.synopsis} onChange={(event) => setWorkFields({...workFields, synopsis: event.target.value})}/></label>
          <label><span>标签（逗号或斜线分隔）</span><input value={workFields.tags} onChange={(event) => setWorkFields({...workFields, tags: event.target.value})}/></label>
          <label><span>本地封面</span><select value={workFields.coverPath} onChange={(event) => setWorkFields({...workFields, coverPath: event.target.value})}><option value="">不修改封面</option>{(localInfo?.covers || []).map((cover: string) => <option value={cover} key={cover}>{cover.split(/[\\/]/).pop()}</option>)}</select></label>
        </div>
        {!workWrite ? <button className="secondary metadata-preview" disabled={!workFields.platformWorkId || busy === "work-preview"} onClick={previewWorkWrite}><FilePenLine/>生成资料写入预览</button> : <div className="work-write-confirm"><div><span>将修改</span><strong>{workWrite.changedFields?.join("、")}</strong><code>{workWrite.payloadHash?.slice(0, 20)}…</code></div><label><span>请输入 {workWrite.confirmation}</span><input value={workWriteToken} onChange={(event) => setWorkWriteToken(event.target.value)} placeholder={workWrite.confirmation}/></label><button className="danger-write" disabled={busy === "work-write"} onClick={executeWorkWrite}><UploadCloud/>即时确认并写入</button><button className="secondary" onClick={() => { setWorkWrite(null); setWorkWriteToken(""); }}>取消</button></div>}
      </section> : <section className="panel fanqie-next"><BookOpen/><div><strong>先完成登录与同步</strong><p>读到平台作品后，这里才会显示资料、封面和章节发布操作。</p></div></section>}
      {works.length > 0 && approved.length > 0 && <section className="panel release-panel">
        <div className="panel-title"><div><span>自动化发布</span><strong>{approved.length} 章通过严格闸门</strong></div><ShieldCheck/></div>
        <div className="publish-options">
          <label><span>发布方式</span><select value={schedule.mode} onChange={(event) => setSchedule({...schedule, mode: event.target.value})}><option value="scheduled">平台定时发布</option><option value="immediate">立即提交审核</option></select></label>
          {schedule.mode === "scheduled" && <>
            <label><span>每天章节数</span><input type="number" min={1} max={5} value={schedule.chaptersPerDay} onChange={(event) => setSchedule({...schedule, chaptersPerDay: Number(event.target.value)})}/></label>
            <label><span>首个发布时间（小时）</span><input type="number" min={0} max={23} value={schedule.publishHour} onChange={(event) => setSchedule({...schedule, publishHour: Number(event.target.value)})}/></label>
            <label><span>首发日期（可选）</span><input type="date" value={schedule.startAt} onChange={(event) => setSchedule({...schedule, startAt: event.target.value})}/></label>
          </>}
          <p><ShieldCheck/>这里只生成并核对自动发布计划；实际填写和提交仍需本批次即时确认。平台发布后的定时执行由番茄完成。</p>
        </div>
        <div className="chapter-select">{approved.map((chapter) => { const number = Number(chapter.chapter_number); return <label key={number}><input type="checkbox" checked={selectedChapters.includes(number)} onChange={(event) => setSelectedChapters((prior) => event.target.checked ? [...prior, number] : prior.filter((item) => item !== number))}/><span>第 {number} 章</span><strong>{String(chapter.title)}</strong><small>{Number(chapter.word_count).toLocaleString()} 字</small></label>; })}</div>
        <button className="primary wide" disabled={!workFields.platformWorkId || !selectedChapters.length || busy === "prepare"} onClick={prepare}><Send/>生成发布批次预览</button>
      </section>}
    </div>
    {batch && <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="发布批次确认"><div className="batch-modal">
      <div className="modal-head"><div><p className="eyebrow">ACTION-TIME CONFIRMATION</p><h2>核对并即时确认</h2></div><button className="icon-button" onClick={() => setBatch(null)}><X/></button></div>
      <div className="batch-summary"><span>作品<strong>{batch.book_title}</strong><small>平台 ID {batch.platform_work_id}</small></span><span>批次<strong>{batch.batch_id}</strong></span><span>章节<strong>{batch.chapters.length}</strong></span></div>
      <div className="batch-chapters">{batch.chapters.map((chapter) => <article key={chapter.chapter_number}><div><b>第 {chapter.chapter_number} 章</b><strong>{chapter.title}</strong>{chapter.scheduled_at && <small>{new Date(chapter.scheduled_at).toLocaleString("zh-CN", {hour12: false})}</small>}</div><span>{chapter.word_count.toLocaleString()} 字</span><code>{chapter.content_fingerprint.slice(0, 16)}…</code></article>)}</div>
      <div className="confirm-fields">
        <ConfirmField label="批准这个明确批次" expected={`PUBLISH ${batch.batch_id}`} value={tokens.publish || ""} onChange={(value) => setTokens({...tokens, publish: value})}/>
        <ConfirmField label="批准当次浏览器写入" expected={`WRITE ${batch.batch_id}`} value={tokens.write || ""} onChange={(value) => setTokens({...tokens, write: value})}/>
        {batch.chapters.map((chapter) => <ConfirmField key={chapter.chapter_number} label={`提交第 ${chapter.chapter_number} 章`} expected={`SUBMIT ${batch.batch_id}:${chapter.chapter_number}:${chapter.content_fingerprint.slice(0, 12)}`} value={tokens[`chapter-${chapter.chapter_number}`] || ""} onChange={(value) => setTokens({...tokens, [`chapter-${chapter.chapter_number}`]: value})}/>)}
      </div>
      <div className="modal-foot"><p><ShieldCheck/>网络或页面状态不明确时会停止，不会盲目重试。</p><button className="danger-write" onClick={confirmAndExecute} disabled={busy === "execute"}>{busy === "execute" ? <LoaderCircle className="spin"/> : <UploadCloud/>}确认并写入番茄</button></div>
    </div></div>}
  </>;
}

function ConfirmField({label, expected, value, onChange}: {label: string; expected: string; value: string; onChange: (value: string) => void}) {
  return <label><span>{label}</span><code>{expected}</code><input value={value} onChange={(event) => onChange(event.target.value)} placeholder="请完整输入上方确认文本" autoComplete="off"/></label>;
}

function SettingsView({ project, settings, onSettings, busy, run }: {project?: ProjectSummary; settings: Record<string, any> | null; onSettings: (value: Record<string, any>) => void; busy: string; run: (key: string, task: () => Promise<void>) => void}) {
  const [cleanup, setCleanup] = useState<any>(null);
  const [applyText, setApplyText] = useState("");
  const preview = () => project && run("cleanup-preview", async () => setCleanup(await post(`/api/cleanup/${project.id}`, {apply: false})));
  const apply = () => project && run("cleanup-apply", async () => { if (applyText !== "APPLY CLEANUP") throw new Error("请输入 APPLY CLEANUP 才能执行清理"); setCleanup(await post(`/api/cleanup/${project.id}`, {apply: true})); setApplyText(""); });
  const probeAntigravity = () => run("agy-probe", async () => {
    const antigravity = await post<Record<string, unknown>>("/api/antigravity/probe");
    onSettings({...settings, antigravity});
  });
  const skill = settings?.skill?.manifest || {};
  const agy = settings?.antigravity || {};
  return <>
    <section className="section-head large"><div><p className="eyebrow">LOCAL SYSTEM</p><h1>系统设置</h1><p>生成运行时、Skill 锁定、浏览器会话与回收区</p></div></section>
    <div className="settings-grid">
      <section className="panel setting-card agy-setting"><div className="setting-icon"><Bot/></div><div><span>Google Antigravity</span><h3>{agy.execution === "ready" ? "已连接，可以运行" : agy.reason === "unsupported_region" ? "Google 拒绝当前网络地区" : agy.execution === "blocked" ? "当前不可运行" : agy.installed ? "CLI 已安装，等待运行检测" : "尚未安装 AGY CLI"}</h3><p>{agy.message || "仅 Antigravity 负责生产生成；没有 Codex/OpenAI 后备。"}</p>{agy.recovery && <p>{agy.recovery}</p>}<code>{agy.executable || "%LOCALAPPDATA%\\agy\\bin"}{agy.version ? ` · v${agy.version}` : ""}</code><div className="setup-links">{agy.installed && <button className="secondary small" onClick={probeAntigravity} disabled={busy === "agy-probe"}>{busy === "agy-probe" ? <LoaderCircle className="spin"/> : <RefreshCw/>}重新检测</button>}<a href="https://antigravity.google/docs/cli/install" target="_blank" rel="noreferrer">官方说明</a></div></div><StatusPill value={agy.execution === "ready" ? "succeeded" : agy.reason === "unsupported_region" ? "failed" : agy.auth === "authenticated" ? "authenticated" : agy.installed ? "unknown" : "failed"}/></section>
      <section className="panel setting-card"><div className="setting-icon"><Fingerprint/></div><div><span>写作 Skill</span><h3>{skill.name || "oh-story-claudecode"}</h3><p>当前整合流程由 Skill 内容和 Tomota 校验共同锁定。</p><code>{String(skill.aggregate_hash || skill.hash || "等待状态检查").slice(0, 30)}</code></div><StatusPill value={settings?.skill?.lock?.ok === false ? "failed" : "succeeded"}/></section>
      <section className="panel setting-card"><div className="setting-icon"><LogIn/></div><div><span>番茄专用浏览器</span><h3>{settings?.fanqie?.browserInstalled ? "Chrome / Edge 可用" : "未检测到浏览器"}</h3><p>独立可见会话；Cookie、Token 和验证码接口被禁用。</p><code>{settings?.fanqie?.profileDirectory || "—"}</code></div><StatusPill value={settings?.fanqie?.browserInstalled ? "succeeded" : "failed"}/></section>
      <section className="panel cleanup-card">
        <div className="panel-title"><div><span>七天回收区</span><strong>{project?.title || "请选择作品"}</strong></div><ArchiveRestore/></div>
        <p>默认只预览。只会处理作品目录内的 <code>.trash</code>；最终稿、Canon、章纲、审查与发布记录不在候选范围。</p>
        <div className="retention"><span><b>7</b> 天保留</span><span><b>100</b> MB 上限</span><span><b>2</b> 份工作稿</span></div>
        <button className="secondary wide" onClick={preview} disabled={!project || busy === "cleanup-preview"}><Trash2/>预览清理候选</button>
        {cleanup && <div className="cleanup-result"><strong>{cleanup.apply ? "已执行清理" : `找到 ${cleanup.candidates?.length || 0} 个候选`}</strong><span>预计回收 {wordBytes(cleanup.reclaimed_bytes || 0)}</span>{cleanup.candidates?.slice(0, 4).map((item: string) => <code key={item}>{item.split(/[\\/]/).slice(-3).join("/")}</code>)}</div>}
        <label className="cleanup-confirm"><span>实际清理需输入 APPLY CLEANUP</span><div><input value={applyText} onChange={(event) => setApplyText(event.target.value)} placeholder="APPLY CLEANUP"/><button className="danger-write" disabled={applyText !== "APPLY CLEANUP" || busy === "cleanup-apply"} onClick={apply}><Trash2/>应用</button></div></label>
      </section>
    </div>
  </>;
}
