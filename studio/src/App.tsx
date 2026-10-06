import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  ArchiveRestore, BookOpen, BookPlus, Bot, Check, ChevronRight, CircleAlert, Clock3, FilePenLine,
  Fingerprint, Gauge, Layers3, LibraryBig, Link2, ListTree, LoaderCircle, LogIn, Maximize2, MessageSquare, Minus, PanelLeftClose, Play, Plus, RefreshCw,
  RotateCcw, Save, Send, Settings2, ShieldCheck, Sparkles, Square, Trash2, UploadCloud, X, ZoomIn,
} from "lucide-react";
import { matchPath, useLocation, useNavigate } from "./router";

import { ApiError, api, del, post, put } from "./api";
import { AuthorSpace, BookAuthorBindingPanel } from "./authors/AuthorSpace";
import { ChapterCockpitView, ContextReceiptView, PublicRecord, SemanticArtifact } from "./workflow/WorkflowInspector";
import { SystemSettingsView } from "./SystemSettingsView";
import { RuntimeRecoveryPanel } from "./RuntimeRecoveryPanel";
import { startPolling } from "./polling";
import { StatusPill, statusLabel } from "./ui-status";
import { textConfirmation } from "./text-confirmation";
import { navigationTarget, needsBook, viewFromPath, type View } from "./navigation";
import type { AgentExecutionResult, AgentJob, AgentPlanRecord, AuthorPreference, AuthorProfile, AuthorProfileSummary, AuthorVersion, BatchPreview, ChapterCockpit, ContextReceipt, FanqieAccount, FanqieSession, FanqieWriteWindow, FoundationContract, JobArtifactBundle, JobEvent, MasterOutline, OneClickBatchResolution, PlanningConversationMessage, ProjectDetail, ProjectFile, ProjectSummary, QualityBenchmark, QualityBenchmarkRun, ReaderFeedbackRecord, RebuildPreview, RevisionBriefRecord, VolumeOutline, WorkflowFeedback } from "./types";

type DeslopResult = {
  book_id: string;
  chapter_number: number;
  findings: Array<{rule_type: string; severity: string; line: number; column: number; message: string; excerpt?: string}>;
  punctuation_normalized: boolean;
  applied: boolean;
  changed: boolean;
  version_path: string | null;
  content_preview: string;
  effect_metrics?: {
    scope: string;
    before: {findings: number; density_per_1000_chars: number; counts: Record<string, number>};
    after: {findings: number; density_per_1000_chars: number; counts: Record<string, number>};
    resolved_patterns: number;
    new_patterns: number;
    text_similarity: number;
    semantic_quality_measured: boolean;
    notice: string;
  };
};

const stages = [
  ["story_foundation", "故事圣经"], ["chapter_design", "章节设计"], ["design_review", "设计审查"],
  ["draft", "正文生成"], ["review_logic", "逻辑审查"], ["review_voice", "人物与去 AI"],
  ["review_continuity", "伏笔与承接"], ["cold_review", "无提示冷审"], ["canon_update", "Canon 更新"],
];

const stageLabel = (value?: string | null) => stages.find(([key]) => key === value)?.[1] || ({
  revise_logic: "逻辑返工", revise_voice: "人物返工", revise_continuity: "承接返工", revise_cold: "冷审返工",
  arc_review: "三章阶段审查", completed: "全部完成",
} as Record<string, string>)[value || ""] || value || "尚未开始";

const chapterAlreadyHandled = (status?: string) => ["approved", "reviewed_pending_approval", "scheduled", "submitted", "published", "draft_unreviewed", "legacy_unreviewed", "modified_after_review", "invalidated"].includes(status || "");

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
  const location = useLocation();
  const navigate = useNavigate();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState("");
  const projectsRequest = useRef(0);
  const [authors, setAuthors] = useState<AuthorProfileSummary[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [settings, setSettings] = useState<Record<string, any> | null>(null);
  const [fanqie, setFanqie] = useState<FanqieSession | null>(null);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<{kind: "ok" | "error"; text: string} | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 820);
  const [newBookOpen, setNewBookOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const detailRequest = useRef(0);
  const view = viewFromPath(location.pathname);
  const authorContext = view === "authors";
  const systemContext = view === "settings";
  const authorMatch = matchPath("/authors/:authorId/*", location.pathname);
  const selectedAuthorId = authorMatch?.params.authorId === "new" ? "" : authorMatch?.params.authorId || "";

  const loadAuthors = useCallback(async () => {
    const value = await api<{authors: AuthorProfileSummary[]}>("/api/authors");
    setAuthors(value.authors);
  }, []);

  const loadProjects = useCallback(async (background = false) => {
    const request = ++projectsRequest.current;
    if (!background) setProjectsLoading(true);
    setProjectsError("");
    try {
      const value = await api<ProjectSummary[]>("/api/projects");
      if (request !== projectsRequest.current) return;
      setProjects(value);
      setSelectedId((prior) => prior && value.some((item) => item.id === prior) ? prior : value[0]?.id || "");
    } catch (error) {
      if (request === projectsRequest.current) setProjectsError(error instanceof Error ? error.message : String(error));
    } finally {if (request === projectsRequest.current) setProjectsLoading(false);}
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

  useEffect(() => {
    const report = (error: unknown) => setNotice({kind: "error", text: error instanceof Error ? error.message : String(error)});
    void loadProjects(); void loadAuthors().catch(report);
    void api<Record<string, any>>("/api/settings").then(setSettings).catch(report);
    void api<FanqieSession>("/api/fanqie/session").then(setFanqie).catch(report);
  }, [loadAuthors, loadProjects]);
  useEffect(() => {
    const collapseForNarrowScreen = () => { if (window.innerWidth <= 820) setSidebarOpen(false); };
    window.addEventListener("resize", collapseForNarrowScreen);
    return () => window.removeEventListener("resize", collapseForNarrowScreen);
  }, []);
  useEffect(() => {
    const match = matchPath("/books/:bookId/*", location.pathname);
    if (match?.params.bookId && projects.some((item) => item.id === match.params.bookId)) {
      if (selectedId !== match.params.bookId) setSelectedId(match.params.bookId);
      window.localStorage.setItem("tomota.lastBookId", match.params.bookId);
      return;
    }
    if (!authorContext && !systemContext && location.pathname === navigationTarget(view, "", []) && projects.length) {
      const remembered = window.localStorage.getItem("tomota.lastBookId");
      const target = projects.some((item) => item.id === remembered) ? remembered! : selectedId;
      navigate(navigationTarget(view, target, projects.map(item => item.id)), {replace: true});
    }
  }, [authorContext, systemContext, view, location.pathname, navigate, projects, selectedId]);
  useEffect(() => {
    ++detailRequest.current; setDetail(null);
    if (selectedId) void loadDetail(selectedId).catch(error => setNotice({kind: "error", text: String(error)}));
  }, [loadDetail, selectedId]);
  const workflowRunning = Boolean(detail?.workflows?.some(item => item.status === "running"));
  useEffect(() => {
    if (!workflowRunning) return;
    return startPolling(async () => {
      const results = await Promise.allSettled([loadDetail(selectedId), loadProjects(true)]);
      const failed = results.find(result => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    }, 3000, {
      onError: error => setNotice({kind: "error", text: error instanceof Error ? error.message : String(error)}),
    });
  }, [workflowRunning, selectedId, loadDetail, loadProjects]);

  const selected = projects.find((item) => item.id === selectedId);
  const latestRun = detail?.workflows?.[0] || selected?.latestWorkflow || null;
  const agyReady = settings?.antigravity?.execution === "ready";
  const selectedAuthor = authors.find((item) => item.id === selectedAuthorId);

  const setView = (next: View) => {
    navigate(navigationTarget(next, selectedId, projects.map(item => item.id)));
  };

  const run = async (key: string, task: () => Promise<void>) => {
    setBusy(key); setNotice(null);
    try { await task(); } catch (error) { setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) }); }
    finally { setBusy(""); }
  };

  const nav: Array<[View, string, typeof Gauge]> = [
    ["overview", "作品总览", Gauge], ["authors", "作者与文风", Sparkles], ["planning", "全书与分卷", Layers3], ["workflow", "严格流水线", Bot], ["workspace", "作品工作区", FilePenLine],
    ["fanqie", "番茄运营", UploadCloud], ["book-settings", "作品设置", Link2], ["settings", "系统设置", Settings2],
  ];

  const applyAgentHints = (plan: AgentPlanRecord | null) => {
    const actions = (plan?.artifact as {actions?: Array<{type: string; view?: string; bookId?: string}>} | undefined)?.actions || [];
    for (const action of actions) {
      if (action.type === "switch_view" && action.view) setView(action.view as View);
      if (action.type === "select_project" && action.bookId) { setSelectedId(action.bookId); navigate(`/books/${action.bookId}/overview`); }
    }
  };

  return <div className={`app-shell ${sidebarOpen ? "" : "sidebar-collapsed"}`}>
    <aside className="sidebar">
      <div className="brand">
        <img className="brand-mark" src="/tomota-mark.svg" alt="Tomota"/>
        <div><strong>Tomota</strong><span>STUDIO</span></div>
      </div>
      <nav aria-label="主导航">
        {nav.map(([key, label, Icon]) => <button key={key} className={view === key ? "active" : ""} aria-current={view === key ? "page" : undefined} onClick={() => setView(key)} title={label}>
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
        {authorContext ? <div className="book-switcher author-context-switcher"><Sparkles size={17}/><button onClick={() => navigate("/authors")}>作者库</button><ChevronRight size={14}/>{selectedAuthorId ? <select value={selectedAuthorId} onChange={(event) => navigate(`/authors/${event.target.value}`)} aria-label="当前作者">{authors.map((author) => <option value={author.id} key={author.id}>{author.name}</option>)}</select> : <span>{location.pathname === "/authors/new" ? "新建作者" : "全部作者"}</span>}</div> : systemContext ? <div className="book-switcher system-context-switcher"><Settings2 size={17}/><span>全局系统设置</span></div> : <div className="book-switcher">
          <LibraryBig size={17}/>{projects.length ? <select value={selectedId} onChange={(event) => { setSelectedId(event.target.value); navigate(`/books/${event.target.value}/${view}`); }} aria-label="当前作品">{projects.map((project) => <option value={project.id} key={project.id}>{project.title}</option>)}</select> : <span>{projectsLoading ? "正在加载作品" : projectsError ? "作品列表暂不可用" : "尚未选择作品"}</span>}
        </div>}
        <div className="topbar-actions">
          {!authorContext && !systemContext && <button className="primary workbench-agent-open" onClick={() => setAgentOpen(true)} aria-label="工作台 AI"><Sparkles/><span className="topbar-button-label">工作台 AI</span></button>}
          {authorContext ? <button className="primary topbar-create" onClick={() => navigate("/authors/new")}><Plus/><span className="topbar-button-label">新建作者</span></button> : !systemContext && <button className="secondary topbar-create" onClick={() => setNewBookOpen(true)}><BookPlus/><span className="topbar-button-label">新建作品</span></button>}
          <div className={`agy-chip ${agyReady ? "ready" : "missing"}`}><Bot size={15}/>{agyReady ? "Antigravity 已连接" : settings?.antigravity?.reason === "unsupported_region" ? "Antigravity 地区受限" : settings?.antigravity?.execution === "blocked" ? "Antigravity 不可运行" : settings?.antigravity?.installed ? "Antigravity 待检测" : "Antigravity 未接入"}</div>
          <button className="icon-button" onClick={() => void (authorContext ? loadAuthors() : systemContext ? api<Record<string, any>>("/api/settings").then(setSettings) : refreshAll())} aria-label="刷新"><RefreshCw size={17}/></button>
        </div>
      </header>

      {notice && <div className={`notice ${notice.kind}`}><span>{notice.text}</span><button onClick={() => setNotice(null)} aria-label="关闭"><X size={16}/></button></div>}
      <RuntimeRecoveryPanel compact/>
      {projectsError && <div className="notice error" role="alert"><span>作品列表加载失败：{projectsError}</span><button onClick={() => void loadProjects()} disabled={projectsLoading}>重新加载作品</button></div>}

      <div className="page">
        {needsBook(view) && !selected ? <>
          <section className="section-head large"><div><p className="eyebrow">BOOK WORKSPACE</p><h1>{nav.find(([key]) => key === view)?.[1]}</h1></div></section>
          <section className="panel empty-state"><BookPlus/><h3>{projectsLoading ? "正在加载作品" : projectsError ? "暂时无法读取作品" : "先新建或选择作品"}</h3><p>{projectsLoading ? "作品加载完成后会继续打开当前页面；你仍可以切换其他栏目。" : projectsError ? "请重试作品列表，作者库和系统设置仍可使用。" : "此栏目需要一部作品。可以先建立作者档案，再创建作品；侧栏其他栏目仍可正常使用。"}</p><div className="empty-workspace-actions">{projectsError ? <button className="secondary" onClick={() => void loadProjects()}>重新加载作品</button> : !projectsLoading && <><button className="primary" onClick={() => setNewBookOpen(true)}><BookPlus/>新建作品</button><button className="secondary" onClick={() => setView("authors")}><Sparkles/>前往作者库</button></>}</div></section>
        </> : <>
        {authorContext && <AuthorSpace
          authors={authors}
          projects={projects}
          busy={busy}
          run={run}
          refreshAuthors={loadAuthors}
          onOpenProject={(bookId) => { setSelectedId(bookId); navigate(`/books/${bookId}/overview`); }}
        />}
        {!authorContext && view === "overview" && <Overview
          projects={projects}
          selected={selected}
          onSelect={(bookId) => { setSelectedId(bookId); navigate(`/books/${bookId}/workflow`); }}
        />}
        {view === "planning" && <PlanningView project={selected} detail={detail} busy={busy} run={run} onRefresh={refreshAll}/>}
        {view === "workflow" && <WorkflowView project={selected} detail={detail} runId={latestRun?.id} busy={busy} run={run} onRefresh={refreshAll} onPlan={() => setView("planning")}/>}
        {view === "workspace" && <WorkspaceView key={selected?.id} project={selected} detail={detail} onRefresh={() => selectedId ? loadDetail(selectedId) : Promise.resolve()}/>}
        {view === "fanqie" && <FanqieView project={selected} detail={detail} session={fanqie} busy={busy} run={run} setSession={setFanqie} onRefresh={refreshAll}/>}
        {view === "book-settings" && <BookSettingsView project={selected} busy={busy} run={run}/>}
        {view === "settings" && <SystemSettingsView settings={settings} onSettings={setSettings} busy={busy} run={run}/>}
        </>}
      </div>
    </main>
    {newBookOpen && <NewBookModal
      busy={busy}
      run={run}
      onClose={() => setNewBookOpen(false)}
      onCreated={async (bookId) => { setNewBookOpen(false); await loadProjects(); setSelectedId(bookId); await loadDetail(bookId); navigate(`/books/${bookId}/planning`); }}
    />}
    {agentOpen && !authorContext && !systemContext && <WorkbenchAgentDrawer
      bookId={selectedId}
      onClose={() => setAgentOpen(false)}
      onRefresh={refreshAll}
      onPlanApplied={applyAgentHints}
    />}
  </div>;
}

const blankMaster = (): MasterOutline => ({
  version: 1, completion_mode: "open_ended", target_chapters: null, premise: "", core_conflict: "",
  ending_direction: "未锁定", major_beats: [], volumes: [], rolling_plan: {window_size: 5, planned_through: 0},
});

function WorkbenchAgentDrawer({ bookId, onClose, onRefresh, onPlanApplied }: {
  bookId: string;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  onPlanApplied: (plan: AgentPlanRecord | null) => void;
}) {
  const [message, setMessage] = useState("");
  const [job, setJob] = useState<AgentJob | null>(null);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [plan, setPlan] = useState<AgentPlanRecord | null>(null);
  const [execution, setExecution] = useState<AgentExecutionResult | null>(null);
  const [history, setHistory] = useState<PlanningConversationMessage[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const streamRef = useRef<HTMLDivElement | null>(null);

  const loadConversation = useCallback(async () => {
    if (!bookId) return;
    const value = await api<{messages: PlanningConversationMessage[]; activeJob: AgentJob | null}>(`/api/agent/conversation?bookId=${encodeURIComponent(bookId)}`);
    setHistory(value.messages);
    if (value.activeJob) setJob(value.activeJob);
  }, [bookId]);

  useEffect(() => {
    setJob(null); setEvents([]); setPlan(null); setExecution(null); setError(""); setHistory([]);
    void loadConversation();
  }, [bookId, loadConversation]);

  useEffect(() => {
    if (!job?.id) return;
    const source = new EventSource(`/api/jobs/${job.id}/events`);
    const handler = (event: MessageEvent) => setEvents((prior) => [...prior.slice(-499), JSON.parse(event.data) as JobEvent]);
    source.addEventListener("message", handler as EventListener);
    return () => source.close();
  }, [job?.id]);

  useEffect(() => {
    const node = streamRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [events]);

  useEffect(() => {
    if (!job?.id || !["queued", "running"].includes(job.status)) return;
    const timer = window.setInterval(() => {
      void api<{job: AgentJob; events: JobEvent[]; plan: AgentPlanRecord | null; execution: AgentExecutionResult | null}>(`/api/agent/jobs/${job.id}`)
        .then((value) => {
          setJob(value.job);
          setEvents(value.events);
          setPlan(value.plan);
          setExecution(value.execution);
          if (value.job.status === "succeeded") void loadConversation();
        })
        .catch(() => undefined);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [job?.id, job?.status]);

  const send = async () => {
    if (!message.trim()) return;
    setBusy("message"); setError(""); setEvents([]); setPlan(null); setExecution(null);
    try {
      const started = await post<AgentJob>("/api/agent/message", { bookId, message });
      setJob(started); setMessage(""); await loadConversation();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally { setBusy(""); }
  };

  const execute = async () => {
    if (!plan) return;
    setBusy("execute"); setError("");
    try {
      const value = await post<{plan: AgentPlanRecord; execution: AgentExecutionResult}>(`/api/agent/plans/${plan.jobId}/execute`, {});
      setPlan(value.plan); setExecution(value.execution); onPlanApplied(value.plan); await onRefresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally { setBusy(""); }
  };

  const reject = async () => {
    if (!plan) return;
    setBusy("reject"); setError("");
    try {
      const value = await post<{plan: AgentPlanRecord}>(`/api/agent/plans/${plan.jobId}/reject`, {});
      setPlan(value.plan); setExecution(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally { setBusy(""); }
  };

  const clearConversation = async () => {
    setBusy("clear"); setError("");
    try { await del(`/api/agent/conversation?bookId=${encodeURIComponent(bookId)}`); setHistory([]); setJob(null); setPlan(null); setExecution(null); setEvents([]); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(""); }
  };

  const artifact = plan?.artifact as {summary?: string; reasoning?: string[]; actions?: Array<Record<string, any>>; warnings?: string[]} | undefined;
  const actions = artifact?.actions || [];
  const preferenceAction = actions.find((action) => action.type === "update_author_preference");

  return <div className="agent-drawer-backdrop" role="dialog" aria-modal="true">
    <section className="agent-drawer">
      <header className="agent-drawer-head">
        <div>
          <span>WORKBENCH AI</span>
          <strong>工作台 AI · 计划后执行</strong>
        </div>
        <button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18}/></button>
      </header>

      <div className="agent-drawer-body">
        <div className="workbench-history">
          <div><strong>本书持续共创记录</strong><button className="secondary small" disabled={busy === "clear" || Boolean(job && ["queued", "running"].includes(job.status))} onClick={() => void clearConversation()}><Trash2/>新开话题</button></div>
          {history.length ? history.map((item) => <article key={item.id} className={item.role}><b>{item.role === "user" ? "你" : "工作台 AI"}</b><p>{item.text}</p>{item.warnings.length > 0 && <small>{item.warnings.join("；")}</small>}</article>) : <p>还没有对话。后续要求会承接这里已经确认的目标、限制和返工方向。</p>}
        </div>
        <label className="agent-compose">
          <span>告诉我你想怎么处理当前作品</span>
          <textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            maxLength={4000}
            placeholder="例如：第一章人物声音太像，帮我整理返工计划；把“对白不要连续超过三轮”沉淀为作者规则。"
          />
          <div>
            <small>讨论 → 候选计划 → 你确认 → 安全执行；同一本书的前后要求会持续承接。</small>
            <button className="primary" disabled={busy === "message" || !message.trim()} onClick={send}>
              {busy === "message" ? <LoaderCircle className="spin"/> : <Send/>}生成计划
            </button>
          </div>
        </label>

        {error && <div className="agent-error"><CircleAlert/>{error}</div>}

        <div className="agent-stream" ref={streamRef}>
          {!events.length && <div className="agent-empty"><Bot/>这里会显示 Antigravity 的公开过程流、工具事件和用量，不显示隐藏思考原文。</div>}
          {events.map((event) => <article key={event.id} className={`event-${event.kind || event.level}`}>
            <b>{statusLabel(event.kind || event.level)}</b>
            <p>{event.message}</p>
          </article>)}
          {job?.error && <article className="event-error"><b>失败</b><p>{job.error}</p></article>}
        </div>

        {plan && <div className="agent-plan">
          <div className="agent-plan-head">
            <div>
              <span>计划摘要</span>
              <strong>{String(artifact?.summary || plan.summary)}</strong>
            </div>
            <StatusPill value={plan.status === "pending" ? "queued" : plan.status === "executed" ? "succeeded" : plan.status === "failed" ? "failed" : plan.status}/>
          </div>

          {Boolean(artifact?.reasoning?.length) && <div className="agent-reasoning">
            <span>公开判断依据</span>
            <ul>{artifact?.reasoning?.map((item, index) => <li key={index}>{item}</li>)}</ul>
          </div>}

          <div className="agent-actions">
            {actions.map((action, index) => <article key={index}>
              <div><span>动作 {index + 1}</span><b>{agentActionLabel(action)}</b></div>
              <p>{agentActionDetail(action)}</p>
              {action.type === "update_author_preference" && <small>会修改作者偏好库；确认执行后仍可在偏好设置中停用。</small>}
              {action.autoRun === true && <small>将启动 Antigravity 自动生成任务。</small>}
            </article>)}
          </div>

          {Boolean(artifact?.warnings?.length) && <div className="agent-warnings"><CircleAlert/>{artifact?.warnings?.join("；")}</div>}

          <div className="agent-plan-foot">
            {plan.status === "pending" ? <>
              <button className="primary" disabled={busy === "execute"} onClick={execute}>{busy === "execute" ? <LoaderCircle className="spin"/> : <Check/>}确认执行</button>
              <button className="secondary" disabled={busy === "reject"} onClick={reject}><X/>拒绝计划</button>
            </> : <button className="secondary" onClick={onClose}>完成</button>}
          </div>

          {execution && <div className="agent-execution">
            <span>执行结果</span>
            {execution.actions.map((action, index) => <article key={index}>
              <StatusPill value={action.status === "succeeded" ? "succeeded" : action.status === "failed" ? "failed" : "idle"}/>
              <p><b>{agentActionLabel({type: action.type})}</b>{action.detail}</p>
            </article>)}
          </div>}
        </div>}
      </div>
    </section>
  </div>;
}

function agentActionLabel(action: Record<string, any>): string {
  return ({
    run_workflow: "启动严格工作流",
    rework_chapter: "发起章节返工",
    run_next_stage: "继续下一阶段",
    retry_job: "幂等重试任务",
    create_revision_brief: "生成返工方案",
    update_author_preference: "沉淀作者偏好",
    switch_view: "切换界面视图",
    select_project: "切换作品",
  } as Record<string, string>)[String(action.type)] || String(action.type);
}

function agentActionDetail(action: Record<string, any>): string {
  if (action.type === "run_workflow") return `作品 ${action.bookId} · 章节 ${Array.isArray(action.chapters) ? action.chapters.join("、") : "—"}${action.autoRun ? " · 自动启动生成" : " · 仅创建流程"}`;
  if (action.type === "rework_chapter") return `第 ${action.chapter} 章 · ${action.feedback}`;
  if (action.type === "run_next_stage") return `工作流 ${action.runId}`;
  if (action.type === "retry_job") return `任务 ${action.jobId}`;
  if (action.type === "create_revision_brief") return `第 ${action.chapter} 章 · ${action.feedback}`;
  if (action.type === "update_author_preference") return `${action.category} · ${action.rule}`;
  if (action.type === "switch_view") return `切换到 ${action.view}`;
  if (action.type === "select_project") return `切换作品 ${action.bookId}`;
  return "未知动作";
}

type PlanningScope = "new_book" | "book" | "volume" | "chapter" | "chapters";
type PlanningConstraintChange = {
  operation: "add" | "update" | "remove";
  constraint_id: string;
  scope_type: "book" | "volume" | "chapter";
  scope_id: string;
  category: string;
  rule: string;
  priority: "must" | "should" | "avoid";
  reason: string;
};
type PlanningConstraintDelta = {base_contract_hash: string; changes: PlanningConstraintChange[]};
type PlanningArtifact = {
  proposal?: Record<string, any>;
  constraint_delta?: PlanningConstraintDelta;
  reader_world_contract?: Record<string, any>;
  rationale?: string[];
  warnings?: string[];
  planningContextHashes?: Record<string, unknown>;
  planningContextSnapshot?: Record<string, unknown> | null;
  planningScope?: PlanningScope;
  planningMode?: "fill" | "rewrite";
};
type PlanningContractUpdate = PlanningConstraintDelta & {source_job_id: string; source_job_ids: string[]; source_scope: PlanningScope; rationale: string[]; warnings: string[]; applied_fields: string[]; planning_context_hashes?: Record<string, unknown>; planning_context_snapshot?: Record<string, unknown> | null; planning_selection?: Record<string, unknown>; planning_mode?: "fill" | "rewrite"};
type PlanningDraft = {path: string; hash: string};
type PlanningMessage = {role: "user" | "assistant"; text: string; proposal?: Record<string, any>; warnings?: string[]; id?: string; jobId?: string; createdAt?: string};

function planningStableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(planningStableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !["updated_at", "created_at", "applied_at", "generated_at"].includes(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, planningStableValue(item)]));
  }
  return value;
}

function planningStableJson(value: unknown): string {
  return JSON.stringify(planningStableValue(value));
}

function planningBookSnapshot(value: unknown): Record<string, unknown> {
  const raw = value && !Array.isArray(value) && typeof value === "object" ? value as Record<string, unknown> : {};
  const metadata = raw.metadata && !Array.isArray(raw.metadata) && typeof raw.metadata === "object" ? raw.metadata as Record<string, unknown> : {};
  const completionMode = raw.completionMode ?? raw.completion_mode ?? metadata.completion_mode ?? "open_ended";
  const target = raw.targetChapters ?? raw.target_chapters ?? metadata.target_chapters ?? null;
  return {
    title: String(raw.title ?? ""), author: String(raw.author ?? metadata.author ?? ""),
    synopsis: String(raw.synopsis ?? metadata.synopsis ?? ""), genre: String(raw.genre ?? metadata.genre ?? ""),
    completion_mode: String(completionMode || "open_ended"),
    target_chapters: target === null || target === undefined || target === "" ? null : Number(target),
  };
}

function planningMasterSnapshot(value: unknown, fallbackPremise = ""): Record<string, unknown> {
  const raw = value && !Array.isArray(value) && typeof value === "object" ? value as Record<string, unknown> : {};
  const rolling = raw.rolling_plan && !Array.isArray(raw.rolling_plan) && typeof raw.rolling_plan === "object" ? raw.rolling_plan as Record<string, unknown> : {};
  const volumes = Array.isArray(raw.volumes) ? raw.volumes.map((item, index) => {
    const volume = item && !Array.isArray(item) && typeof item === "object" ? item as Record<string, unknown> : {};
    return {
      volume_id: String(volume.volume_id || `volume-${index + 1}`), title: String(volume.title || ""), objective: String(volume.objective || ""),
      main_conflict: String(volume.main_conflict || ""), character_change: String(volume.character_change || ""),
      foreshadowing: String(volume.foreshadowing || ""), ending: String(volume.ending || ""),
    };
  }) : [];
  return {
    version: Number(raw.version || 1), completion_mode: String(raw.completion_mode || "open_ended"),
    target_chapters: raw.target_chapters === null || raw.target_chapters === undefined || raw.target_chapters === "" ? null : Number(raw.target_chapters),
    premise: String(raw.premise || fallbackPremise || ""), core_conflict: String(raw.core_conflict || ""), ending_direction: String(raw.ending_direction || ""),
    major_beats: Array.isArray(raw.major_beats) ? raw.major_beats.map(String) : [], volumes,
    rolling_plan: {window_size: Number(rolling.window_size || 5), planned_through: Number(rolling.planned_through || 0)},
  };
}

function planningChapterSnapshot(value: unknown): Record<string, unknown> {
  const raw = value && !Array.isArray(value) && typeof value === "object" ? value as Record<string, unknown> : {};
  const contract = raw.contract && !Array.isArray(raw.contract) && typeof raw.contract === "object" ? raw.contract as Record<string, unknown> : raw;
  const result = {...contract};
  delete result.book_id; delete result.updated_at; delete result.created_at;
  if (result.chapter_number !== undefined) result.chapter_number = Number(result.chapter_number);
  if (result.target_word_count !== undefined) result.target_word_count = Number(result.target_word_count);
  if (Array.isArray(result.problem_tags)) result.problem_tags = result.problem_tags.map(String);
  return result;
}

function planningSnapshotForUi(scope: PlanningScope, mode: "fill" | "rewrite", context: Record<string, unknown>): Record<string, unknown> {
  const book = planningBookSnapshot(context.book ?? context.form);
  const selected = context.selected && !Array.isArray(context.selected) && typeof context.selected === "object" ? context.selected as Record<string, unknown> : {};
  const selectedNumbers = Array.isArray(context.selectedChapterNumbers)
    ? [...new Set(context.selectedChapterNumbers.map(Number).filter((item) => Number.isInteger(item) && item > 0))].sort((left, right) => left - right)
    : [];
  const selectedIds = scope === "new_book" || scope === "book"
    ? {level: scope, id: scope === "book" ? "book" : "new-book"}
    : scope === "volume"
      ? {level: scope, id: String(selected.volume_id || context.volumeId || "current")}
      : scope === "chapter"
        ? {level: scope, id: String(selected.chapter_number || context.chapterNumber || "current"), volume_id: String(selected.volume_id || "")}
        : {level: scope, ids: selectedNumbers};
  const boundaries = context.boundaries && !Array.isArray(context.boundaries) && typeof context.boundaries === "object" ? context.boundaries as Record<string, unknown> : {};
  const normalizeBoundary = (value: unknown) => value ? planningChapterSnapshot(value) : null;
  return {
    schema_version: "planning-editor-snapshot-v1", scope, mode,
    state: {
      book,
      master: planningMasterSnapshot(context.master ?? context.outline, String(book.synopsis || "")),
      chapters: (Array.isArray(context.chapters ?? context.initialChapters) ? (context.chapters ?? context.initialChapters) as unknown[] : []).map(planningChapterSnapshot).sort((left, right) => Number(left.chapter_number || 0) - Number(right.chapter_number || 0)),
    },
    selected_ids: selectedIds, selected_chapter_numbers: selectedNumbers,
    boundaries: {previous: normalizeBoundary(boundaries.previous), next: normalizeBoundary(boundaries.next)},
    clear_selected_outline: context.clearSelectedOutline === true,
  };
}

function planningConversationScopeId(scope: PlanningScope, context: Record<string, unknown>): string {
  const selected = context.selected && !Array.isArray(context.selected) && typeof context.selected === "object" ? context.selected as Record<string, unknown> : {};
  const chapters = Array.isArray(context.selectedChapterNumbers) ? context.selectedChapterNumbers.map(Number).filter(Number.isInteger).sort((a, b) => a - b) : [];
  if (scope === "new_book") return `draft-${String(context.planningConversationId || "current")}-${String(context.authorProfileVersionId || "unbound")}`;
  if (scope === "book") return "book";
  if (scope === "volume") return String(selected.volume_id || context.volumeId || "current");
  if (scope === "chapter") return String(selected.chapter_number || context.chapterNumber || "current");
  return `chapters-${chapters.join("-") || "current"}`;
}

const planningFieldLabels: Record<string, string> = {
  title: "标题", genre: "题材", synopsis: "简介", premise: "故事核心", core_conflict: "主冲突", ending_direction: "结局方向",
  major_beats: "关键节点", volumes: "分卷方案", volume_id: "所属卷", objective: "目标", main_conflict: "本卷冲突",
  character_change: "人物变化", foreshadowing: "伏笔动作", ending: "卷末落点", chapter_number: "章节", obstacle: "阻碍",
  change: "本章变化", new_information: "新增信息", chapter_hook: "章末钩子", next_first_beat: "下一章第一拍",
  current_character_goal: "人物目标", relationship_state: "关系状态", body_information_state: "身体/信息状态",
  unresolved_foreshadowing: "未解决伏笔", ending_type: "结尾类型", target_word_count: "目标字数", problem_tags: "关注点",
  chapters: "批量章纲",
  initial_chapters: "初始章纲", constraints: "全书约束契约", completion_mode: "连载方式", target_chapters: "目标章数", rolling_window: "滚动窗口",
};

function ReaderWorldContractPreview({contract}: {contract: Record<string, any>}) {
  const fields: Array<[keyof typeof contract, string]> = [
    ["reader_promise", "读者承诺"],
    ["emotional_payoff", "情绪兑付"],
    ["world_mechanics", "世界机制"],
    ["world_exceptions", "例外与权限"],
    ["author_world_integration", "作者世界观方法"],
    ["character_integration", "角色驱动"],
    ["conflicts_and_tradeoffs", "冲突与取舍"],
  ];
  return <div className="reader-world-contract-preview"><strong>读者与世界观契约</strong>{fields.map(([field, label]) => String(contract[field] || "").trim() ? <div key={String(field)}><span>{label}</span><p>{String(contract[field])}</p></div> : null)}</div>;
}

function ProposalPreview({proposal}: {proposal: Record<string, any>}) {
  return <div className="proposal-preview">{Object.entries(proposal).map(([key, value]) => {
    const rendered = key === "volumes" && Array.isArray(value)
      ? value.map((item: any) => `${item.title}：${item.objective}`).join("\n")
      : key === "chapters" && Array.isArray(value)
      ? value.map((item: any) => `第 ${item.chapter_number} 章 · ${item.title}\n目标：${item.objective}\n变化：${item.change}\n章末：${item.chapter_hook}`).join("\n\n")
      : Array.isArray(value) ? value.join("\n") : value && typeof value === "object" ? JSON.stringify(value, null, 2) : String(value ?? "");
    return <div key={key}><span>{planningFieldLabels[key] || key}</span><p>{rendered}</p></div>;
  })}</div>;
}

function ConstraintDeltaPreview({delta, compact = false, phase = "pending"}: {delta: PlanningConstraintDelta; compact?: boolean; phase?: "candidate" | "pending"}) {
  const changes = Array.isArray(delta.changes) ? delta.changes : [];
  const operationLabel = {add: "新增", update: "替换", remove: "删除"} as const;
  return <div className={compact ? "constraint-delta-preview compact" : "constraint-delta-preview"}>
    <header><div><ShieldCheck/><strong>{phase === "candidate" ? "候选约束差异（未生效）" : "待保存的本地约束"}</strong></div><span>{changes.length ? `${changes.length} 项变更` : "无长期约束变化"}</span></header>
    {changes.map((change, index) => <article className={`constraint-change ${change.operation}`} key={`${change.constraint_id || "new"}-${index}`}>
      <b>{operationLabel[change.operation]}</b><span>{change.scope_type}/{change.scope_id} · {change.category}</span><p>{change.rule || "删除当前规则"}</p><small>{change.reason}{change.constraint_id ? ` · ${change.constraint_id}` : " · 稳定编号将在保存时生成"}</small>
    </article>)}
    {!compact && <footer>{phase === "candidate"
      ? <>当前只保存在 <code>.tomota-studio</code> 运行缓存中，作品正式约束尚未写入。先“应用到表单（不保存）”，再点击页面顶部“保存三级大纲并写入约束”才会原子更新。</>
      : <>基线 {delta.base_contract_hash ? delta.base_contract_hash.slice(0, 12) : "尚无本地约束文件"}；当前只在待保存区，点击“保存三级大纲并写入约束”后才原子更新正式快照。</>}</footer>}
  </div>;
}

function PlanningAssistant({scope, context, onApply, onClose, embedded = false}: {scope: PlanningScope; context: Record<string, unknown>; onApply: (proposal: Record<string, any>, artifact: PlanningArtifact & {jobId: string; planningDraft?: PlanningDraft}) => void; onClose: () => void; embedded?: boolean}) {
  const selectedCount = Array.isArray(context.selectedChapterNumbers) ? context.selectedChapterNumbers.length : 0;
  const scopeName = {new_book: "新书创意", book: "全书总纲", volume: "当前卷纲", chapter: "当前章纲", chapters: `已选 ${selectedCount} 章`}[scope];
  const quick = scope === "new_book" ? ["根据我的创意做一套可连载的新书方案", "先问我三个关键问题再规划"] : scope === "book" ? ["补全当前总纲的空白", "强化主冲突与长线悬念", "先检查现有总纲，再问我需要确认的问题"] : scope === "volume" ? ["补全本卷目标、冲突和卷末落点", "检查本卷与全书主线是否脱节"] : scope === "chapters" ? ["整体重排已选章节的因果、状态传递与章末承接", "保留核心事实，重新分配冲突、揭示和伏笔兑现"] : ["生成可直接执行的章纲", "强化本章选择、后果与章末钩子"];
  const greeting = `我是 ${scopeName} 共创助手。你可以直接说想保留什么、改变什么，我会先给候选方案，不会自动覆盖。`;
  const conversationScopeId = planningConversationScopeId(scope, context);
  const conversationBookId = scope === "new_book" ? "new-book" : String(context.bookId || "");
  const [messages, setMessages] = useState<PlanningMessage[]>([{role: "assistant", text: greeting}]);
  const [input, setInput] = useState(quick[0]);
  const [mode, setMode] = useState<"fill" | "rewrite">(scope === "chapters" ? "rewrite" : "fill");
  const [job, setJob] = useState<AgentJob | null>(null);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [error, setError] = useState("");
  const [latestArtifact, setLatestArtifact] = useState<(PlanningArtifact & {jobId: string; planningDraft?: PlanningDraft}) | null>(null);
  const [conversationPolicy, setConversationPolicy] = useState<"continue" | "user_requirements_only" | "fresh_start">(mode === "fill" ? "continue" : "user_requirements_only");
  const [conversationLoading, setConversationLoading] = useState(true);
  const resolved = useRef("");

  useEffect(() => {
    let disposed = false;
    setConversationLoading(true); setMessages([{role: "assistant", text: greeting}]); setJob(null); setLatestArtifact(null); setError(""); resolved.current = "";
    const path = `/api/planning/conversation?bookId=${encodeURIComponent(conversationBookId)}&scope=${encodeURIComponent(scope)}&scopeId=${encodeURIComponent(conversationScopeId)}`;
    void api<{messages: PlanningConversationMessage[]; activeJob: AgentJob | null}>(path).then(async (result) => {
      if (disposed) return;
      const restored: PlanningMessage[] = result.messages.map((item) => ({
        id: item.id, role: item.role, text: item.text, proposal: item.proposal || undefined, warnings: item.warnings, jobId: item.jobId, createdAt: item.createdAt,
      }));
      setMessages(restored.length ? restored : [{role: "assistant", text: greeting}]);
      if (result.activeJob) setJob(result.activeJob);
      const latestProposal = [...result.messages].reverse().find((item) => item.role === "assistant" && item.proposal && item.jobId);
      if (latestProposal?.jobId) {
        const restoredResult = await api<{job: AgentJob; artifact: PlanningArtifact | null; planningDraft?: PlanningDraft | null; planningContextHashes?: Record<string, unknown>; planningContextSnapshot?: Record<string, unknown> | null; planningScope?: string; planningMode?: "fill" | "rewrite"}>(`/api/planning/jobs/${latestProposal.jobId}`).catch(() => null);
        if (!disposed && restoredResult?.artifact?.proposal) {
          resolved.current = latestProposal.jobId;
          setLatestArtifact({...restoredResult.artifact, jobId: restoredResult.job.id, planningDraft: restoredResult.planningDraft || undefined, planningContextHashes: restoredResult.planningContextHashes, planningContextSnapshot: restoredResult.planningContextSnapshot, planningScope: (restoredResult.planningScope as PlanningScope | undefined) || scope, planningMode: restoredResult.planningMode || mode});
        }
      }
    }).catch((reason) => { if (!disposed) setError(reason instanceof Error ? reason.message : String(reason)); }).finally(() => { if (!disposed) setConversationLoading(false); });
    return () => { disposed = true; };
  }, [conversationBookId, conversationScopeId, scope]);

  const sendPrompt = async () => {
    const text = input.trim();
    if (!text || job && ["queued", "running"].includes(job.status)) return;
    const nextMessages = [...messages, {role: "user", text} as PlanningMessage];
    setMessages(nextMessages); setInput(""); setError(""); setEvents([]);
    try {
      const result = await post<{job: AgentJob; conversationPolicy?: {mode?: "continue" | "user_requirements_only" | "fresh_start"}}>("/api/planning/generate", {
        bookId: scope === "new_book" ? undefined : String(context.bookId || ""), scope, mode, instruction: text, conversationScopeId,
        context: {...context},
      });
      const appliedPolicy = result.conversationPolicy?.mode || (mode === "fill" ? "continue" : "user_requirements_only");
      setConversationPolicy(appliedPolicy);
      if (appliedPolicy === "fresh_start") setMessages([{role: "user", text}]);
      setJob(result.job);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  useEffect(() => {
    if (!job) return;
    let disposed = false;
    const load = async () => {
      try {
        const result = await api<{job: AgentJob; events: JobEvent[]; artifact: PlanningArtifact | null; planningDraft?: PlanningDraft | null; planningContextHashes?: Record<string, unknown>; planningContextSnapshot?: Record<string, unknown> | null; planningScope?: string; planningMode?: "fill" | "rewrite"}>(`/api/planning/jobs/${job.id}`);
        if (disposed) return;
        setJob(result.job); setEvents(result.events || []);
        if (result.job.status === "succeeded" && result.artifact?.proposal && resolved.current !== result.job.id) {
          resolved.current = result.job.id;
          setLatestArtifact({...result.artifact, jobId: result.job.id, planningDraft: result.planningDraft || undefined, planningContextHashes: result.planningContextHashes, planningContextSnapshot: result.planningContextSnapshot, planningScope: (result.planningScope as PlanningScope | undefined) || scope, planningMode: result.planningMode || mode});
          const rationale = Array.isArray(result.artifact.rationale) ? result.artifact.rationale.join("\n") : "候选规划已生成。";
          setMessages((prior) => [...prior, {role: "assistant", text: rationale, proposal: result.artifact!.proposal, warnings: result.artifact?.warnings || []}]);
        } else if (["failed", "auth_required", "cancelled", "interrupted"].includes(result.job.status) && resolved.current !== result.job.id) {
          resolved.current = result.job.id;
          setError(result.job.error || `任务状态：${statusLabel(result.job.status)}`);
        }
      } catch (reason) { if (!disposed) setError(reason instanceof Error ? reason.message : String(reason)); }
    };
    const stop = ["queued", "running"].includes(job.status) ? startPolling(load, 1200, {immediate: true}) : undefined;
    if (!stop) void load();
    return () => { disposed = true; stop?.(); };
  }, [job?.id, job?.status]);

  const latest = [...messages].reverse().find((item) => item.proposal)?.proposal;
  const latestContract = latestArtifact?.reader_world_contract;
  const active = Boolean(job && ["queued", "running"].includes(job.status));
  const deepPlanningLocked = scope === "new_book" || scope === "book";
  const authorBindingReady = scope === "new_book" ? Boolean(context.authorProfileVersionId) : Boolean(context.foundationContract);
  return <div id={embedded ? "book-planning-dialogue" : undefined} className={embedded ? "planning-dialogue-room" : "assistant-backdrop"} role="dialog" aria-modal={embedded ? undefined : "true"} aria-label={`${scopeName} AI 共创`}><aside className="planning-assistant">
    <div className="assistant-head"><div><p className="eyebrow">ANTIGRAVITY CO-CREATION</p><h2>{embedded ? "书籍大纲对话室" : `${scopeName} AI 共创`}</h2><span>对话与候选按作品和范围保存到 <code>.tomota-studio</code> 运行缓存，刷新后可继续；正式项目文件不会在你应用并保存前写入。</span></div><div className="assistant-head-actions">{messages.some((item) => item.id) && <button className="secondary small" disabled={active} onClick={() => { if (!window.confirm("永久清空当前范围内未保存的对话、候选、盲审、自动修复、Prompt、JSON 产物、上下文、对账与交接缓存？已经正式保存的大纲、Canon、正文和作品文件不会删除。")) return; void del(`/api/planning/conversation?bookId=${encodeURIComponent(conversationBookId)}&scope=${encodeURIComponent(scope)}&scopeId=${encodeURIComponent(conversationScopeId)}`).then(() => { setMessages([{role: "assistant", text: greeting}]); setLatestArtifact(null); setJob(null); resolved.current = ""; }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason))); }}>清空本轮并新开</button>}{!embedded && <button className="icon-button" onClick={onClose} aria-label="关闭 AI 共创"><X/></button>}</div></div>
    <div className="assistant-quick">{quick.map((item) => <button key={item} onClick={() => setInput(item)}>{item}</button>)}</div>
    <div className="planning-binding-summary"><span>{scopeName}</span><span>{authorBindingReady ? "作者契约已锁定" : "作者契约缺失"}</span><span>{scope === "new_book" ? "新书输入已锁定" : "Canon 已锁定"}</span><span>{deepPlanningLocked ? "深度契约将生成" : "继承上级契约"}</span></div>
    <div className="assistant-messages">{conversationLoading && <p className="assistant-restore"><LoaderCircle className="spin"/>正在恢复当前范围的共创记录…</p>}{messages.map((message, index) => <article className={message.role} key={message.id || index}><b>{message.role === "user" ? "你" : "Antigravity"}</b>{message.createdAt && <time>{fmtDate(message.createdAt)}</time>}<p>{message.text}</p>{message.proposal && <ProposalPreview proposal={message.proposal}/>} {message.warnings?.length ? <small>待决定：{message.warnings.join("；")}</small> : null}</article>)}
      {active && <article className="assistant thinking"><b>Antigravity</b><p><LoaderCircle className="spin"/>正在分析当前层级与对话，已运行事件 {events.length} 条…</p><small>{events.at(-1)?.message || "任务已排队"}</small></article>}
      {error && <div className="assistant-error"><CircleAlert/>{error}</div>}
      {job?.stage === "candidate_blind_review" && job.status === "succeeded" && <div className="assistant-candidate-choice"><ShieldCheck/><span>双候选已由独立盲审自动仲裁；应用前仍可预览最终方案。</span></div>}
      {scope !== "new_book" && latestArtifact?.constraint_delta && <details className="constraint-delta-disclosure">
        <summary><span><ShieldCheck/><b>候选约束差异</b><small>仅运行缓存 · 正式约束未写入</small></span><span>{latestArtifact.constraint_delta.changes?.length || 0} 项 · 展开查看 <ChevronRight/></span></summary>
        <ConstraintDeltaPreview delta={latestArtifact.constraint_delta} phase="candidate"/>
      </details>}
      {latestContract && <ReaderWorldContractPreview contract={latestContract}/>}
    </div>
    <div className="assistant-compose"><div><select value={mode} onChange={(event) => { const nextMode = event.target.value as "fill" | "rewrite"; setMode(nextMode); setConversationPolicy(nextMode === "fill" ? "continue" : "user_requirements_only"); }}><option value="fill">补全当前方案</option><option value="rewrite">重做当前层（隔离旧 AI 候选）</option></select>{active && <button className="secondary small" onClick={() => void post(`/api/jobs/${job!.id}/cancel`).then(() => setJob({...job!, status: "cancelled"}))}><Square/>停止</button>}</div><div className="planning-context-policy"><ShieldCheck/><span>{conversationPolicy === "fresh_start" ? "已断开旧上下文：本轮只使用当前要求与正式保存事实" : conversationPolicy === "user_requirements_only" ? "重做模式：保留你的要求，但旧 AI 候选不会进入生成" : "补全模式：可承接当前候选；未保存内容仍不是正式约束"}</span></div><textarea value={input} onChange={(event) => setInput(event.target.value)} placeholder="继续提出要求，例如：不要锁定结局，把人物矛盾提前……"/><div><span>发送只写运行缓存；“应用”只填充表单，正式写入仍需点击页面顶部保存。</span><button className="primary" disabled={active || !authorBindingReady || !input.trim()} onClick={() => void sendPrompt()}><Send/>发送给 AI</button></div></div>
    <div className="assistant-foot">{!embedded && <button className="secondary" onClick={onClose}>稍后再说</button>}{!latestContract && latestArtifact && <small>缺少通过校验的读者与世界观契约，不能应用</small>}<button className="primary" disabled={!latest || !latestArtifact || active || !latestContract} onClick={() => { if (latest && latestArtifact) onApply(latest, latestArtifact); }}><Sparkles/>应用到表单（不保存）</button></div>
  </aside></div>;
}

function newBookAuthorContractSnapshot(version: AuthorVersion | null): Record<string, unknown> {
  if (!version) return {};
  const profile = version.profile;
  return {
    schema_version: "author-planning-contract-v1", author_version_id: version.id, author_id: version.author_id,
    version_number: version.version_number, profile_hash: version.profile_hash,
    story_design: profile.story_design || {}, book_architecture: profile.book_architecture || {},
    design_blueprint: profile.application_blueprint ? {
      book_design: profile.application_blueprint.book_design || [], volume_design: profile.application_blueprint.volume_design || [],
      chapter_design: profile.application_blueprint.chapter_design || [],
    } : {},
  };
}

function NewBookModal({busy, run, onClose, onCreated}: {busy: string; run: (key: string, task: () => Promise<void>) => void; onClose: () => void; onCreated: (bookId: string) => Promise<void>}) {
  const [planningConversationId] = useState(() => {
    const key = "tomota:new-book-planning-session";
    const current = window.localStorage.getItem(key);
    if (current && /^[A-Za-z0-9_-]{8,80}$/.test(current)) return current;
    const created = crypto.randomUUID().replaceAll("-", "");
    window.localStorage.setItem(key, created);
    return created;
  });
  const [form, setForm] = useState({title: "", author: "", authorProfileVersionId: "", genre: "", synopsis: "", completionMode: "open_ended", targetChapters: ""});
  const [authors, setAuthors] = useState<AuthorProfile[]>([]);
  const [outline, setOutline] = useState<MasterOutline>(blankMaster());
  const [initialChapters, setInitialChapters] = useState<Array<Record<string, any>>>([]);
  const [planningContract, setPlanningContract] = useState<Record<string, unknown> | null>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  useEffect(() => {
    void api<{authors: AuthorProfile[]}>("/api/authors").then(async (value) => {
      const detailed = await Promise.all(value.authors.filter((item) => item.status === "active").map((item) => api<{author: AuthorProfile}>(`/api/authors/${item.id}`).then((result) => result.author)));
      setAuthors(detailed);
      const first = detailed.flatMap((item) => (item.versions || []).filter((version) => version.status === "published"))[0];
      if (first) setForm((prior) => prior.authorProfileVersionId ? prior : {...prior, authorProfileVersionId: first.id});
    });
  }, []);
  const publishedVersions = authors.flatMap((author) => (author.versions || []).filter((version) => version.status === "published").map((version) => ({author, version})));
  const selectedAuthorVersion = publishedVersions.find((item) => item.version.id === form.authorProfileVersionId)?.version || null;
  const create = () => run("new-book", async () => {
    if (!form.title.trim()) throw new Error("请填写作品标题，或先用 AI 共创生成候选");
    if (!form.authorProfileVersionId) throw new Error("请先在“作者与文风”创建并发布作者版本，然后为新书选择该版本");
    const master = {...outline};
    master.completion_mode = form.completionMode as "open_ended" | "fixed";
    master.target_chapters = form.completionMode === "fixed" ? Number(form.targetChapters) || null : null;
    master.premise = master.premise || form.synopsis.trim();
    const created = await post<{book: {id: string}}>("/api/projects", {
      title: form.title.trim(),
      authorProfileVersionId: form.authorProfileVersionId,
      source_job_id: String(planningContract?.source_job_id || ""),
      metadata: {author: form.author.trim(), synopsis: form.synopsis.trim(), genre: form.genre.trim(), completion_mode: form.completionMode, target_chapters: master.target_chapters},
      outline: master, chapters: initialChapters, planning_contract: planningContract,
    });
    window.localStorage.removeItem("tomota:new-book-planning-session");
    await onCreated(created.book.id);
  });
  return <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="新建作品"><div className="book-modal">
    <div className="modal-head"><div><p className="eyebrow">NEW SERIAL</p><h2>新建作品</h2><span>可以直接描述创意并与 AI 共创；内部编号由系统自动生成。</span></div><div className="modal-head-actions"><button className="secondary" onClick={() => setAssistantOpen(true)}><MessageSquare/>AI 共创新书</button><button className="icon-button" onClick={onClose} aria-label="关闭"><X/></button></div></div>
    <div className="book-form">
      <label><span>作品标题</span><input value={form.title} onChange={(event) => setForm({...form, title: event.target.value})} placeholder="读者看到的书名"/></label>
      <label><span>发布署名</span><input value={form.author} onChange={(event) => setForm({...form, author: event.target.value})} placeholder="番茄页面显示的署名，与内部作者档案分离"/></label>
      <label><span>作者版本（必选）</span><select value={form.authorProfileVersionId} onChange={(event) => { setForm({...form, authorProfileVersionId: event.target.value}); setPlanningContract(null); }}><option value="">请选择已发布版本</option>{publishedVersions.map(({author, version}) => <option value={version.id} key={version.id}>{author.name} · v{version.version_number}</option>)}</select><small>绑定后形成快照；作者的故事设计契约会从新书共创起生效，换作者后需重新生成规划候选。</small></label>
      <label><span>题材/标签</span><input value={form.genre} onChange={(event) => setForm({...form, genre: event.target.value})} placeholder="奇幻 / 悬疑 / 轻小说"/></label>
      <label className="wide-field"><span>初始创意或简介</span><textarea value={form.synopsis} onChange={(event) => setForm({...form, synopsis: event.target.value})} placeholder="写核心钩子即可，后续可继续修改"/></label>
      <label><span>连载方式</span><select value={form.completionMode} onChange={(event) => setForm({...form, completionMode: event.target.value})}><option value="open_ended">开放式连载（推荐）</option><option value="fixed">预设目标章数</option></select><small>开放式只规划滚动窗口，不把已规划章数当作完结章数</small></label>
      {form.completionMode === "fixed" && <label><span>目标章数</span><input type="number" min="1" value={form.targetChapters} onChange={(event) => setForm({...form, targetChapters: event.target.value})}/></label>}
    </div>
    {planningContract && <div className="planning-contract-ready"><ShieldCheck/><div><strong>本地全书规划契约已生成</strong><span>候选文件：{String(planningContract.source_draft_path || "本地规划任务产物")} · 校验 {String(planningContract.source_draft_hash || "").slice(0, 12)}。创建时将固化为 outlines/foundation-contract.json，并进入严格工作流输入哈希；已覆盖建书资料、总纲、分卷与 {initialChapters.length} 章初始章纲。</span></div></div>}
    <div className="modal-foot"><p><ShieldCheck/>创建后进入“全书与分卷”，再建立卷纲和章节章纲。</p><button className="primary" disabled={busy === "new-book"} onClick={create}>{busy === "new-book" ? <LoaderCircle className="spin"/> : <BookPlus/>}创建并进入规划</button></div>
    {assistantOpen && <PlanningAssistant scope="new_book" context={{form, outline, planningConversationId, authorProfileVersionId: form.authorProfileVersionId}} onClose={() => setAssistantOpen(false)} onApply={(proposal, artifact) => {
      const completionMode = ["open_ended", "fixed"].includes(String(proposal.completion_mode)) ? String(proposal.completion_mode) : "open_ended";
      setForm((prior) => ({...prior, title: String(proposal.title || prior.title), genre: String(proposal.genre || prior.genre), synopsis: String(proposal.synopsis || prior.synopsis), completionMode, targetChapters: completionMode === "fixed" ? String(Number(proposal.target_chapters) || "") : ""}));
      setOutline((prior) => ({...prior, completion_mode: completionMode as "open_ended" | "fixed", target_chapters: completionMode === "fixed" ? Number(proposal.target_chapters) || null : null, premise: String(proposal.premise || prior.premise), core_conflict: String(proposal.core_conflict || prior.core_conflict), ending_direction: String(proposal.ending_direction || prior.ending_direction), major_beats: Array.isArray(proposal.major_beats) ? proposal.major_beats.map(String) : prior.major_beats, volumes: Array.isArray(proposal.volumes) ? proposal.volumes.map((item: any, index: number) => ({...item, volume_id: String(item.volume_id || `volume-${index + 1}`)})) : prior.volumes, rolling_plan: {...prior.rolling_plan, window_size: Math.max(1, Math.min(20, Number(proposal.rolling_window) || 5)), planned_through: Array.isArray(proposal.initial_chapters) ? Math.max(0, ...proposal.initial_chapters.map((item: any) => Number(item.chapter_number) || 0)) : prior.rolling_plan.planned_through}}));
      setInitialChapters(Array.isArray(proposal.initial_chapters) ? proposal.initial_chapters.map((item: any) => ({...item})) : []);
      setPlanningContract({schema_version: "foundation-contract-v1", source_job_id: artifact.jobId, source_draft_path: artifact.planningDraft?.path || "", source_draft_hash: artifact.planningDraft?.hash || "", generated_at: new Date().toISOString(), constraints: proposal.constraints, reader_world_contract: artifact.reader_world_contract || null, author_contract_snapshot: newBookAuthorContractSnapshot(selectedAuthorVersion), rationale: artifact.rationale || [], warnings: artifact.warnings || [], applied_fields: ["title", "genre", "synopsis", "completion_mode", "target_chapters", "rolling_window", "premise", "core_conflict", "ending_direction", "major_beats", "volumes", "initial_chapters", "author_contract_alignment", "reader_world_contract"]});
      setAssistantOpen(false);
    }}/>}
  </div></div>;
}

function ReaderFeedbackPanel({project, scopeType, scopeId, scopeLabel, generatedCount = 0, anchorId, onRefresh}: {project?: ProjectSummary; scopeType: "book" | "volume" | "chapter"; scopeId: string; scopeLabel: string; generatedCount?: number; anchorId?: string; onRefresh: () => Promise<void>}) {
  const [content, setContent] = useState("");
  const [records, setRecords] = useState<ReaderFeedbackRecord[]>([]);
  const [replyToId, setReplyToId] = useState<string | null>(null);
  const [newThread, setNewThread] = useState(false);
  const [reviewMode, setReviewMode] = useState<"targeted" | "full_scope">("targeted");
  const [busy, setBusy] = useState<"submit" | "reevaluate" | "rework" | "">("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!project) { setRecords([]); return; }
    const query = new URLSearchParams({scopeType, scopeId});
    const result = await api<{feedback: ReaderFeedbackRecord[]}>(`/api/projects/${project.id}/reader-feedback?${query}`);
    setRecords(result.feedback);
  }, [project?.id, scopeId, scopeType]);

  useEffect(() => { setContent(""); setReplyToId(null); setNewThread(false); setReviewMode("targeted"); setError(""); void load().catch((reason) => setError(reason instanceof Error ? reason.message : String(reason))); }, [load]);
  useEffect(() => {
    if (newThread || replyToId || !records.length) return;
    const latest = records.find((item) => !item.supersededById && !["reworking", "applied", "failed"].includes(item.status));
    if (latest) { setReplyToId(latest.id); setReviewMode(latest.reviewMode || "targeted"); }
  }, [newThread, records, replyToId]);
  const active = records.find((item) => item.status === "evaluating" || item.status === "reworking");
  useEffect(() => {
    if (!active) return;
    let mounted = true;
    const refresh = async () => {
      try {
        const result = await api<{feedback: ReaderFeedbackRecord; thread?: ReaderFeedbackRecord[]}>(`/api/reader-feedback/${active.id}`);
        if (!mounted) return;
        setRecords((prior) => {
          const updates = new Map((result.thread || [result.feedback]).map((item) => [item.id, item]));
          const merged = prior.map((item) => updates.get(item.id) || item);
          for (const item of updates.values()) if (!merged.some((existing) => existing.id === item.id)) merged.unshift(item);
          return merged;
        });
        if (result.feedback.status === "applied") await onRefresh();
      } catch (reason) { if (mounted) setError(reason instanceof Error ? reason.message : String(reason)); }
    };
    const stop = startPolling(refresh, 2500, {immediate: true});
    return () => { mounted = false; stop(); };
  }, [active?.id, active?.status, onRefresh]);

  const submit = async () => {
    if (!project || !content.trim()) return;
    setBusy("submit"); setError("");
    try {
      const result = await post<{feedback: ReaderFeedbackRecord}>(`/api/projects/${project.id}/reader-feedback`, {scopeType, scopeId, content: content.trim(), parentFeedbackId: newThread ? null : replyToId, reviewMode});
      await load();
      setReplyToId(result.feedback.id); setNewThread(false);
      setContent("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(""); }
  };
  const reevaluateFullScope = async (record: ReaderFeedbackRecord) => {
    setBusy("reevaluate"); setError("");
    try {
      const result = await post<{feedback: ReaderFeedbackRecord}>(`/api/reader-feedback/${record.id}/reevaluate`);
      setRecords((prior) => prior.map((item) => item.id === record.id ? result.feedback : item));
      setReviewMode("full_scope");
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(""); }
  };
  const rework = async (record: ReaderFeedbackRecord) => {
    setBusy("rework"); setError("");
    try {
      const result = await post<{feedback: ReaderFeedbackRecord}>(`/api/reader-feedback/${record.id}/rework`);
      setRecords((prior) => prior.map((item) => item.id === record.id ? result.feedback : item));
      await onRefresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(""); }
  };
  const stateText = (status: ReaderFeedbackRecord["status"]) => ({
    evaluating: "正在评估", evaluated: "评估完成 · 待确认", reworking: "严格返工中", applied: "返工已完成",
    needs_clarification: "需要补充反馈", failed: "评估失败",
  })[status];
  const replyTarget = records.find((item) => item.id === replyToId) || null;
  const shortHash = (value: unknown) => value ? String(value).slice(0, 12) : "未记录";
  const responseState = (value: string) => ({accepted: "采纳", partially_accepted: "部分采纳", rejected: "不采纳", needs_clarification: "需要补充"})[value] || value;
  const threadGroups = Array.from(records.reduce((groups, record) => {
    const root = record.rootFeedbackId || record.id;
    groups.set(root, [...(groups.get(root) || []), record]);
    return groups;
  }, new Map<string, ReaderFeedbackRecord[]>()).values()).map((items) => items.sort((a, b) => (a.sequence || 1) - (b.sequence || 1)))
    .sort((a, b) => new Date(b[b.length - 1].createdAt).getTime() - new Date(a[a.length - 1].createdAt).getTime());

  return <section className="panel reader-feedback-panel" id={anchorId}>
    <div className="reader-feedback-head">
      <div><p className="eyebrow">READER RESPONSE</p><h2>{scopeLabel}读后反馈</h2><span>先评估反馈影响，再由你确认重做范围；不会直接覆盖旧稿。</span></div>
      <div className="feedback-scope-stat"><strong>{generatedCount}</strong><span>篇已生成正文可评估</span></div>
    </div>
    <div className="reader-feedback-compose">
      {replyTarget && !newThread ? <div className="feedback-reply-banner"><Link2/><div><strong>承接反馈线程第 {replyTarget.sequence || 1} 轮</strong><span>本轮会同时读取此前 {replyTarget.sequence || 1} 轮反馈、旧评估与锁定正文；新结论会说明继承、修正或拒绝了什么。</span></div><button className="secondary small" onClick={() => { setReplyToId(null); setNewThread(true); setReviewMode("targeted"); }}>开启新话题</button></div> : <div className="feedback-reply-banner new"><MessageSquare/><div><strong>新的独立反馈线程</strong><span>不会继承其他反馈的判断；提交后仍会锁定当前正文、Canon 与写作策略。</span></div>{records.length > 0 && <button className="secondary small" onClick={() => { const recent = records.find((item) => !item.supersededById); setNewThread(false); setReplyToId(recent?.id || null); setReviewMode(recent?.reviewMode || "targeted"); }}>继续最近反馈</button>}</div>}
      <div className="feedback-mode-selector">
        <button className={reviewMode === "targeted" ? "active" : ""} onClick={() => setReviewMode("targeted")}><strong>证据定向修订</strong><span>AI 根据全文证据提出必要返工章</span></button>
        <button className={reviewMode === "full_scope" ? "active danger" : ""} onClick={() => setReviewMode("full_scope")}><strong>全文审查并全部重修</strong><span>锁定当前 {generatedCount} 篇已生成正文，AI 无权缩小范围</span></button>
      </div>
      <label><span>你的实际阅读感受</span><textarea maxLength={4000} value={content} onChange={(event) => setContent(event.target.value)} placeholder="例如：中段追查太顺，紧张感掉了；请保留井下刻痕和父亲工具这两条线，但让第 6—7 章的误判更有代价。"/></label>
      <div><p><ShieldCheck/>AI 必须逐轮回应、引用锁定正文原句，并公开实际读取范围与校验结果；不会展示或声称展示隐藏思维。确认后才从干净 Canon 基线重做。</p><button className="primary" disabled={!project || !content.trim() || Boolean(active) || busy === "submit"} onClick={() => void submit()}>{busy === "submit" ? <LoaderCircle className="spin"/> : <MessageSquare/>}{replyTarget && !newThread ? `补充第 ${(replyTarget.sequence || 1) + 1} 轮并评估` : "提交新反馈并评估"}</button></div>
    </div>
    {error && <div className="inline-error"><CircleAlert/>{error}</div>}
    {records.length > 0 && <div className="reader-feedback-history">{threadGroups.map((thread) => <section className="feedback-thread" key={thread[0].rootFeedbackId || thread[0].id}>
      <header className="feedback-thread-head"><div><ListTree/><strong>反馈线程 · {thread.length} 轮</strong></div><span>从第 1 轮到最新结论连续评估</span></header>
      {thread.map((record) => {
      const evaluation = record.evaluation || {};
      const affected = Array.isArray(evaluation.affected_chapters) ? evaluation.affected_chapters.map(Number) : [];
      const preserve = Array.isArray(evaluation.preserve) ? evaluation.preserve.map(String) : [];
      const changes = Array.isArray(evaluation.changes) ? evaluation.changes.map(String) : [];
      const risks = Array.isArray(evaluation.risks) ? evaluation.risks.map(String) : [];
      const responses = Array.isArray(evaluation.feedback_responses) ? evaluation.feedback_responses : [];
      const evidence = Array.isArray(evaluation.evidence) ? evaluation.evidence : [];
      const chapterAudits = Array.isArray(evaluation.chapter_audit) ? evaluation.chapter_audit : [];
      const proposedRules = Array.isArray(evaluation.proposed_book_rules) ? evaluation.proposed_book_rules : [];
      const questions = Array.isArray(evaluation.clarification_questions) ? evaluation.clarification_questions.map(String) : [];
      const manifest = record.contextManifest || {};
      const lockedChapters = (record.requestedChapters || manifest.requestedChapters || []).map(Number).sort((a, b) => a - b);
      const fullScopeMismatch = record.reviewMode === "full_scope" && JSON.stringify([...affected].sort((a, b) => a - b)) !== JSON.stringify(lockedChapters);
      const scopeRepairAvailable = fullScopeMismatch && ["evaluated", "failed", "needs_clarification"].includes(record.status);
      return <article key={record.id} className={`reader-feedback-record state-${record.status}`}>
        <header><div><span>第 {record.sequence || 1} 轮 · {fmtDate(record.createdAt)}</span><strong>{stateText(record.status)}</strong>{record.reviewMode === "full_scope" && <em>用户锁定全文</em>}</div>{evaluation.severity && <b className={`severity-${evaluation.severity}`}>{String(evaluation.severity)}</b>}</header>
        <blockquote>{record.content}</blockquote>
        {record.supersededById && <p className="feedback-superseded">这轮结论已由下一轮补充取代，仅保留作追溯；返工只能从线程最新结论启动。</p>}
        {evaluation.summary && <p className="feedback-evaluation-summary">{String(evaluation.summary)}</p>}
        {record.reviewMode === "full_scope" && <div className={`feedback-scope-lock ${fullScopeMismatch ? "invalid" : ""}`}><ShieldCheck/><div><strong>{lockedChapters.length ? `全文操作范围由用户锁定：第 ${lockedChapters.join("、")} 章` : "旧版全文意向：章节范围未保存"}</strong><span>{fullScopeMismatch ? `旧评估只选择了第 ${affected.join("、")} 章，已判定越权并禁止直接返工。` : lockedChapters.length ? "AI 只能决定每章如何改，不能拒绝或缩小这些章节。" : "该历史记录仅供追溯；新评估会重新读取并锁定当时所有已生成正文。"}</span></div></div>}
        {responses.length > 0 && <div className="feedback-response-list"><strong>逐轮回应</strong>{responses.map((item) => <article key={item.feedback_id}><header><b>{thread.find((source) => source.id === item.feedback_id)?.sequence ? `第 ${thread.find((source) => source.id === item.feedback_id)?.sequence} 轮` : item.feedback_id}</b><span>{responseState(item.disposition)}</span></header><p>{item.interpretation}</p><small>{item.reason}</small>{item.evidence_refs?.length > 0 && <code>证据 {item.evidence_refs.join(" · ")}</code>}</article>)}</div>}
        {evidence.length > 0 && <div className="feedback-evidence"><strong>正文原句证据</strong>{evidence.map((item) => <blockquote key={item.evidence_id}><span>{item.evidence_id} · 第 {item.chapter} 章 · {item.location}</span>“{item.quote}”</blockquote>)}</div>}
        {chapterAudits.length > 0 && <div className="feedback-chapter-audits"><strong>逐章全文审查</strong><div>{chapterAudits.map((item) => <article key={item.chapter}><header><b>第 {item.chapter} 章</b><span>{item.verdict === "rewrite_required" ? "必须重写" : "质量升级"}</span></header><p>{item.finding}</p><small>重写：{item.rewrite.join("；")}</small><code>证据 {item.evidence_refs.join(" · ")}</code></article>)}</div></div>}
        {affected.length > 0 && <div className="feedback-affected"><span>建议重做</span>{affected.map((chapter) => <b key={chapter}>第 {chapter} 章</b>)}</div>}
        {(preserve.length > 0 || changes.length > 0 || risks.length > 0) && <div className="feedback-assessment-grid">
          <div><span>必须保留</span>{preserve.length ? <ul>{preserve.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p>未指定</p>}</div>
          <div><span>需要修改</span>{changes.length ? <ul>{changes.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p>未形成可执行修改</p>}</div>
          <div><span>连贯性风险</span>{risks.length ? <ul>{risks.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p>未发现额外风险</p>}</div>
        </div>}
        {proposedRules.length > 0 && <div className="feedback-book-rules"><header><div><ShieldCheck/><strong>确认返工时写入本书长期规范</strong></div><span>{proposedRules.length} 条</span></header>{proposedRules.map((item, index) => <article key={index}><b>{item.category}</b><p>{item.rule}</p><small>{item.rationale} · 证据 {item.evidence_refs.join("、") || "评估结论"}</small></article>)}</div>}
        {questions.length > 0 && <div className="feedback-questions"><strong>需要你补充</strong><ul>{questions.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
        <details className="feedback-transparency"><summary><Fingerprint/>查看本轮读取范围、上下文锁定与校验链</summary><div className="feedback-trace-grid">
          <div><span>正文范围</span><strong>直接章 {(manifest.primaryChapters || []).join("、") || "未记录"}</strong><small>依赖章 {(manifest.downstreamDependencyChapters || []).join("、") || "无"}；可评估 {(manifest.eligibleChapters || []).join("、") || "无"}</small></div>
          <div><span>Canon / 作者策略</span><strong>Canon 至第 {manifest.canon?.throughChapter ?? "?"} 章</strong><small>Canon {shortHash(manifest.canon?.hash)} · Policy {shortHash(manifest.writingPolicy?.policyHash)} · 作者版本 {shortHash(manifest.writingPolicy?.authorVersionId)}</small></div>
          <div><span>任务与契约</span><strong>{record.jobSummary?.status || record.status}</strong><small>Job {record.jobSummary?.id || record.jobId || "未创建"} · Schema {String(record.validationTrace?.artifactSchema && typeof record.validationTrace.artifactSchema === "object" ? (record.validationTrace.artifactSchema as Record<string, unknown>).status || "已记录" : record.validationTrace?.status || "等待")}</small></div>
          <div><span>不可变追踪</span><strong>Context {shortHash(manifest.contextHash)}</strong><small>Prompt {shortHash(record.jobSummary?.promptHash)} · Output {shortHash(record.jobSummary?.outputHash)} · 锁定 {manifest.lockedAt ? fmtDate(String(manifest.lockedAt)) : "未记录"}</small></div>
        </div>{manifest.chapters?.length ? <div className="feedback-chapter-hashes">{manifest.chapters.map((item) => <code key={item.chapterNumber}>第 {item.chapterNumber} 章 {shortHash(item.bodyHash)}{item.truncated ? " · 代表片段" : " · 全文"}</code>)}</div> : null}</details>
        {record.status === "needs_clarification" && <p className="feedback-help">{manifest.contextHash ? "系统已先检查锁定正文，但仍存在会导致不同返工结果的歧义。请直接回答上方问题，作为本线程下一轮补充。" : "这轮由旧版独立评估器生成，未保存正文范围和上下文快照。请在本线程继续补充；新评估会重新读取完整线程并锁定可核验上下文。"}</p>}
        {scopeRepairAvailable && !record.supersededById && <div className="feedback-scope-repair"><div><strong>这份评估违反了你的全文范围指令</strong><span>不会让它按 1—3 章直接返工。重新评估后必须逐章读取第 {lockedChapters.join("、")} 章、逐章举证，并形成全部章节的重写计划和全书长期规范。</span></div><button className="primary" disabled={busy === "reevaluate" || Boolean(active)} onClick={() => void reevaluateFullScope(record)}>{busy === "reevaluate" ? <LoaderCircle className="spin"/> : <RefreshCw/>}按全文范围重新评估</button></div>}
        {!record.supersededById && !["evaluating", "reworking", "applied"].includes(record.status) && <div className="feedback-followup"><button className="secondary small" onClick={() => { setReplyToId(record.id); setNewThread(false); setContent(""); document.getElementById(anchorId || "")?.scrollIntoView({behavior: "smooth", block: "start"}); }}><Link2/>继续补充 / 修正这一轮</button></div>}
        {record.status === "evaluated" && evaluation.verdict === "actionable" && !record.supersededById && !fullScopeMismatch && proposedRules.length > 0 && <footer><span>确认后先把上方规则写入本书覆盖策略，再从干净 Canon 基线重做全部选定章节；后续章节设计、正文和审查会持续读取这些规范。</span><button className="primary" disabled={busy === "rework" || Boolean(active)} onClick={() => void rework(record)}>{busy === "rework" ? <LoaderCircle className="spin"/> : <RotateCcw/>}确认规则并重做 {affected.length} 章</button></footer>}
        {record.status === "reworking" && <footer><span>正在按已确认范围连续执行严格流水线，刷新页面不会丢失任务。</span><StatusPill value="running"/></footer>}
        {record.status === "applied" && <footer><span>新版已完成严格流水线；旧版本仍可在本地历史中追溯。</span><StatusPill value="succeeded"/></footer>}
      </article>;
    })}</section>)}</div>}
  </section>;
}

function RebuildScopeDialog({project, scopeType, scopeId, scopeLabel, onClose, onApplied}: {project: ProjectSummary; scopeType: "chapter" | "volume" | "book"; scopeId: string; scopeLabel: string; onClose: () => void; onApplied: () => Promise<void>}) {
  const [preview, setPreview] = useState<RebuildPreview | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const query = new URLSearchParams({scopeType, scopeId});
    void api<RebuildPreview>(`/api/projects/${project.id}/rebuild-preview?${query}`).then(setPreview).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [project.id, scopeId, scopeType]);
  const apply = async () => {
    if (!preview || confirmation !== preview.confirmation_phrase) return;
    setBusy(true); setError("");
    try {
      await post(`/api/projects/${project.id}/rebuild`, {scopeType, scopeId, confirmation});
      await onApplied();
      onClose();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  return <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={`清空 ${scopeLabel} 及关联产物`}><div className="batch-modal rebuild-modal">
    <div className="modal-head"><div><p className="eyebrow">PERMANENT REBUILD</p><h2>{scopeType === "book" ? "仅保留书名、封面与作者版本绑定，推倒重建" : `永久删除${scopeLabel}及全部关联本地产物`}</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X/></button></div>
    {!preview && !error && <div className="rebuild-loading"><LoaderCircle className="spin"/>正在计算真实依赖范围…</div>}
    {preview && <div className="rebuild-preview">
      <div className="rebuild-scope"><strong>{scopeLabel}</strong><span>{preview.chapter_numbers.length ? `涉及第 ${preview.chapter_numbers.join("、")} 章` : "当前没有章节，但仍会清空全书规划与派生产物"}</span></div>
      <div className="rebuild-columns"><section><h3>将永久清除</h3>{preview.cleared.map((item) => <p key={item}><Trash2/>{item}</p>)}<small>实际清理路径 {preview.file_paths.length} 项；共享工作流、依赖 Canon 和历史回收副本也会一并失效。</small></section><section><h3>明确保留</h3>{preview.retained.map((item) => <p key={item}><ShieldCheck/>{item}</p>)}</section></div>
      {preview.warnings.map((item) => <div className="rebuild-warning" key={item}><CircleAlert/>{item}</div>)}
      {preview.blockers.map((item) => <div className="rebuild-blocker" key={item}><Square/>{item}</div>)}
      <label className="rebuild-confirm"><span>输入确认短语后才会执行；清理成功后不会保留正文、规划、Prompt、审查、反馈或旧回收副本，无法恢复。</span><code>{preview.confirmation_phrase}</code><input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder={preview.confirmation_phrase}/></label>
    </div>}
    {error && <div className="assistant-error"><CircleAlert/>{error}</div>}
    <div className="modal-foot"><p><Trash2/>这是不可恢复的本地清理；不会删除番茄平台上的已发布内容。</p><div><button className="secondary" onClick={onClose}>取消</button><button className="danger-write" disabled={!preview || preview.blocked || confirmation !== preview.confirmation_phrase || busy} onClick={() => void apply()}>{busy ? <LoaderCircle className="spin"/> : <Trash2/>}确认永久清除</button></div></div>
  </div></div>;
}

function PlanningView({project, detail, busy, run, onRefresh}: {project?: ProjectSummary; detail: ProjectDetail | null; busy: string; run: (key: string, task: () => Promise<void>) => void; onRefresh: () => Promise<void>}) {
  const [book, setBook] = useState({title: "", author: "", synopsis: "", genre: "", completionMode: "open_ended", targetChapters: ""});
  const [master, setMaster] = useState<MasterOutline>(blankMaster());
  const [chapters, setChapters] = useState<Array<Record<string, any>>>([]);
  const [selection, setSelection] = useState<{level: "book" | "volume" | "chapter"; id: string}>({level: "book", id: "book"});
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [batchMode, setBatchMode] = useState(false);
  const [batchSelected, setBatchSelected] = useState<number[]>([]);
  const [batchAssistantOpen, setBatchAssistantOpen] = useState(false);
  const [clearSelectedOutline, setClearSelectedOutline] = useState(false);
  const [rangeStart, setRangeStart] = useState("");
  const [rangeEnd, setRangeEnd] = useState("");
  const [rebuildScope, setRebuildScope] = useState<{type: "chapter" | "volume" | "book"; id: string; label: string} | null>(null);
  const [foundationContract, setFoundationContract] = useState<FoundationContract>({});
  const [pendingContractUpdate, setPendingContractUpdate] = useState<PlanningContractUpdate | null>(null);
  const [savedPlanningFingerprint, setSavedPlanningFingerprint] = useState("");
  const [pendingPlanningFingerprint, setPendingPlanningFingerprint] = useState("");
  const [capturePendingFingerprint, setCapturePendingFingerprint] = useState(false);

  useEffect(() => {
    if (!detail?.book) return;
    const metadata = detail.book.metadata || {};
    const nextBook = {title: detail.book.title, author: String(metadata.author || ""), synopsis: String(metadata.synopsis || ""), genre: String(metadata.genre || ""), completionMode: String(metadata.completion_mode || "open_ended"), targetChapters: metadata.target_chapters ? String(metadata.target_chapters) : ""};
    const nextMaster = detail.outline?.master || blankMaster();
    const nextChapters = (detail.outline?.chapters || []).map((item: any) => ({...(item.contract || item)}));
    setBook(nextBook);
    setMaster(nextMaster);
    setChapters(nextChapters);
    setSavedPlanningFingerprint(JSON.stringify({book: nextBook, master: nextMaster, chapters: nextChapters}));
    setPendingPlanningFingerprint("");
    setCapturePendingFingerprint(false);
    setFoundationContract(detail.outline?.foundation_contract || {});
    setPendingContractUpdate(null);
    setSelection({level: "book", id: "book"});
    setBatchMode(false); setBatchSelected([]); setBatchAssistantOpen(false); setClearSelectedOutline(false);
  }, [detail?.book.id]);

  const planningFingerprint = useMemo(() => JSON.stringify({book, master, chapters}), [book, master, chapters]);
  useLayoutEffect(() => {
    if (pendingContractUpdate && capturePendingFingerprint) {
      setPendingPlanningFingerprint(planningFingerprint);
      setCapturePendingFingerprint(false);
    }
  }, [capturePendingFingerprint, pendingContractUpdate, planningFingerprint]);
  const hasUnsavedPlanning = Boolean(savedPlanningFingerprint && planningFingerprint !== savedPlanningFingerprint);
  const changedAfterCandidate = Boolean(pendingContractUpdate && pendingPlanningFingerprint && planningFingerprint !== pendingPlanningFingerprint);

  const volumes = master.volumes || [];
  const selectedVolume = selection.level === "volume" ? volumes.find((item) => item.volume_id === selection.id) : null;
  const selectedChapter = selection.level === "chapter" ? chapters.find((item) => String(item.chapter_number) === selection.id) : null;
  const chapterGroups = volumes.map((volume) => ({volume, chapters: chapters.filter((item) => String(item.volume_id || "volume-1") === volume.volume_id)}));
  const ungrouped = chapters.filter((item) => !volumes.some((volume) => volume.volume_id === String(item.volume_id || "volume-1")));
  const selectedBatchContracts = chapters.filter((item) => batchSelected.includes(Number(item.chapter_number))).sort((a, b) => Number(a.chapter_number) - Number(b.chapter_number));
  const selectedBatchNumbers = selectedBatchContracts.map((item) => Number(item.chapter_number));
  const firstBatchNumber = selectedBatchNumbers[0] || 0;
  const lastBatchNumber = selectedBatchNumbers.at(-1) || 0;
  const batchBoundaries = {
    previous: chapters.find((item) => Number(item.chapter_number) === firstBatchNumber - 1) || null,
    next: chapters.find((item) => Number(item.chapter_number) === lastBatchNumber + 1) || null,
  };
  const activeVolumeId = selectedVolume?.volume_id || selectedChapter?.volume_id || "";
  const toggleBatchChapter = (number: number) => setBatchSelected((prior) => prior.includes(number) ? prior.filter((item) => item !== number) : [...prior, number].sort((a, b) => a - b));
  const toggleBatchMode = () => {
    if (batchMode) { setBatchMode(false); setBatchAssistantOpen(false); setClearSelectedOutline(false); }
    else setBatchMode(true);
  };
  const selectRange = () => {
    const start = Number(rangeStart); const end = Number(rangeEnd);
    if (!Number.isInteger(start) || !Number.isInteger(end)) return;
    const low = Math.min(start, end); const high = Math.max(start, end);
    setBatchSelected(chapters.map((item) => Number(item.chapter_number)).filter((number) => number >= low && number <= high));
  };

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
  const queueConstraintDelta = (artifact: PlanningArtifact & {jobId: string}, sourceScope: PlanningScope, appliedFields: string[]) => {
    const delta = artifact.constraint_delta;
    if (!delta) {
      window.alert("这是旧版共创候选，没有约束差异契约。请在当前对话中重新生成一次，避免只改表单却不更新本地约束文件。");
      return false;
    }
    const currentHash = String(foundationContract.contract_hash || "");
    if (String(delta.base_contract_hash || "") !== currentHash) {
      window.alert("本地约束文件已在候选生成后发生变化。请刷新当前规划上下文并重新生成，旧候选不会覆盖新版约束。");
      return false;
    }
    if (artifact.planningScope && artifact.planningScope !== sourceScope) {
      window.alert("候选规划范围与当前编辑范围不一致，已拒绝跨层应用。");
      return false;
    }
    const candidateSnapshot = artifact.planningContextSnapshot;
    const candidateMode = artifact.planningMode || "fill";
    if (!candidateSnapshot) {
      window.alert("这是旧版共创候选，没有规划编辑器冻结快照。请在当前对话中重新生成，避免使用陈旧候选。");
      return false;
    }
    const currentSnapshot = planningSnapshotForUi(sourceScope, candidateMode, {
      book, master, chapters,
      selected: sourceScope === "volume" ? selectedVolume : sourceScope === "chapter" ? selectedChapter : {},
      selectedChapterNumbers: sourceScope === "chapters" ? selectedBatchNumbers : [],
      boundaries: sourceScope === "chapters" ? batchBoundaries : {},
      clearSelectedOutline: sourceScope === "chapters" && clearSelectedOutline,
    });
    if (planningStableJson(candidateSnapshot) !== planningStableJson(currentSnapshot)) {
      window.alert("候选生成后当前书籍表单、总纲、章纲、选中范围或批量边界已变化。旧候选不会与新编辑混合，请基于当前状态重新生成。");
      return false;
    }
    const priorSourceIds = pendingContractUpdate ? pendingContractUpdate.source_job_ids : [];
    if (priorSourceIds.length && (priorSourceIds.some((id) => id !== artifact.jobId) || priorSourceIds.includes(artifact.jobId))) {
      window.alert("一次保存只能绑定一个规划候选；当前待保存区已有其他候选或重复应用，请清空待保存区后重新生成单一候选。");
      return false;
    }
    const proposal = artifact.proposal || {};
    const proposalVolumes = new Set([
      ...volumes.map((item) => String(item.volume_id || "")),
      ...(Array.isArray(proposal.volumes) ? proposal.volumes.map((item: Record<string, unknown>) => String(item?.volume_id || "")) : []),
    ].filter(Boolean));
    const selectedNumber = selectedChapter ? String(Number(selectedChapter.chapter_number)) : "";
    const allowedChapterIds = new Set(sourceScope === "chapters" ? selectedBatchNumbers.map(String) : sourceScope === "chapter" ? [selectedNumber] : []);
    const seenConstraintIds = new Set<string>();
    const seenChangeKeys = new Set<string>();
    for (const change of Array.isArray(delta.changes) ? delta.changes : []) {
      const scopeType = String(change.scope_type || "");
      const scopeId = String(change.scope_id || "");
      const operation = String(change.operation || "");
      const constraintId = String(change.constraint_id || "");
      if (operation !== "add" && constraintId) {
        if (seenConstraintIds.has(constraintId)) {
          window.alert(`候选重复修改同一约束 ${constraintId}，已拒绝冲突差异。`);
          return false;
        }
        seenConstraintIds.add(constraintId);
      }
      const changeKey = `${operation}|${scopeType}|${scopeId}|${constraintId}|${String(change.category || "")}|${String(change.rule || "")}`;
      if (seenChangeKeys.has(changeKey)) {
        window.alert("候选包含重复约束差异，已拒绝合并。");
        return false;
      }
      seenChangeKeys.add(changeKey);
      const allowed = sourceScope === "book"
        ? (scopeType === "book" && scopeId === "book" || scopeType === "volume" && proposalVolumes.has(scopeId))
        : sourceScope === "volume"
          ? scopeType === "volume" && scopeId === String(selectedVolume?.volume_id || selection.id)
          : scopeType === "chapter" || sourceScope === "chapters"
            ? scopeType === "chapter" && allowedChapterIds.has(String(Number(scopeId)))
            : false;
      if (!allowed) {
        window.alert(`候选约束越过当前 ${sourceScope} 范围：${scopeType}/${scopeId}。`);
        return false;
      }
    }
    setPendingContractUpdate((prior) => {
      const compatible = prior && prior.base_contract_hash === currentHash;
      const sourceIds = [...new Set([...(compatible ? prior.source_job_ids : []), artifact.jobId])];
      return {
        base_contract_hash: currentHash,
        changes: [...(compatible ? prior.changes : []), ...(Array.isArray(delta.changes) ? delta.changes : [])],
        source_job_id: artifact.jobId,
        source_job_ids: sourceIds,
        source_scope: sourceScope,
        rationale: [...(compatible ? prior.rationale : []), ...(artifact.rationale || [])],
        warnings: [...(compatible ? prior.warnings : []), ...(artifact.warnings || [])],
        applied_fields: [...new Set([...(compatible ? prior.applied_fields : []), ...appliedFields])],
        planning_context_hashes: artifact.planningContextHashes,
        planning_context_snapshot: candidateSnapshot,
        planning_mode: candidateMode,
      };
    });
    setCapturePendingFingerprint(true);
    return true;
  };
  const save = () => {
    if (changedAfterCandidate) {
      window.alert("应用 AI 候选后表单又发生了修改。当前约束差异只对应候选原案，不能与改后的大纲混合保存；请把新要求发回对应层级的 AI 共创并重新应用候选。");
      return;
    }
    if (hasUnsavedPlanning && !pendingContractUpdate && !window.confirm("当前修改没有对应的 AI 约束差异。继续只会保存大纲字段，现有长期约束将原样保留。确认这是你的意图吗？")) return;
    run("planning-save", async () => {
    if (!project) throw new Error("请先选择作品");
    const completionMode = book.completionMode as "open_ended" | "fixed";
    const target = completionMode === "fixed" ? Number(book.targetChapters) || null : null;
      const pendingSelection = pendingContractUpdate ? planningSnapshotForUi(pendingContractUpdate.source_scope, pendingContractUpdate.planning_mode === "rewrite" ? "rewrite" : "fill", {
        book, master, chapters,
        selected: pendingContractUpdate.source_scope === "volume" ? selectedVolume : pendingContractUpdate.source_scope === "chapter" ? selectedChapter : {},
        selectedChapterNumbers: pendingContractUpdate.source_scope === "chapters" ? selectedBatchNumbers : [],
        boundaries: pendingContractUpdate.source_scope === "chapters" ? batchBoundaries : {},
        clearSelectedOutline: pendingContractUpdate.source_scope === "chapters" && clearSelectedOutline,
      }) : null;
      const saved = await api<{foundation_contract?: FoundationContract}>(`/api/projects/${project.id}/outline`, {method: "PUT", body: JSON.stringify({
        book: {title: book.title, metadata: {author: book.author, synopsis: book.synopsis, genre: book.genre, completion_mode: completionMode, target_chapters: target}},
        master: {...master, completion_mode: completionMode, target_chapters: target, premise: master.premise || book.synopsis}, chapters,
      ...(pendingContractUpdate ? {planning_contract_update: {...pendingContractUpdate, planning_selection: pendingSelection ? {
        selected_ids: pendingSelection.selected_ids,
        selected_chapter_numbers: pendingSelection.selected_chapter_numbers,
        boundaries: pendingSelection.boundaries,
        clear_selected_outline: pendingSelection.clear_selected_outline,
      } : undefined}} : {}),
      })});
    if (saved.foundation_contract) setFoundationContract(saved.foundation_contract);
    setPendingContractUpdate(null);
    setPendingPlanningFingerprint("");
    setClearSelectedOutline(false);
    await onRefresh();
    });
  };
  const applyAIProposal = (proposal: Record<string, any>, artifact: PlanningArtifact & {jobId: string}) => {
    const appliedFields = selection.level === "book" ? ["synopsis", "genre", "premise", "core_conflict", "ending_direction", "major_beats", "volumes"] : selection.level === "volume" ? ["volume"] : ["chapter"];
    if (!queueConstraintDelta(artifact, selection.level, appliedFields)) return;
    if (selection.level === "book") {
      setBook((prior) => ({...prior, synopsis: String(proposal.synopsis || prior.synopsis), genre: String(proposal.genre || prior.genre)}));
      setMaster((prior) => ({...prior, premise: String(proposal.premise || prior.premise), core_conflict: String(proposal.core_conflict || prior.core_conflict), ending_direction: String(proposal.ending_direction || prior.ending_direction), major_beats: Array.isArray(proposal.major_beats) ? proposal.major_beats.map(String) : prior.major_beats, volumes: Array.isArray(proposal.volumes) ? proposal.volumes.map((item: any, index: number) => ({...item, volume_id: String(item.volume_id || prior.volumes[index]?.volume_id || `volume-${index + 1}`)})) : prior.volumes}));
    } else if (selection.level === "volume" && selectedVolume) updateVolume({...proposal, volume_id: selectedVolume.volume_id} as Partial<VolumeOutline>);
    else if (selectedChapter) updateChapter({...proposal, chapter_number: selectedChapter.chapter_number, volume_id: selectedChapter.volume_id});
    setAssistantOpen(false);
  };
  const applyBatchAIProposal = (proposal: Record<string, any>, artifact: PlanningArtifact & {jobId: string}) => {
    if (!Array.isArray(proposal.chapters)) return;
    if (!queueConstraintDelta(artifact, "chapters", ["chapters"])) return;
    const replacements = new Map(proposal.chapters.map((item: Record<string, any>) => [Number(item.chapter_number), item]));
    setChapters((prior) => prior.map((item) => {
      const number = Number(item.chapter_number);
      const replacement = replacements.get(number);
      if (!replacement || !batchSelected.includes(number)) return item;
      const base = clearSelectedOutline ? {chapter_number: number, volume_id: item.volume_id || "volume-1"} : item;
      return {...base, ...replacement, chapter_number: number, volume_id: item.volume_id || "volume-1"};
    }));
    setBatchAssistantOpen(false);
  };
  const selectedForAI = selection.level === "book" ? {book, master} : selection.level === "volume" ? selectedVolume : selectedChapter;
  const aiScopeLabel = selection.level === "book" ? "全书" : selection.level === "volume" ? "本卷" : "本章";
  const selectedScopeChapters = selection.level === "book" ? chapters : selection.level === "volume" ? chapters.filter((item) => String(item.volume_id || "volume-1") === selection.id) : selectedChapter ? [selectedChapter] : [];
  const generatedInScope = selectedScopeChapters.filter((contract) => detail?.chapters?.some((row: any) => Number(row.chapter_number) === Number(contract.chapter_number) && chapterAlreadyHandled(String(row.status)))).length;
  const feedbackScopeLabel = selection.level === "book" ? "全书" : selection.level === "volume" ? `${selectedVolume?.title || "本卷"} · ` : `第 ${selectedChapter?.chapter_number || "—"} 章 · `;
  const activeConstraints = Array.isArray(foundationContract.active_constraints) ? foundationContract.active_constraints : [];
  const authorContractSnapshot = foundationContract.author_contract_snapshot && typeof foundationContract.author_contract_snapshot === "object" ? foundationContract.author_contract_snapshot : {};
  const authorSnapshot = authorContractSnapshot as Record<string, unknown>;
  const authorProfileHash = String(authorSnapshot.profile_hash || authorSnapshot.author_profile_hash || "");
  const authorMethodRules = Array.isArray(authorSnapshot.method_rules) ? authorSnapshot.method_rules : [];
  const authorTendencyRules = Array.isArray(authorSnapshot.optional_content_tendencies) ? authorSnapshot.optional_content_tendencies : [];
  const hardRuleCount = activeConstraints.filter((item: any) => String(item.priority || "").toLowerCase() === "must").length;

  return <>
    <section className="section-head large"><div><p className="eyebrow">THREE-LEVEL OUTLINE</p><h1>全书 · 分卷 · 章节</h1><p>已规划范围只是下一段可执行路线，不等于全书完结章数。</p></div><div className="planning-head-actions"><button className={batchMode ? "primary" : "secondary"} disabled={!project} onClick={toggleBatchMode}><ListTree/>{batchMode ? "退出批量重规划" : "批量重规划"}</button><button className="secondary" disabled={!project || batchMode && batchSelected.length < 2} onClick={() => { if (batchMode) setBatchAssistantOpen(true); else if (selection.level === "book") document.getElementById("book-planning-dialogue")?.scrollIntoView({behavior: "smooth", block: "start"}); else setAssistantOpen(true); }}><MessageSquare/>{batchMode ? `AI 重规划 ${batchSelected.length} 章` : `AI 共创${aiScopeLabel}`}</button><button className="primary" disabled={!project || busy === "planning-save"} onClick={save}>{busy === "planning-save" ? <LoaderCircle className="spin"/> : <Save/>}{pendingContractUpdate ? "保存大纲并写入约束" : "保存三级大纲"}</button></div></section>
    <div className="planning-layout">
      <aside className="panel outline-tree">
        {batchMode && <div className="outline-tree-toolbar"><strong>批量章节范围</strong><div><button onClick={() => setBatchSelected(chapters.map((item) => Number(item.chapter_number)))}>全选</button><button disabled={!activeVolumeId} onClick={() => setBatchSelected(chapters.filter((item) => String(item.volume_id || "volume-1") === activeVolumeId).map((item) => Number(item.chapter_number)))}>本卷</button><button onClick={() => setBatchSelected([])}>清空</button></div><div className="outline-range"><input type="number" min="1" placeholder="起始章" value={rangeStart} onChange={(event) => setRangeStart(event.target.value)}/><span>—</span><input type="number" min="1" placeholder="结束章" value={rangeEnd} onChange={(event) => setRangeEnd(event.target.value)}/><button onClick={selectRange}>选取</button></div><small>已选 {batchSelected.length} 章；至少选择 2 章。</small></div>}
        <button className={selection.level === "book" ? "active" : ""} onClick={() => setSelection({level: "book", id: "book"})}><BookOpen/><span><strong>全书</strong><small>{book.completionMode === "fixed" ? `目标 ${book.targetChapters || "—"} 章` : "开放式连载"}</small></span></button>
        {chapterGroups.map(({volume, chapters: items}) => <div className="volume-node" key={volume.volume_id}>
          <button className={selection.level === "volume" && selection.id === volume.volume_id ? "active" : ""} onClick={() => setSelection({level: "volume", id: volume.volume_id})}><Layers3/><span><strong>{volume.title}</strong><small>{items.length} 章已规划</small></span></button>
          <div>{items.map((chapter) => <div className="outline-chapter-select-row" key={chapter.chapter_number}>{batchMode && <label className="chapter-batch-check" title={`选择第 ${chapter.chapter_number} 章`}><input type="checkbox" checked={batchSelected.includes(Number(chapter.chapter_number))} onChange={() => toggleBatchChapter(Number(chapter.chapter_number))}/><span>{batchSelected.includes(Number(chapter.chapter_number)) && <Check/>}</span></label>}<button className={selection.level === "chapter" && selection.id === String(chapter.chapter_number) ? "active" : ""} onClick={() => setSelection({level: "chapter", id: String(chapter.chapter_number)})}><span className="chapter-dot"/><span><strong>第 {chapter.chapter_number} 章</strong><small>{String(chapter.title || "待命名")}</small></span></button></div>)}</div>
          <button className="tree-add" onClick={() => addChapter(volume.volume_id)}><Plus/>给本卷添加一章</button>
        </div>)}
        {ungrouped.map((chapter) => <div className="outline-chapter-select-row" key={chapter.chapter_number}>{batchMode && <label className="chapter-batch-check"><input type="checkbox" checked={batchSelected.includes(Number(chapter.chapter_number))} onChange={() => toggleBatchChapter(Number(chapter.chapter_number))}/><span>{batchSelected.includes(Number(chapter.chapter_number)) && <Check/>}</span></label>}<button onClick={() => setSelection({level: "chapter", id: String(chapter.chapter_number)})}><span className="chapter-dot"/><span><strong>第 {chapter.chapter_number} 章</strong><small>未分卷</small></span></button></div>)}
        <button className="tree-add major" onClick={addVolume}><Plus/>添加一卷</button>
      </aside>
      <section className="panel outline-editor">
        {batchMode && <div className="batch-planning-bar"><div><span>跨章统一规划</span><strong>{batchSelected.length >= 2 ? `已锁定第 ${selectedBatchNumbers.join("、")} 章` : "请从左侧选择至少两章"}</strong><p>候选必须逐章覆盖锁定范围，并对证因果、人物知识、关系、身体状态、信息差、伏笔与前后边界。</p></div><button type="button" aria-pressed={clearSelectedOutline} className={clearSelectedOutline ? "batch-clear-authorization active" : "batch-clear-authorization"} onClick={() => setClearSelectedOutline((prior) => !prior)}><Trash2/><span><b>{clearSelectedOutline ? "已授权清空并替换所选章纲" : "允许清空并替换所选章纲"}</b><small>危险授权只删除所选章节的旧章纲字段；正文、Canon、审查、发布记录和未选章节绝不删除。</small></span></button><button className="primary" disabled={batchSelected.length < 2} onClick={() => setBatchAssistantOpen(true)}><Sparkles/>对话重规划 {batchSelected.length} 章</button></div>}
        {selection.level === "book" && <>
          <div className="panel-title"><div><span>全书层</span><strong>作品资料与总纲</strong></div><div className="panel-title-actions"><button className="danger" onClick={() => setRebuildScope({type: "book", id: "book", label: "全书"})}><Trash2/>只保留书名与封面，推倒重建</button><BookOpen/></div></div>
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
          {project && <PlanningAssistant embedded scope="book" context={{bookId: project.id, book, master, chapters, foundationContract}} onClose={() => undefined} onApply={applyAIProposal}/>}
        </>}
        {selectedVolume && <><div className="panel-title"><div><span>分卷层</span><strong>{selectedVolume.title}卷纲</strong></div><div className="panel-title-actions"><button className="danger" onClick={() => setRebuildScope({type: "volume", id: selectedVolume.volume_id, label: selectedVolume.title})}><Trash2/>删除本卷及关联产物</button><Layers3/></div></div><div className="outline-form">
          <label><span>卷名</span><input value={selectedVolume.title} onChange={(event) => updateVolume({title: event.target.value})}/></label><label><span>卷编号</span><input value={selectedVolume.volume_id} readOnly/></label>
          <label className="wide-field"><span>本卷目标</span><textarea value={selectedVolume.objective} onChange={(event) => updateVolume({objective: event.target.value})}/></label><label className="wide-field"><span>本卷主冲突</span><textarea value={selectedVolume.main_conflict} onChange={(event) => updateVolume({main_conflict: event.target.value})}/></label>
          <label><span>人物变化</span><textarea value={selectedVolume.character_change} onChange={(event) => updateVolume({character_change: event.target.value})}/></label><label><span>伏笔推进/兑现</span><textarea value={selectedVolume.foreshadowing} onChange={(event) => updateVolume({foreshadowing: event.target.value})}/></label>
          <label className="wide-field"><span>卷末落点与下一卷入口</span><textarea value={selectedVolume.ending} onChange={(event) => updateVolume({ending: event.target.value})}/></label>
        </div></>}
        {selectedChapter && <><div className="panel-title"><div><span>章节层</span><strong>第 {selectedChapter.chapter_number} 章章纲</strong></div><div className="panel-title-actions"><button className="danger" onClick={() => setRebuildScope({type: "chapter", id: String(selectedChapter.chapter_number), label: `第 ${selectedChapter.chapter_number} 章`})}><Trash2/>删除本章及关联产物</button><ListTree/></div></div><div className="outline-form">
          <label><span>章节标题</span><input value={selectedChapter.title || ""} onChange={(event) => updateChapter({title: event.target.value})}/></label><label><span>所属卷</span><select value={selectedChapter.volume_id || "volume-1"} onChange={(event) => updateChapter({volume_id: event.target.value})}>{volumes.map((volume) => <option value={volume.volume_id} key={volume.volume_id}>{volume.title}</option>)}</select></label>
          <label className="wide-field"><span>本章目标</span><textarea value={selectedChapter.objective || ""} onChange={(event) => updateChapter({objective: event.target.value})}/></label><label><span>阻碍</span><textarea value={selectedChapter.obstacle || ""} onChange={(event) => updateChapter({obstacle: event.target.value})}/></label><label><span>本章变化</span><textarea value={selectedChapter.change || ""} onChange={(event) => updateChapter({change: event.target.value})}/></label>
          <label><span>章末钩子</span><textarea value={selectedChapter.chapter_hook || ""} onChange={(event) => updateChapter({chapter_hook: event.target.value})}/></label><label><span>下一章第一拍</span><textarea value={selectedChapter.next_first_beat || ""} onChange={(event) => updateChapter({next_first_beat: event.target.value})}/></label>
          <label><span>目标字数</span><input type="number" min="500" max="10000" value={selectedChapter.target_word_count || 2800} onChange={(event) => updateChapter({target_word_count: Number(event.target.value)})}/></label>
        </div></>}
        {!project && <div className="empty-state"><BookPlus/><h3>先新建或选择作品</h3><p>作品建立后可在这里维护全书、分卷和章节三级大纲。</p></div>}
      </section>
    </div>
    {project && <section className={pendingContractUpdate ? "planning-contract-console pending" : "planning-contract-console"}>
      <header><div><p className="eyebrow">AUTHOR · OUTLINE · CONTRACT</p><h2>本地规划约束快照</h2></div><span>{pendingContractUpdate ? "待随大纲一并保存" : foundationContract.contract_hash ? "当前已生效" : "尚未建立"}</span></header>
      {changedAfterCandidate && <div className="planning-contract-warning blocked"><CircleAlert/><div><strong>候选应用后又改了表单，已禁止混合保存</strong><span>当前长期约束只对应 AI 候选原案。请把新增改动发回当前层级共创，重新生成并应用候选；旧差异不会与新大纲拼接。</span></div><button className="secondary small" onClick={() => selection.level === "book" ? document.getElementById("book-planning-dialogue")?.scrollIntoView({behavior: "smooth", block: "start"}) : setAssistantOpen(true)}>回到 AI 共创</button></div>}
      {hasUnsavedPlanning && !pendingContractUpdate && <div className="planning-contract-warning"><CircleAlert/><div><strong>这是手动大纲修改，没有同步产生长期约束差异</strong><span>可以明确确认后只保存大纲；如果它改变了读者承诺、人物边界、世界规则、卷目标或章节禁令，应先通过对应层级共创，让约束文件同步更新或删除废案。</span></div></div>}
      <div className="planning-contract-proof">
        <article><span>当前快照</span><strong>{foundationContract.contract_hash ? `v${foundationContract.revision || 1}` : "无"}</strong><code>{foundationContract.contract_hash ? String(foundationContract.contract_hash).slice(0, 16) : "保存首个共创候选后建立"}</code></article>
        <article><span>基础约束</span><strong>{activeConstraints.length}</strong><code>active_constraints</code></article>
        <article><span>作者方法</span><strong>{authorMethodRules.length}</strong><code>{authorSnapshot.author_version_id ? String(authorSnapshot.author_version_id).slice(0, 16) : authorProfileHash ? authorProfileHash.slice(0, 16) : "未绑定版本"}</code></article>
        <article><span>作者倾向</span><strong>{authorTendencyRules.length}</strong><code>仅自然相合时采用</code></article>
        <article><span>硬规则</span><strong>{hardRuleCount}</strong><code>must / 不可静默跳过</code></article>
        <article><span>严格工作流</span><strong>{pendingContractUpdate ? "下次运行生效" : foundationContract.contract_hash ? "已进入输入哈希" : "等待首次保存"}</strong><code>变更会使受影响旧产物失效</code></article>
      </div>
      {pendingContractUpdate ? <ConstraintDeltaPreview delta={pendingContractUpdate} compact/> : <p className="planning-contract-empty">共创产生的长期要求会以稳定编号写入 <code>outlines/foundation-contract.json</code>。被替换或删除的旧规则只留在 audit 历史，不再进入正文 Prompt。</p>}
      {activeConstraints.length > 0 && <details className="planning-constraint-ledger"><summary><ListTree/>展开查看当前全部 {activeConstraints.length} 条生效规则（不是摘要）</summary><div>{activeConstraints.map((item: any, index) => <article key={String(item.constraint_id || index)}><header><b>{String(item.category || "未分类")}</b><span>{String(item.priority || "must")} · {String(item.scope_type || "book")}/{String(item.scope_id || "book")}</span></header><p>{String(item.rule || "")}</p><code>{String(item.constraint_id || "旧规则未编号")}</code>{item.reason && <small>{String(item.reason)}</small>}</article>)}</div></details>}
    </section>}
    {project && <ReaderFeedbackPanel project={project} scopeType={selection.level} scopeId={selection.level === "book" ? "book" : selection.id} scopeLabel={feedbackScopeLabel} generatedCount={generatedInScope} onRefresh={onRefresh}/>}
    {assistantOpen && project && <PlanningAssistant scope={selection.level} context={{bookId: project.id, book, master, chapters, selected: selectedForAI, foundationContract}} onClose={() => setAssistantOpen(false)} onApply={applyAIProposal}/>}
    {batchAssistantOpen && project && <PlanningAssistant scope="chapters" context={{bookId: project.id, book, master, chapters, selected: selectedBatchContracts, selectedChapterNumbers: selectedBatchNumbers, boundaries: batchBoundaries, clearSelectedOutline, foundationContract}} onClose={() => setBatchAssistantOpen(false)} onApply={applyBatchAIProposal}/>}
    {rebuildScope && project && <RebuildScopeDialog
      project={project}
      scopeType={rebuildScope.type}
      scopeId={rebuildScope.id}
      scopeLabel={rebuildScope.label}
      onClose={() => setRebuildScope(null)}
      onApplied={async () => { setSelection({level: "book", id: "book"}); await onRefresh(); }}
    />}
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
  const [reworkChapter, setReworkChapter] = useState<number>(0);
  const [feedbackHistory, setFeedbackHistory] = useState<WorkflowFeedback[]>([]);
  const [revisionBriefs, setRevisionBriefs] = useState<RevisionBriefRecord[]>([]);
  const [artifactBundle, setArtifactBundle] = useState<JobArtifactBundle | null>(null);
  const [artifactError, setArtifactError] = useState("");
  const [candidateBundle, setCandidateBundle] = useState<JobArtifactBundle | null>(null);
  const [contextReceipt, setContextReceipt] = useState<ContextReceipt | null>(null);
  const [chapterCockpit, setChapterCockpit] = useState<ChapterCockpit | null>(null);
  const [artifactView, setArtifactView] = useState<"artifact" | "context" | "reconcile" | "decision" | "validation" | "json">("artifact");
  const [artifactExpanded, setArtifactExpanded] = useState(false);
  const [artifactZoom, setArtifactZoom] = useState(1);
  const [now, setNow] = useState(Date.now());
  const terminalRef = useRef<HTMLDivElement>(null);
  const workflow = detail?.workflows?.[0];
  const activeRunId = String(runId || workflow?.id || "");
  const latestJob = activeRunId ? detail?.jobs?.find((item) => item.runId === activeRunId) : detail?.jobs?.[0];
  const candidateReviewer = detail?.jobs?.find((item) => (!activeRunId || item.runId === activeRunId) && item.stage === "candidate_blind_review" && item.status === "succeeded");
  const planned = (detail?.chapters || []).map((item: any) => ({...item, contract: item.contract || {}})).sort((a: any, b: any) => Number(a.chapter_number) - Number(b.chapter_number));
  const volumes = detail?.outline?.master?.volumes || [];
  const volumeGroups = volumes.map((volume) => ({volume, chapters: planned.filter((item: any) => String(item.contract?.volume_id || "volume-1") === volume.volume_id)}));
  const handledChapters = planned.filter((item: any) => chapterAlreadyHandled(String(item.status)));
  const cockpitChapter = Number(latestJob?.chapter || workflow?.current_chapter || reworkChapter || selectedChapters[0] || 0);
  const cockpitRunId = String(latestJob?.runId || activeRunId);

  useEffect(() => {
    const next = planned.find((item: any) => !chapterAlreadyHandled(String(item.status)));
    setSelectedChapters(next ? [Number(next.chapter_number)] : planned[0] ? [Number(planned[0].chapter_number)] : []);
  }, [project?.id]);
  useEffect(() => {
    setReworkChapter((current) => handledChapters.some((item: any) => Number(item.chapter_number) === current) ? current : Number(handledChapters[0]?.chapter_number || 0));
  }, [project?.id, detail?.chapters]);
  useEffect(() => {
    if (!latestJob || !["running", "queued"].includes(latestJob.status)) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [latestJob?.id, latestJob?.status]);
  useEffect(() => {
    setContextReceipt(null);
    if (!latestJob?.id) return;
    void api<ContextReceipt>(`/api/jobs/${latestJob.id}/context-receipt`).then(setContextReceipt).catch(() => setContextReceipt(null));
  }, [latestJob?.id, latestJob?.status]);
  useEffect(() => {
    setChapterCockpit(null);
    if (!project?.id || !cockpitChapter) return;
    const query = cockpitRunId ? `?runId=${encodeURIComponent(cockpitRunId)}` : "";
    void api<ChapterCockpit>(`/api/projects/${project.id}/chapters/${cockpitChapter}/cockpit${query}`).then(setChapterCockpit).catch(() => setChapterCockpit(null));
  }, [project?.id, cockpitChapter, cockpitRunId, latestJob?.id, latestJob?.status]);
  useEffect(() => {
    setCandidateBundle(null);
    if (!candidateReviewer?.id) return;
    void api<JobArtifactBundle>(`/api/jobs/${candidateReviewer.id}/artifact`).then(setCandidateBundle);
  }, [candidateReviewer?.id, candidateReviewer?.status]);

  useEffect(() => {
    setLogs([]);
    setArtifactBundle(null);
    setArtifactError("");
    if (!latestJob?.id) return;
    const source = new EventSource(`/api/jobs/${latestJob.id}/events`);
    const handler = (event: MessageEvent) => setLogs((prior) => [...prior.slice(-399), JSON.parse(event.data)]);
    source.addEventListener("message", handler as EventListener);
    return () => source.close();
  }, [latestJob?.id]);
  useEffect(() => {
    if (!latestJob?.id) return;
    let cancelled = false;
    const refresh = async () => {
      const value = await api<JobArtifactBundle>(`/api/jobs/${latestJob.id}/artifact`);
      if (!cancelled) {setArtifactBundle(value); setArtifactError("");}
    };
    const report = (error: unknown) => {if (!cancelled) setArtifactError(error instanceof Error ? error.message : String(error));};
    if (!["queued", "running"].includes(latestJob.status)) {
      void refresh().catch(report);
      return () => { cancelled = true; };
    }
    const stop = startPolling(refresh, 1800, {immediate: true, onError: report});
    return () => { cancelled = true; stop(); };
  }, [latestJob?.id, latestJob?.status]);
  useEffect(() => {
    const node = terminalRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [logs, latestJob?.error]);
  useEffect(() => {
    if (!runId) { setFeedbackHistory([]); return; }
    void api<{feedback: WorkflowFeedback[]}>(`/api/workflows/${runId}/feedback`).then((value) => setFeedbackHistory(value.feedback));
  }, [runId]);
  useEffect(() => {
    if (!project?.id) { setRevisionBriefs([]); return; }
    void api<{briefs: RevisionBriefRecord[]}>(`/api/projects/${project.id}/revision-briefs`).then((value) => setRevisionBriefs(value.briefs));
  }, [project?.id, detail?.workflows?.[0]?.id]);
  useEffect(() => {
    if (!artifactExpanded) return;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setArtifactExpanded(false); };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => { document.body.style.overflow = previousOverflow; window.removeEventListener("keydown", closeOnEscape); };
  }, [artifactExpanded]);

  const currentIndex = stages.findIndex(([key]) => key === workflow?.current_stage);
  const processEvents = logs.filter((event) => event.kind !== "assistant_text");
  const latestUsage = [...logs].reverse().find((event: JobEvent) => event.kind === "usage")?.payload;
  const start = () => run("start", async () => {
    if (!selectedChapters.length) throw new Error("请先在卷章选择器中选择本次处理章节");
    await post("/api/workflows", { bookId: project?.id, chapters: selectedChapters, maxRevisions: 5, autoRun: true });
    await onRefresh();
  });
  const continueRun = () => run("continue", async () => { await post(`/api/workflows/${runId}/run-next`); await onRefresh(); });
  const cancel = () => latestJob && run("cancel", async () => { await post(`/api/jobs/${latestJob.id}/cancel`); await onRefresh(); });
  const retry = () => latestJob && run("retry", async () => { await post(`/api/jobs/${latestJob.id}/retry`); await onRefresh(); });
  const startRevisionBrief = (brief: RevisionBriefRecord) => run(`brief-${brief.id}`, async () => {
    await post(`/api/revision-briefs/${brief.id}/start`);
    await onRefresh();
  });
  const submitFeedback = () => run("feedback", async () => {
    if (workflow?.status === "running") {
      if (!runId) throw new Error("当前工作流不存在");
      const result = await post<{feedbackHistory: WorkflowFeedback[]}>(`/api/workflows/${runId}/feedback`, {feedback});
      setFeedback(""); setFeedbackHistory(result.feedbackHistory); await onRefresh();
      return;
    }
    if (!project?.id || !reworkChapter) throw new Error("请选择需要返工的已通过章节");
    await post("/api/workflows/rework", {bookId: project.id, chapter: reworkChapter, feedback, maxRevisions: 5, autoRun: true});
    setFeedback("");
    await onRefresh();
  });

  const elapsedSeconds = latestJob?.startedAt && ["running", "queued"].includes(latestJob.status) ? Math.max(0, Math.floor((now - new Date(latestJob.startedAt).getTime()) / 1000)) : latestJob?.startedAt && latestJob.finishedAt ? Math.max(0, Math.floor((new Date(latestJob.finishedAt).getTime() - new Date(latestJob.startedAt).getTime()) / 1000)) : 0;
  const sameStageDurations = (detail?.jobs || []).filter((item) => item.stage === latestJob?.stage && item.startedAt && item.finishedAt && item.status === "succeeded").map((item) => Math.round((new Date(item.finishedAt!).getTime() - new Date(item.startedAt!).getTime()) / 1000)).sort((a, b) => a - b);
  const usualSeconds = sameStageDurations.length ? sameStageDurations[Math.floor(sameStageDurations.length / 2)] : null;
  const slow = latestJob?.status === "running" && elapsedSeconds > Math.max(120, (usualSeconds || 60) * 2);
  const taskModelRole = String(artifactBundle?.lineage?.modelRole || "");
  const taskModelProvider = String(artifactBundle?.lineage?.modelProviderId || "");
  const taskModelId = String(artifactBundle?.lineage?.modelId || "");
  const taskModelLabel = taskModelProvider ? `${taskModelProvider === "agy" ? "本地 AGY" : taskModelProvider}${taskModelId ? ` · ${taskModelId}` : ""}` : "等待模型领取";
  const stageHistory = Array.isArray((detail?.workflowState as any)?.stage_history) ? (detail?.workflowState as any).stage_history.slice(-8).reverse() : [];
  const currentContract = planned.find((item: any) => Number(item.chapter_number) === Number(workflow?.current_chapter))?.contract || planned.find((item: any) => selectedChapters.includes(Number(item.chapter_number)))?.contract;
  const currentVolume = volumes.find((item) => item.volume_id === String(currentContract?.volume_id || "volume-1"));
  const volumeReady = Boolean(currentVolume?.objective && currentVolume?.main_conflict);
  const artifactTabs = ([
    ["artifact", "阶段产物"], ["context", "上下文收据"], ["reconcile", "计划—正文对账"],
    ["decision", "判断依据"], ["validation", "交接校验"], ["json", "原始 JSON"],
  ] as Array<["artifact" | "context" | "reconcile" | "decision" | "validation" | "json", string]>);
  const renderArtifactView = () => <>
    {artifactError && <p role="alert">阶段产物加载失败：{artifactError}</p>}
    {artifactView === "artifact" && <SemanticArtifact stage={latestJob?.stage || ""} bundle={artifactBundle}/>}
    {artifactView === "context" && <ContextReceiptView receipt={contextReceipt}/>}
    {artifactView === "reconcile" && <ChapterCockpitView cockpit={chapterCockpit}/>}
    {artifactView === "decision" && <PublicRecord value={artifactBundle?.publicDecision} empty="尚无可公开判断；不会展示不可访问的隐藏思维。"/>}
    {artifactView === "validation" && <PublicRecord value={Object.keys(artifactBundle?.validationTrace || {}).length || Object.keys(artifactBundle?.lineage || {}).length ? {validationTrace: artifactBundle?.validationTrace || {}, lineage: artifactBundle?.lineage || {}} : null} empty="等待 Schema、Tomota 闸门、返工与来源链校验。"/>}
    {artifactView === "json" && (artifactBundle?.artifact ? <details open><summary>原始阶段对象</summary><pre>{JSON.stringify(artifactBundle.artifact, null, 2)}</pre></details> : <p className="muted">尚无可解析的原始 JSON。</p>)}
  </>;
  const renderArtifactTabs = () => <div className="artifact-tabs" role="tablist">
    {artifactTabs.map(([key, label]) => <button type="button" role="tab" aria-selected={artifactView === key} key={key} className={artifactView === key ? "active" : ""} onClick={() => setArtifactView(key)}>{label}</button>)}
  </div>;

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
        <div className="panel-title"><div><span>模型任务</span><strong>{latestJob ? `${stageLabel(latestJob.stage)} · ${latestJob.id}` : "等待任务"}</strong></div>{latestJob && <StatusPill value={latestJob.status}/>}</div>
        {latestJob ? <>
          <div className="job-meta"><span><BookOpen/>第 {latestJob.chapter ?? "全书"} 章</span><span><Clock3/>{fmtDate(latestJob.startedAt || latestJob.createdAt)}</span><span><Bot/>{taskModelRole === "generation" ? "生成" : taskModelRole === "workbench" ? "工作台助手" : taskModelRole ? "审查" : "模型"} · {taskModelLabel}</span><span><Fingerprint/>{latestJob.promptPath.split(/[\\/]/).pop()}</span></div>
          <div className={`runtime-summary ${slow ? "slow" : ""}`}><div><Clock3/><span><b>{Math.floor(elapsedSeconds / 60)}:{String(elapsedSeconds % 60).padStart(2, "0")}</b><small>本阶段已耗时</small></span></div><div><Gauge/><span><b>{usualSeconds ? `通常约 ${usualSeconds} 秒` : "正在建立基准"}</b><small>{slow ? "明显慢于历史同阶段；请根据下方真实事件判断停留位置" : "每个质量闸门使用独立模型会话"}</small></span></div></div>
          <div className="execution-steps"><span className="done"><Check/>装载隔离上下文</span><span className={latestJob.status === "running" ? "active" : "done"}><Bot/>分析与生成产物</span><span className={latestJob.status === "succeeded" ? "done" : "pending"}><Fingerprint/>JSON 结构检查</span><span className={latestJob.status === "succeeded" ? "done" : "pending"}><ShieldCheck/>Tomota 质量闸门</span></div>
          {latestUsage && <div className="usage-strip"><Gauge/><span>输入 {Number(latestUsage.inputTokens || 0).toLocaleString()}</span><span>输出 {Number(latestUsage.outputTokens || 0).toLocaleString()}</span><span>思考 {Number(latestUsage.thinkingTokens || 0).toLocaleString()}</span><b>{Number(latestUsage.totalTokens || 0).toLocaleString()} tokens</b><small>思考 token 仅计数，不展示隐藏原文</small></div>}
          <div className="agent-stream-layout">
            <div className="terminal" aria-live="polite">
              <div className="terminal-head"><span/><span/><span/><b>过程流 / {latestJob.stage}</b></div>
              <div className="terminal-body" ref={terminalRef}>
                {processEvents.length ? processEvents.map((event) => <p className={event.level} key={event.id}><time>{new Date(event.createdAt).toLocaleTimeString("zh-CN")}</time>{event.message}</p>) : <p className="muted">等待任务输出…</p>}
                {latestJob.error && <p className="error"><time>停止</time>{latestJob.error}</p>}
              </div>
            </div>
            <div className="generated-stream artifact-panel">
              <div className="artifact-panel-toolbar"><span>结构化产物查看器</span><button type="button" onClick={() => { setArtifactZoom(1); setArtifactExpanded(true); }} aria-label="放大查看阶段产物"><Maximize2/>放大查看</button></div>
              {renderArtifactTabs()}
              <div className="generated-body artifact-body">{renderArtifactView()}</div>
            </div>
          </div>
          {stageHistory.length > 0 && <div className="decision-trace"><div><strong>最近流程决策</strong><span>展示阶段结论与返工原因，不展示模型隐藏思维原文</span></div>{stageHistory.map((item: any, index: number) => <article key={`${item.at}-${index}`}><time>{fmtDate(item.at)}</time><b>{stageLabel(String(item.stage))}</b><p>{String(item.result || "阶段已处理")}</p></article>)}</div>}
          <div className="job-actions">
            <span>产物只有通过 Tomota 校验后才会推进流程。</span>
            {candidateReviewer && <details className="candidate-override"><summary>查看上一关键节点的自动仲裁</summary><p>独立盲审已自动选择通过方或较优方案；若双方均有阻塞项，系统会先生成第三份定向修复稿。此处只展示公开依据，不要求用户接管流程。</p>{candidateBundle?.publicDecision && <pre>{JSON.stringify(candidateBundle.publicDecision, null, 2)}</pre>}{candidateBundle?.validationTrace && <pre>{JSON.stringify(candidateBundle.validationTrace, null, 2)}</pre>}</details>}
            {["failed", "interrupted", "auth_required", "cancelled"].includes(latestJob.status) && <button className="secondary" onClick={retry} disabled={busy === "retry"}><RotateCcw/>幂等重试</button>}
          </div>
        </> : <div className="empty-state"><Bot/><h3>没有正在执行的生成任务</h3><p>启动流程后，Studio 会自动把每个独立阶段交给 Antigravity。</p></div>}
      </section>
    </div>
    <section className="panel feedback-panel">
      <div className="panel-title"><div><span>修改反馈</span><strong>{workflow?.status === "running" ? `反馈将绑定第 ${workflow.current_chapter ?? "—"} 章 · ${stageLabel(workflow.current_stage)}` : handledChapters.length ? "已通过章节也可以按新要求重新走完整质量流程" : "完成严格审查后，可从这里发起定向返工"}</strong></div><FilePenLine/></div>
      <div className="feedback-compose">
        {workflow?.status !== "running" && handledChapters.length > 0 && <label className="rework-chapter"><span>返工章节</span><select value={reworkChapter} onChange={(event) => setReworkChapter(Number(event.target.value))} aria-label="返工章节">{handledChapters.map((item: any) => <option key={item.chapter_number} value={Number(item.chapter_number)}>第 {item.chapter_number} 章 · {String(item.title)}</option>)}</select></label>}
        <textarea value={feedback} onChange={(event) => setFeedback(event.target.value)} maxLength={4000} disabled={workflow?.status !== "running" && !handledChapters.length} placeholder={workflow?.status === "running" ? "例如：姜也的语气再冷一点；删掉解释性对白；不要改动已经锁定的伏笔。" : "写清要改什么、必须保留什么，以及你不希望再次出现的问题。"} aria-label="当前阶段修改反馈"/>
        <div><span>{workflow?.status === "running" ? "提交后会保留当前流程记录，并按反馈重新执行本阶段；Tomota 质量闸门仍然有效。" : "原通过稿和审查证据会保留为历史版本；新稿从章节设计开始，重新通过全部审查后才会替换当前版本。"}</span><button className="primary" disabled={!feedback.trim() || busy === "feedback" || (workflow?.status !== "running" && !reworkChapter)} onClick={submitFeedback}>{busy === "feedback" ? <LoaderCircle className="spin"/> : <RotateCcw/>}{workflow?.status === "running" ? latestJob && ["running", "queued"].includes(latestJob.status) ? "中止当前任务并按反馈重跑" : "按反馈重跑当前阶段" : "按要求返工此章"}</button></div>
      </div>
      {feedbackHistory.length > 0 && <div className="feedback-history">{feedbackHistory.slice(0, 5).map((item) => <article key={item.id}><StatusPill value={item.status === "applied" ? "succeeded" : "queued"}/><span>第 {item.chapter ?? "—"} 章 · {stageLabel(item.stage)}</span><p>{item.content}</p></article>)}</div>}
      {revisionBriefs.length > 0 && <div className="feedback-history revision-brief-list">{revisionBriefs.slice(0, 5).map((brief) => <article key={brief.id}>
        <StatusPill value={brief.status === "pending" ? "queued" : brief.status === "started" ? "running" : "succeeded"}/>
        <div>
          <span>第 {brief.chapter} 章 · 结构化返工方案</span>
          <p>{brief.feedback}</p>
          {brief.status === "pending" && <button className="secondary small" onClick={() => void startRevisionBrief(brief)} disabled={busy === `brief-${brief.id}`}><Play/>按方案返工</button>}
        </div>
      </article>)}</div>}
    </section>
    {artifactExpanded && <div className="artifact-modal-backdrop" role="dialog" aria-modal="true" aria-label="阶段产物放大查看" onMouseDown={(event) => { if (event.target === event.currentTarget) setArtifactExpanded(false); }}>
      <section className="artifact-modal">
        <header className="artifact-modal-head"><div><span>Antigravity 公开产物</span><strong>{stageLabel(latestJob?.stage)} · {artifactTabs.find(([key]) => key === artifactView)?.[1]}</strong></div><div className="artifact-zoom-controls">
          <button type="button" onClick={() => setArtifactZoom((value) => Math.max(.8, Number((value - .1).toFixed(1))))} aria-label="缩小产物"><Minus/></button>
          <button type="button" className="zoom-value" onClick={() => setArtifactZoom(1)} aria-label="恢复百分之百缩放">{Math.round(artifactZoom * 100)}%</button>
          <button type="button" onClick={() => setArtifactZoom((value) => Math.min(1.8, Number((value + .1).toFixed(1))))} aria-label="放大产物"><ZoomIn/></button>
          <button type="button" onClick={() => setArtifactExpanded(false)} aria-label="关闭放大查看"><X/></button>
        </div></header>
        {renderArtifactTabs()}
        <div className="artifact-modal-scroll"><div className="artifact-zoom-surface" style={{"--artifact-zoom": artifactZoom} as CSSProperties}>{renderArtifactView()}</div></div>
      </section>
    </div>}
  </>;
}

function QualityLab({project, detail}: {project: ProjectSummary; detail: ProjectDetail | null}) {
  const [data, setData] = useState<{baselines: QualityBenchmark[]; runs: QualityBenchmarkRun[]}>({baselines: [], runs: []});
  const [selected, setSelected] = useState<number[]>([]);
  const [name, setName] = useState("");
  const [activeRun, setActiveRun] = useState<QualityBenchmarkRun | null>(null);
  const [rationales, setRationales] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const eligible = (detail?.chapters || []).filter((item: any) => Number(item.word_count || 0) > 0).map((item: any) => Number(item.chapter_number)).filter(Boolean);
  const load = useCallback(async () => {
    const value = await api<{baselines: QualityBenchmark[]; runs: QualityBenchmarkRun[]}>(`/api/projects/${project.id}/quality-lab`);
    setData(value);
    setActiveRun((current) => current ? value.runs.find((item) => item.id === current.id) || current : value.runs[0] || null);
  }, [project.id]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setSelected(eligible.slice(0, 6)); }, [project.id, eligible.join(",")]);
  const createBaseline = async () => {
    setBusy("baseline"); setError("");
    try { await post(`/api/projects/${project.id}/quality-lab`, {name: name.trim(), chapters: selected}); setName(""); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(""); }
  };
  const compare = async (baseline: QualityBenchmark) => {
    setBusy(baseline.id); setError("");
    try { const run = await post<QualityBenchmarkRun>(`/api/quality-lab/baselines/${baseline.id}/run`); setActiveRun(run); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(""); }
  };
  const judge = async (chapter: number, choice: "A" | "B" | "tie") => {
    if (!activeRun) return;
    const rationale = String(rationales[String(chapter)] || "").trim();
    if (!rationale) { setError("请先写明为什么这个版本更好，才能形成可复用的质量偏好"); return; }
    setBusy(`judge-${chapter}`); setError("");
    try {
      const run = await post<QualityBenchmarkRun>(`/api/quality-lab/runs/${activeRun.id}/judgment`, {chapter, choice, rationale});
      setActiveRun(run); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(""); }
  };
  return <section className="panel quality-lab">
    <div className="panel-title"><div><span>可回归章节质量</span><strong>章节质量实验室</strong></div><Gauge/></div>
    <p className="quality-lab-intro">先冻结你认可的章节版本，再与后续正文做盲测。数值只负责定位退化，最终“哪版更好”由你的阅读判断决定，不改正文、不污染 Canon。</p>
    <div className="quality-baseline-create">
      <label><span>基线名称</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：首卷定稿语感"/></label>
      <div className="quality-chapter-picks">{eligible.map((chapter) => <label key={chapter}><input type="checkbox" checked={selected.includes(chapter)} onChange={(event) => setSelected((prior) => event.target.checked ? [...prior, chapter].sort((a, b) => a - b) : prior.filter((item) => item !== chapter))}/><span>第 {chapter} 章</span></label>)}</div>
      <button className="primary" disabled={!selected.length || busy === "baseline"} onClick={() => void createBaseline()}>{busy === "baseline" ? <LoaderCircle className="spin"/> : <Save/>}保存当前正文为质量基线</button>
    </div>
    {error && <div className="assistant-error"><CircleAlert/>{error}</div>}
    <div className="quality-baselines">{data.baselines.map((baseline) => <article key={baseline.id}>
      <div><strong>{baseline.name}</strong><span>{baseline.chapters.map((item) => `第${item}章`).join("、")} · {fmtDate(baseline.createdAt)}</span></div>
      <b>自然度 {baseline.snapshot.report?.book_naturalness_score ?? "—"}</b>
      <button className="secondary small" disabled={busy === baseline.id} onClick={() => void compare(baseline)}>{busy === baseline.id ? <LoaderCircle className="spin"/> : <RefreshCw/>}与当前正文盲测</button>
    </article>)}</div>
    {activeRun && <div className="quality-blind-run">
      <div className="quality-run-head"><div><span>BLIND COMPARISON</span><strong>不标注旧版/新版，先读完再选择</strong></div><small>{Object.keys(activeRun.judgments || {}).length}/{activeRun.comparison.pairs.length} 已判断</small></div>
      {activeRun.comparison.pairs.map((pair) => {
        const judgment = activeRun.judgments?.[String(pair.chapter)];
        return <article className="quality-pair" key={pair.chapter}>
          <div className="quality-pair-title"><strong>第 {pair.chapter} 章</strong>{judgment && <span>已选择 {judgment.choice === "tie" ? "难分高下" : `版本 ${judgment.choice}`}</span>}</div>
          <div className="quality-versions">
            {(["A", "B"] as const).map((label) => <section key={label}><header><b>版本 {label}</b>{judgment && pair.truth && <span>{pair.truth[label] === "current" ? "当前正文" : "冻结基线"}</span>}</header><div>{pair[label].content}</div>{judgment && <footer>自然度 {pair[label].metrics?.naturalness_score ?? "—"} · 风险 {pair[label].metrics?.ai_flavor_risk ?? "—"}</footer>}</section>)}
          </div>
          {!judgment ? <div className="quality-judge"><textarea value={rationales[String(pair.chapter)] || ""} onChange={(event) => setRationales({...rationales, [String(pair.chapter)]: event.target.value})} placeholder="写下你判断好坏的依据：人物声音、信息控制、情绪落地、节奏或具体句段……"/><div><button className="secondary" onClick={() => void judge(pair.chapter, "A")}>A 更好</button><button className="secondary" onClick={() => void judge(pair.chapter, "tie")}>难分高下</button><button className="secondary" onClick={() => void judge(pair.chapter, "B")}>B 更好</button></div></div> : <p className="quality-rationale">你的依据：{judgment.rationale}</p>}
        </article>;
      })}
    </div>}
  </section>;
}

function WorkspaceView({ project, detail: incomingDetail, onRefresh }: {project?: ProjectSummary; detail: ProjectDetail | null; onRefresh: () => Promise<void>}) {
  const detail = incomingDetail?.book.id === project?.id ? incomingDetail : null;
  // A generation identifies a particular file load, not just its path (A→B→A).
  const fileRequest = useRef(0);
  const savingRequest = useRef<number | null>(null);
  const [selectedFile, setSelectedFile] = useState<ProjectFile | null>(null);
  const [fileValue, setFileValue] = useState<{content: string; hash: string; editable: boolean} | null>(null);
  const [persistedFileContent, setPersistedFileContent] = useState("");
  const [fileBusy, setFileBusy] = useState(false);
  const [deslopBusy, setDeslopBusy] = useState<"" | "scan" | "apply">("");
  const [deslopResult, setDeslopResult] = useState<DeslopResult | null>(null);
  const [deslopError, setDeslopError] = useState("");
  const [fileError, setFileError] = useState("");
  const [deslopQuoteMode, setDeslopQuoteMode] = useState<"keep" | "yan" | "ascii">("keep");
  const [filter, setFilter] = useState("drafts");
  const groups = useMemo(() => [...new Set((detail?.files || []).map((item) => item.category))], [detail?.files]);
  const files = (detail?.files || []).filter((item) => item.category === filter);
  const selectedChapterNumber = selectedFile?.name.match(/^chapter-(\d+)\.md$/)?.[1];
  const selectedChapterRow = selectedChapterNumber ? detail?.chapters?.find((item: any) => Number(item.chapter_number) === Number(selectedChapterNumber)) as any : null;
  const selectedDraftUnreviewed = selectedFile?.category === "drafts" && selectedChapterRow && !selectedChapterRow.review_path && ["draft_unreviewed", "legacy_unreviewed", "planned", "prompt_ready", "modified_after_review"].includes(String(selectedChapterRow.status));
  useLayoutEffect(() => {
    ++fileRequest.current; savingRequest.current = null;
    setSelectedFile(null); setFileValue(null); setPersistedFileContent(""); setFilter("drafts");
    setFileBusy(false); setDeslopBusy(""); setDeslopResult(null); setDeslopError(""); setFileError("");
    return () => { ++fileRequest.current; savingRequest.current = null; };
  }, [project?.id]);
  useEffect(() => { if (groups.length && !groups.includes(filter)) setFilter(groups[0]); }, [filter, groups]);

  const openFile = async (file: ProjectFile, resetDeslop = true) => {
    if (!detail?.files.some(item => item.path === file.path)) return;
    const request = ++fileRequest.current;
    savingRequest.current = null;
    setSelectedFile(null); setFileValue(null); setFileBusy(false); setDeslopBusy("");
    if (resetDeslop) { setDeslopResult(null); setDeslopError(""); }
    setFileError("");
    try {
      const next = await api<{content: string; hash: string; editable: boolean}>(`/api/files?path=${encodeURIComponent(file.path)}`);
      if (request !== fileRequest.current) return;
      setSelectedFile(file); setFileValue(next); setPersistedFileContent(next.content);
    } catch (cause) {
      if (request === fileRequest.current) setFileError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  useEffect(() => { const first = files[0]; if (first && (!selectedFile || selectedFile.category !== filter)) void openFile(first); }, [filter, project?.id, detail?.files]);
  const save = async () => {
    if (!selectedFile || !fileValue || !fileValue.editable || savingRequest.current !== null || deslopBusy === "apply"
      || !detail?.files.some(item => item.path === selectedFile.path)) return;
    const request = fileRequest.current;
    const submitted = fileValue;
    savingRequest.current = request;
    setFileBusy(true); setFileError("");
    try {
      const next = await api<{hash: string}>("/api/files", { method: "PUT", body: JSON.stringify({ path: selectedFile.path, content: submitted.content, expectedHash: submitted.hash }) });
      if (request !== fileRequest.current) return;
      setFileValue(current => current ? {...current, hash: next.hash} : current);
      setPersistedFileContent(submitted.content);
      await onRefresh();
    } catch (cause) {
      if (request === fileRequest.current) setFileError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (savingRequest.current === request) savingRequest.current = null;
      if (request === fileRequest.current) setFileBusy(false);
    }
  };
  const runDeslop = async (apply: boolean) => {
    if (!project || !selectedChapterNumber || fileBusy || deslopBusy || fileValue?.content !== persistedFileContent) return;
    if (apply && !window.confirm("确认应用确定性去 AI 味规范化？系统会保留修改前版本、写入审计记录，并使旧审查/发布资格失效。剧情、人物、Canon 与正式约束不会由此改写。")) return;
    setDeslopBusy(apply ? "apply" : "scan"); setDeslopError("");
    const request = fileRequest.current;
    try {
      const endpoint = `/api/projects/${project.id}/chapters/${Number(selectedChapterNumber)}/deslop`;
      const result = apply
        ? await post<DeslopResult>(endpoint, {apply: true, quoteMode: deslopQuoteMode})
        : await api<DeslopResult>(`${endpoint}?quoteMode=${deslopQuoteMode}`);
      if (request !== fileRequest.current) return;
      if (apply) {
        await onRefresh();
        if (request !== fileRequest.current) return;
        setDeslopResult(result);
        if (selectedFile) await openFile(selectedFile, false);
        return;
      }
      setDeslopResult(result);
    } catch (cause) { if (request === fileRequest.current) setDeslopError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (request === fileRequest.current) setDeslopBusy(""); }
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
          <div className="editor-head"><div><span>{selectedFile.categoryLabel}</span><strong>{selectedFile.name}</strong></div><div className="editor-head-actions">{selectedFile.category === "drafts" && selectedChapterNumber && <button className="secondary small" onClick={() => document.getElementById("chapter-reader-feedback")?.scrollIntoView({behavior: "smooth", block: "start"})}><RotateCcw/>评估并重做此章</button>}<button className="primary small" disabled={!fileValue.editable || fileBusy || deslopBusy === "apply"} onClick={() => void save()}><Save/>{fileValue.editable ? "保存版本" : "工作流资产只读"}</button></div></div>
          <textarea spellCheck={false} readOnly={!fileValue.editable || deslopBusy === "apply"} value={fileValue.content} onChange={(event) => { const content = event.target.value; setFileValue(current => current ? {...current, content} : current); }}/>
          <div className="editor-foot"><span>SHA-256 {fileValue.hash.slice(0, 16)}…</span><span>{fileValue.content !== persistedFileContent ? "尚未保存的修改" : fileValue.editable ? "保存时校验版本哈希" : "由 Tomota 状态机维护"}</span></div>
        </> : <div className="empty-state"><BookOpen/><h3>选择一份作品资产</h3><p>正文和章纲可受控编辑；Canon、审查与流程记录保持只读。</p></div>}
        {fileError && <div className="assistant-error"><CircleAlert/>{fileError}</div>}
      </section>
      <aside className="panel findings-panel">
        <div className="panel-title"><div><span>审查问题</span><strong>{selectedDraftUnreviewed ? "尚未严格审查" : `${detail?.findings?.length || 0} 条开放证据`}</strong></div></div>
        <div className="finding-list">{!selectedDraftUnreviewed && detail?.findings?.length ? detail.findings.slice(0, 30).map((finding, index) => <article key={`${finding.finding_id}-${index}`}>
          <div><span>{String(finding.gate || "review")}</span><b>{String(finding.category || "未分类")}</b></div>
          <p>“{String(finding.quote || "缺少引文") }”</p><small>{String(finding.location || "未定位")}</small><strong>{String(finding.repair_requirement || "需要明确修复要求")}</strong>
        </article>) : <div className="empty-mini">{selectedDraftUnreviewed ? <><CircleAlert/>正文已经存在，但还没有严格审查报告</> : <><Check/>当前索引中没有开放审查证据</>}</div>}</div>
      </aside>
    </div>
    {project && selectedFile?.category === "drafts" && selectedChapterNumber && <section className="panel deslop-panel">
      <div className="panel-title"><div><span>DETERMINISTIC DESLOP</span><strong>第 {Number(selectedChapterNumber)} 章 · 去 AI 味检查</strong></div><Sparkles/></div>
      <p className="deslop-intro">扫描默认只读，检查已保存正文中的模板句式、解释腔和退化风险；“应用”只执行确定性标点/引号规范化并保留修改前版本。真正的文字返工仍由严格流水线的“人物与去 AI”阶段完成，不能绕过 Canon、章节约束或审查门。</p>
      {fileValue && fileValue.content !== persistedFileContent && <div className="planning-contract-warning"><CircleAlert/><div><strong>编辑器里有尚未保存的修改</strong><span>请先保存版本，再扫描或应用；去 AI 味接口只读取磁盘中的当前版本，不能处理尚未保存的文字。</span></div></div>}
      <div className="deslop-controls">
        <label><span>引号规范</span><select value={deslopQuoteMode} onChange={(event) => setDeslopQuoteMode(event.target.value as "keep" | "yan" | "ascii")}><option value="keep">保持原样</option><option value="yan">盐言式「」</option><option value="ascii">ASCII “ ”</option></select></label>
        <button className="secondary" disabled={fileBusy || Boolean(deslopBusy) || Boolean(fileValue && fileValue.content !== persistedFileContent)} onClick={() => void runDeslop(false)}>{deslopBusy === "scan" ? <LoaderCircle className="spin"/> : <Gauge/>}只读扫描</button>
        <button className="primary" disabled={fileBusy || Boolean(deslopBusy) || Boolean(fileValue && fileValue.content !== persistedFileContent)} onClick={() => void runDeslop(true)}>{deslopBusy === "apply" ? <LoaderCircle className="spin"/> : <Save/>}明确应用规范化</button>
      </div>
      {deslopError && <div className="assistant-error"><CircleAlert/>{deslopError}</div>}
      {deslopResult && <div className="deslop-result">
        <header><strong>{deslopResult.findings.length ? `发现 ${deslopResult.findings.length} 项` : "未发现确定性问题"}</strong><span>{deslopResult.applied ? "已应用并留存版本/审计" : "只读结果，正文未修改"}</span></header>
        {deslopResult.effect_metrics && <div className="deslop-effect-metrics"><span><small>处理前密度</small><b>{deslopResult.effect_metrics.before.density_per_1000_chars}/千字</b></span><span><small>处理后密度</small><b>{deslopResult.effect_metrics.after.density_per_1000_chars}/千字</b></span><span><small>消除 / 新增</small><b>{deslopResult.effect_metrics.resolved_patterns} / {deslopResult.effect_metrics.new_patterns}</b></span><p>{deslopResult.effect_metrics.notice}</p></div>}
        {deslopResult.findings.length > 0 && <div className="deslop-findings">{deslopResult.findings.slice(0, 30).map((finding, index) => <article key={`${finding.rule_type}-${finding.line}-${finding.column}-${index}`}><span>{finding.severity} · 第 {finding.line} 行</span><b>{finding.rule_type}</b><p>{finding.message}</p>{finding.excerpt && <small>“{finding.excerpt}”</small>}</article>)}</div>}
        {deslopResult.punctuation_normalized && !deslopResult.applied && <p className="deslop-preview-note">存在可预览的标点/引号规范化差异；只有点击“明确应用规范化”才会写入。</p>}
        {deslopResult.version_path && <code>修改前版本：{deslopResult.version_path}</code>}
      </div>}
    </section>}
    {project && <QualityLab project={project} detail={detail}/>}
    {project && selectedFile?.category === "drafts" && selectedChapterNumber && <ReaderFeedbackPanel project={project} scopeType="chapter" scopeId={String(Number(selectedChapterNumber))} scopeLabel={`第 ${Number(selectedChapterNumber)} 章 · `} generatedCount={selectedChapterRow && chapterAlreadyHandled(String(selectedChapterRow.status)) ? 1 : 0} anchorId="chapter-reader-feedback" onRefresh={onRefresh}/>}
  </>;
}

function FanqieView({ project, detail, session, busy, run, setSession, onRefresh }: {project?: ProjectSummary; detail: ProjectDetail | null; session: FanqieSession | null; busy: string; run: (key: string, task: () => Promise<void>) => void; setSession: (value: FanqieSession) => void; onRefresh: () => Promise<void>}) {
  const [accounts, setAccounts] = useState<FanqieAccount[]>([]);
  const [works, setWorks] = useState<any[]>([]);
  const [platformChapters, setPlatformChapters] = useState<any[]>([]);
  const [localInfo, setLocalInfo] = useState<any>(null);
  const [workFields, setWorkFields] = useState({platformWorkId: "", title: "", synopsis: "", tags: "", coverPath: ""});
  const [workWrite, setWorkWrite] = useState<any>(null);
  const [selectedChapters, setSelectedChapters] = useState<number[]>([]);
  const [batch, setBatch] = useState<BatchPreview | null>(null);
  const [pendingBatch, setPendingBatch] = useState<BatchPreview | null>(null);
  const [publishFailure, setPublishFailure] = useState("");
  const [publishResult, setPublishResult] = useState("");
  const [publishProgress, setPublishProgress] = useState("");
  const [writeWindow, setWriteWindow] = useState<FanqieWriteWindow | null>(null);
  const [accountLabel, setAccountLabel] = useState("");
  const selectionState = useRef<{bookId: string; seenReady: Set<number>}>({bookId: "", seenReady: new Set()});
  const approved = (detail?.chapters || []).filter((item) => ["approved", "scheduled", "submitted", "published"].includes(String(item.status)) && item.review_path);
  const selectedPlatformWork = works.find((item) => item.platformId === workFields.platformWorkId);
  useEffect(() => { void api<{accounts: FanqieAccount[]}>('/api/fanqie/accounts').then((value) => setAccounts(value.accounts)); }, []);
  useEffect(() => {
    let active = true;
    const refresh = () => void api<FanqieWriteWindow>("/api/fanqie/write-window").then((value) => { if (active) setWriteWindow(value); });
    refresh();
    const timer = window.setInterval(refresh, 30_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  useEffect(() => { void api<{works: any[]; chapters: any[]}>("/api/fanqie/works").then((value) => { setWorks(value.works); setPlatformChapters(value.chapters || []); }); }, [session]);
  useEffect(() => { setAccountLabel(session?.accountLabel || ""); }, [session?.accountId, session?.accountLabel]);
  useEffect(() => {
    const bookId = project?.id;
    let cancelled = false;
    setLocalInfo(null); setBatch(null); setPendingBatch(null); setPublishFailure(""); setPublishResult(""); setWorkWrite(null);
    setWorkFields({platformWorkId: "", title: "", synopsis: "", tags: "", coverPath: ""});
    if (!bookId) return () => { cancelled = true; };
    void api<any>(`/api/fanqie/local/${bookId}`).then((value) => {
      if (cancelled) return;
      setLocalInfo(value);
      const metadata = value.book?.metadata || {};
      const platformWorks = Array.isArray(value.platformWorks) ? value.platformWorks : [];
      const bound = platformWorks.find((item: any) => item.platformId === value.boundPlatformWorkId);
      const exact = platformWorks.find((item: any) => String(item.title || "").trim() === String(value.book?.title || "").trim());
      setWorkFields({
        platformWorkId: bound?.platformId || exact?.platformId || "",
        title: String(value.book?.title || ""), synopsis: String(metadata.synopsis || ""), tags: String(metadata.genre || ""), coverPath: value.covers?.[0] || "",
      });
      setPendingBatch(value.pendingBatch || null);
    });
    return () => { cancelled = true; };
  }, [project?.id, session?.accountId, session?.checkedAt]);
  useEffect(() => {
    if (!localInfo || !works.length) return;
    setWorkFields((current) => {
      if (current.platformWorkId && works.some((item) => item.platformId === current.platformWorkId)) return current;
      const bound = works.find((item) => item.platformId === localInfo.boundPlatformWorkId);
      const exact = works.find((item) => String(item.title || "").trim() === String(localInfo.book?.title || project?.title || "").trim());
      const match = bound || exact;
      return match ? {...current, platformWorkId: match.platformId} : current;
    });
  }, [localInfo, works, project?.title]);
  const approvedKey = approved.map((item) => `${item.chapter_number}:${item.status}:${item.content_hash || item.word_count}`).join("|");
  useEffect(() => {
    const bookId = project?.id || "";
    const ready = approved.filter((item) => String(item.status) === "approved").map((item) => Number(item.chapter_number));
    if (selectionState.current.bookId !== bookId) {
      selectionState.current = {bookId, seenReady: new Set(ready)};
      setSelectedChapters(ready);
      return;
    }
    const newReady = ready.filter((number) => !selectionState.current.seenReady.has(number));
    selectionState.current.seenReady = new Set([...selectionState.current.seenReady, ...ready]);
    const readySet = new Set(ready);
    setSelectedChapters((prior) => [...new Set([...prior.filter((number) => readySet.has(number)), ...newReady])].sort((left, right) => left - right));
  }, [project?.id, approvedKey]);

  const login = () => run("login", async () => setSession(await post("/api/fanqie/login/open")));
  const switchAccount = (accountId: string) => run("account-switch", async () => {
    const result = await post<{accounts: FanqieAccount[]; session: FanqieSession}>(`/api/fanqie/accounts/${accountId}/switch`);
    setAccounts(result.accounts); setSession(result.session); setWorks(result.session.visibleWorks); setPlatformChapters([]); setWorkWrite(null); setBatch(null); setPublishFailure("");
  });
  const addAccount = () => run("account-add", async () => {
    const result = await post<{accounts: FanqieAccount[]; session: FanqieSession}>("/api/fanqie/accounts", {label: `番茄账号 ${accounts.length + 1}`});
    setAccounts(result.accounts); setSession(result.session); setWorks([]); setPlatformChapters([]);
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
    const confirmation = await textConfirmation(`只归档 Tomota 中的账号入口，不删除浏览器资料，也不影响番茄云端。\n请输入：${expected}`) || "";
    if (!confirmation) return;
    const result = await post<{accounts: FanqieAccount[]; session: FanqieSession}>(`/api/fanqie/accounts/${session.accountId}/archive`, {confirmation});
    setAccounts(result.accounts); setSession(result.session); setWorks(result.session.visibleWorks); setBatch(null); setPublishFailure("");
  });
  const sync = () => run("sync", async () => {
    const result = await post<{session: FanqieSession; works: any[]}>("/api/fanqie/sync", { bookIds: project ? [project.id] : [] });
    setSession(result.session); setWorks(result.works); setPlatformChapters((result as any).chapters || []); setBatch(null); setPublishFailure("");
    if (project?.id) {
      const local = await api<any>(`/api/fanqie/local/${project.id}`);
      setLocalInfo(local); setPendingBatch(local.pendingBatch || null);
    }
  });
  const prepare = () => run("prepare", async () => {
    setBatch(null); setPublishFailure(""); setPublishResult("");
    if (pendingBatch) { setBatch(pendingBatch); return; }
    const preview = await post<BatchPreview>("/api/fanqie/batches/preview", {bookId: project?.id, platformWorkId: workFields.platformWorkId, chapters: selectedChapters});
    setPendingBatch(preview); setBatch(preview);
  });
  const previewWorkWrite = () => run("work-preview", async () => setWorkWrite(await post("/api/fanqie/works/preview-write", {bookId: project?.id, platformWorkId: workFields.platformWorkId, fields: {title: workFields.title, synopsis: workFields.synopsis, tags: workFields.tags, coverPath: workFields.coverPath}})));
  const executeWorkWrite = () => workWrite && run("work-write", async () => {
    const confirmation = String(workWrite.confirmation || `WRITE ${workWrite.id}`);
    await post(`/api/fanqie/batches/${workWrite.id}/confirm`, {operation: "write", token: confirmation});
    const result = await post<any>(`/api/fanqie/works/${workWrite.id}/execute`, {confirmation});
    setWorkWrite(null);
    if (result.status !== "submitted") throw new Error(result.message || "平台未返回明确成功状态");
  });
  const executeLockedBatch = async (lockedBatch: BatchPreview) => {
    if (!writeWindow?.allowed) throw new Error(writeWindow?.message || "正在核对番茄可提交时间，请稍后再试");
    // Clicking the final upload button is the user's action-time confirmation.
    // Machine-bound tokens are derived from the currently visible batch so a
    // previous preview can never leave stale confirmation text behind.
    const publish = `PUBLISH ${lockedBatch.batch_id}`;
    const write = `WRITE ${lockedBatch.batch_id}`;
    try {
      setPublishProgress("正在锁定本次作品、章节与正文哈希…");
      await post(`/api/fanqie/batches/${lockedBatch.batch_id}/confirm`, { operation: "publish", token: publish });
      await post(`/api/fanqie/batches/${lockedBatch.batch_id}/confirm`, { operation: "write", token: write });
      const chapterConfirmations: Record<string, string> = {};
      for (const chapter of lockedBatch.chapters) {
        const token = `SUBMIT ${lockedBatch.batch_id}:${chapter.chapter_number}:${chapter.content_fingerprint.slice(0, 12)}`;
        await post(`/api/fanqie/batches/${lockedBatch.batch_id}/confirm`, { operation: "submit", token, chapter: chapter.chapter_number, hash: chapter.content_fingerprint });
        chapterConfirmations[String(chapter.chapter_number)] = token;
      }
      setPublishProgress("预检已通过，正在打开番茄编辑器并逐章写入；遇到登录、验证码或不确定结果会安全暂停。");
      const result = await post<Record<string, unknown>>(`/api/fanqie/batches/${lockedBatch.batch_id}/execute`, { confirmation: publish, actionConfirmation: write, chapterConfirmations });
      await onRefresh(); setSession(await api("/api/fanqie/session"));
      if (String(result.status) !== "submitted") throw new Error(String(result.message || "平台未返回明确成功状态；请先同步，勿重复上传"));
      setPublishProgress(""); setPublishFailure(""); setBatch(null); setPendingBatch(null); setPublishResult(`批次 ${lockedBatch.batch_id} 已提交，正在等待番茄审核状态同步。`);
    } catch (error) {
      setPublishProgress("");
      setPublishFailure(error instanceof Error ? error.message : String(error));
      throw error;
    }
  };
  const confirmAndExecute = () => batch && run("execute", async () => executeLockedBatch(batch));
  const reconcilePending = () => pendingBatch && run("pending-reconcile", async () => {
    const result = await post<Record<string, unknown>>(`/api/fanqie/batches/${pendingBatch.batch_id}/reconcile`);
    const status = String(result.status || "unknown");
    if (project?.id) {
      const local = await api<any>(`/api/fanqie/local/${project.id}`);
      setLocalInfo(local); setPendingBatch(local.pendingBatch || null);
    }
    setPublishResult(status === "submitted" ? `批次 ${pendingBatch.batch_id} 已核对为提交成功。` : `批次 ${pendingBatch.batch_id} 同步结果：${status}`);
  });
  const abandonPending = () => pendingBatch && run("pending-abandon", async () => {
    if (!window.confirm(`废弃本地待确认批次 ${pendingBatch.batch_id}？\n不会删除本地正文或番茄云端内容，之后可按当前正文重新生成批次。`)) return;
    await post(`/api/fanqie/batches/${pendingBatch.batch_id}/abandon`);
    setBatch(null); setPendingBatch(null); setPublishFailure("");
    setPublishResult(`批次 ${pendingBatch.batch_id} 已废弃，可以按当前章节重新生成。`);
  });
  const resolveOneClickBatch = async (): Promise<OneClickBatchResolution> => {
    const request = () => post<OneClickBatchResolution>("/api/fanqie/batches/one-click", {bookId: project?.id, platformWorkId: workFields.platformWorkId, chapters: selectedChapters});
    try { return await request(); }
    catch (error) {
      if (!(error instanceof ApiError) || error.code !== "browser_profile_in_use") throw error;
      const accountId = String(error.details.accountId || session?.accountId || "");
      const confirmation = String(error.details.takeoverConfirmation || `TAKEOVER ${accountId}`);
      if (!accountId) throw error;
      const takeover = await post<{session: FanqieSession}>(`/api/fanqie/accounts/${accountId}/takeover`, {confirmation});
      setSession(takeover.session);
      setPublishResult("已接管旧版遗留的 Tomota 专用浏览器，会话资料与登录状态保持不变；正在继续提交。");
      return request();
    }
  };
  const oneClickPublish = () => run("one-click-publish", async () => {
    try {
      setBatch(null); setPublishFailure(""); setPublishResult("");
      if (!project?.id || !workFields.platformWorkId || !selectedChapters.length) throw new Error("请先确认目标作品并选择章节");
      setPublishProgress("正在核验登录、目标作品、平台章节目录、旧批次结果与当前正文哈希…");
      let resolution = await resolveOneClickBatch();
      if (!resolution.batch) {
        setPublishProgress(""); setBatch(null); setPendingBatch(null); setPublishResult(resolution.message);
        await onRefresh();
        return;
      }
      setPublishProgress(`批次已${resolution.disposition === "rebuilt" ? "重建" : resolution.disposition === "resumed" ? "恢复" : "创建"}，正在执行写入前锁定…`);
      setPendingBatch(resolution.batch); setBatch(resolution.batch); setPublishResult(resolution.message);
      try { await executeLockedBatch(resolution.batch); }
      catch (error) {
        if (!(error instanceof ApiError) || !["stale_batch", "stale_platform_state"].includes(error.code)) throw error;
        await post(`/api/fanqie/batches/${resolution.batch.batch_id}/abandon`);
        setPublishProgress("检测到正文或平台目录变化，正在安全作废旧预览并重建…"); setPublishFailure(""); setBatch(null); setPendingBatch(null);
        resolution = await resolveOneClickBatch();
        if (!resolution.batch) { setPublishProgress(""); setPublishResult(resolution.message); await onRefresh(); return; }
        setPendingBatch(resolution.batch); setBatch(resolution.batch); setPublishResult(`提交前检测到输入变化，已自动重建：${resolution.message}`);
        await executeLockedBatch(resolution.batch);
      }
    }
    catch (error) {
      setPublishProgress("");
      throw error;
    }
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
        {!workWrite ? <button className="secondary metadata-preview" disabled={!workFields.platformWorkId || busy === "work-preview"} onClick={previewWorkWrite}><FilePenLine/>生成资料写入预览</button> : <div className="work-write-confirm"><div><span>将修改</span><strong>{workWrite.changedFields?.join("、")}</strong><code>{workWrite.payloadHash?.slice(0, 20)}…</code></div><p><ShieldCheck/>已锁定本次资料与封面哈希，点击即确认写入。</p><button className="danger-write" disabled={busy === "work-write"} onClick={executeWorkWrite}><UploadCloud/>确认写入</button><button className="secondary" onClick={() => setWorkWrite(null)}>取消</button></div>}
      </section> : <section className="panel fanqie-next"><BookOpen/><div><strong>先完成登录与同步</strong><p>读到平台作品后，这里才会显示资料、封面和章节发布操作。</p></div></section>}
      {works.length > 0 && approved.length > 0 && <section className="panel release-panel">
        <div className="panel-title"><div><span>自动化发布与替换</span><strong>{approved.length} 章持有严格审查证据</strong></div><ShieldCheck/></div>
        <div className="publish-options immediate-publish-note">
          <p><ShieldCheck/>一键提交统一立即送交番茄审核，不创建定时排期。平台写入前仍会核对正文哈希、目标章节和提交结果；番茄章节修改仅在北京时间 07:00—24:00 开放。</p>
        </div>
        <div className="chapter-select">{approved.map((chapter) => { const number = Number(chapter.chapter_number); const ready = String(chapter.status) === "approved"; return <label key={number} className={ready ? "" : "handled"}><input type="checkbox" disabled={!ready} checked={ready && selectedChapters.includes(number)} onChange={(event) => setSelectedChapters((prior) => event.target.checked ? [...new Set([...prior, number])].sort((left, right) => left - right) : prior.filter((item) => item !== number))}/><span>第 {number} 章</span><strong>{String(chapter.title)}</strong><small>{ready ? `${Number(chapter.word_count).toLocaleString()} 字 · 可提交` : statusLabel(String(chapter.status))}</small></label>; })}</div>
        {!workFields.platformWorkId && <div className="publish-binding-warning"><CircleAlert/><span>当前本地作品尚未关联平台作品。请先在上方明确选择，系统不会默认拿第一本书代替。</span></div>}
        {selectedPlatformWork && selectedPlatformWork.title !== project?.title && <div className="publish-binding-warning danger"><CircleAlert/><span>本地《{project?.title}》将写入平台《{selectedPlatformWork.title}》。若不是有意改名，请勿继续。</span></div>}
        {pendingBatch && <div className="pending-batch-recovery">
          <div><ShieldCheck/><span><strong>有一批已锁定、尚待确认的章节</strong><small>{pendingBatch.batch_id} · 写入《{pendingBatch.platform_work_title || "已绑定平台作品"}》 · {pendingBatch.chapters.map((chapter) => `第 ${chapter.chapter_number} 章`).join("、")}</small><small>你可以继续核对并提交、同步平台结果，或废弃本地预览后按当前正文重建；不会再被一条无法处理的提示卡住。</small></span></div>
          <div><button className="secondary small" onClick={() => setBatch(pendingBatch)}><Send/>继续核对</button><button className="secondary small" disabled={busy === "pending-reconcile"} onClick={reconcilePending}><RefreshCw className={busy === "pending-reconcile" ? "spin" : ""}/>同步此批次</button><button className="secondary small pending-abandon" disabled={busy === "pending-abandon"} onClick={abandonPending}><RotateCcw/>废弃并重建</button></div>
        </div>}
        {publishProgress && <div className="publish-progress"><LoaderCircle className="spin"/><span>{publishProgress}</span></div>}
        {publishResult && <div className="publish-success"><Check/><span>{publishResult}</span></div>}
        <div className="publish-actions"><button className="secondary" disabled={!selectedPlatformWork || !selectedChapters.length || busy === "prepare" || busy === "one-click-publish"} onClick={prepare}><Send/>{pendingBatch ? "打开待确认批次" : "仅生成核对预览"}</button><button className="danger-write one-click-publish" disabled={!selectedPlatformWork || !selectedChapters.length || busy === "one-click-publish" || writeWindow?.allowed !== true} onClick={oneClickPublish}>{busy === "one-click-publish" ? <LoaderCircle className="spin"/> : <UploadCloud/>}{writeWindow?.allowed === false ? "当前不在番茄可写时间" : pendingBatch ? `一键恢复/重建并提交 ${selectedChapters.length} 章` : `一键上传/替换并提交 ${selectedChapters.length} 章`}</button></div>
      </section>}
    </div>
    {batch && <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="发布批次确认"><div className="batch-modal">
      <div className="modal-head"><div><p className="eyebrow">ACTION-TIME CONFIRMATION</p><h2>核对并即时确认</h2></div><button className="icon-button" onClick={() => { setBatch(null); setPublishFailure(""); }}><X/></button></div>
      <div className="batch-summary"><span>作品<strong>{batch.book_title}</strong><small>写入平台《{batch.platform_work_title || selectedPlatformWork?.title || "未识别"}》 · ID {batch.platform_work_id}</small></span><span>批次<strong>{batch.batch_id}</strong></span><span>章节<strong>{batch.chapters.length}</strong></span></div>
      <div className="batch-chapters">{batch.chapters.map((chapter) => <article key={chapter.chapter_number}><div><b>第 {chapter.chapter_number} 章</b><strong>{chapter.title}</strong><small>{chapter.operation === "update" ? `替换已发布版本${chapter.platform_word_count ? ` · ${chapter.platform_word_count.toLocaleString()} 字 → ${chapter.word_count.toLocaleString()} 字` : ""}` : "立即提交审核"}</small></div><span className={chapter.operation === "update" ? "operation-update" : ""}>{chapter.operation === "update" ? "替换" : `${chapter.word_count.toLocaleString()} 字`}</span><code>{chapter.content_fingerprint.slice(0, 16)}…</code></article>)}</div>
      <div className="upload-confirmation">
        <ShieldCheck/>
        <div><strong>当前批次已自动锁定</strong><p>系统已绑定作品、章节、正文哈希与立即提交方式。点击下方按钮即确认只上传本弹窗列出的内容，无需手动填写口令。</p></div>
      </div>
      {writeWindow && !writeWindow.allowed && <div className="publish-window-blocked"><Clock3/><div><strong>今晚只保留预览，不执行平台写入</strong><p>{writeWindow.message}</p><small>页面会自动检查时间窗，明早 07:00 后按钮自动恢复。</small></div></div>}
      {publishFailure && <div className="publish-attempt-failure"><CircleAlert/><div><strong>本次上传已停止</strong><p>{publishFailure}</p><small>请关闭弹窗并点击“同步”，核对平台状态后再生成新批次。</small></div></div>}
      <div className="modal-foot"><p><ShieldCheck/>网络、登录、时间窗或页面状态不明确时会立即停止，不会盲目重试。</p><button className="danger-write" onClick={confirmAndExecute} disabled={busy === "execute" || Boolean(publishFailure) || writeWindow?.allowed !== true}>{busy === "execute" ? <LoaderCircle className="spin"/> : <UploadCloud/>}{writeWindow?.allowed === false ? "明早 07:00 后可提交" : `确认${batch.chapters.some((chapter) => chapter.operation === "update") ? "替换/上传" : "上传"}这 ${batch.chapters.length} 章`}</button></div>
    </div></div>}
  </>;
}


function BookSettingsView({ project, busy, run }: {project?: ProjectSummary; busy: string; run: (key: string, task: () => Promise<void>) => void}) {
  const [cleanup, setCleanup] = useState<any>(null);
  const [applyText, setApplyText] = useState("");
  const [preferences, setPreferences] = useState<AuthorPreference[]>([]);
  const preview = () => project && run("cleanup-preview", async () => setCleanup(await post(`/api/cleanup/${project.id}`, {apply: false})));
  const apply = () => project && run("cleanup-apply", async () => { if (applyText !== "APPLY CLEANUP") throw new Error("请输入 APPLY CLEANUP 才能执行清理"); setCleanup(await post(`/api/cleanup/${project.id}`, {apply: true})); setApplyText(""); });
  useEffect(() => { if (project) void api<{preferences: AuthorPreference[]}>(`/api/projects/${project.id}/preferences`).then((value) => setPreferences(value.preferences)); }, [project]);
  const updatePreference = (preference: AuthorPreference, changes: Partial<AuthorPreference>) => run("preference-update", async () => {
    if (!project) throw new Error("请选择作品");
    const value = await put<{preferences: AuthorPreference[]}>(`/api/projects/${project.id}/overrides/${preference.id}`, changes);
    setPreferences(value.preferences);
  });
  const deletePreference = (preference: AuthorPreference) => run("preference-delete", async () => {
    if (!project) throw new Error("请选择作品");
    const value = await del<{preferences: AuthorPreference[]}>(`/api/projects/${project.id}/overrides/${preference.id}`);
    setPreferences(value.preferences);
  });
  return <>
    <section className="section-head large"><div><p className="eyebrow">BOOK POLICY</p><h1>作品设置</h1><p>{project ? `《${project.title}》的作者绑定、局部文风覆盖与本地回收区。` : "请选择作品后管理该书设置。"}</p></div></section>
    <div className="settings-grid book-settings-grid">
      <section className="panel book-author-settings-card">
        <div className="panel-title"><div><span>本书作者与文风</span><strong>{project?.title || "请选择作品"}</strong></div><Link2/></div>
        <p className="settings-card-intro">从作品方向选择作者版本；与作者空间共用同一套差异预览、确认绑定和运行快照校验。</p>
        <BookAuthorBindingPanel project={project} busy={busy} run={run}/>
      </section>
      <section className="panel preference-card">
        <div className="panel-title"><div><span>本书文风覆盖规则</span><strong>{project?.title || "请选择作品"}</strong></div><Sparkles/></div>
        <p>这是作者版本之上的本书局部覆盖；Canon、章节事实、审查门与发布规则始终优先。旧作者偏好已去重迁移，原表只读保留。</p>
        {preferences.length ? <div className="preference-list">{preferences.map((preference) => <article key={preference.id}>
          <div className="preference-title"><b>{preference.category}</b><StatusPill value={preference.enabled ? "succeeded" : "idle"}/></div>
          <p>{preference.rule}</p>
          <small>来源证据：{preference.evidence}</small>
          <div className="preference-actions">
            <button className="secondary small" onClick={() => void updatePreference(preference, {enabled: !preference.enabled})} disabled={busy === "preference-update"}>{preference.enabled ? "停用" : "启用"}</button>
            <button className="danger-write small" onClick={() => void deletePreference(preference)} disabled={busy === "preference-delete"}><Trash2/>删除</button>
          </div>
        </article>)}</div> : <p className="empty-note">暂无作者偏好。可以在工作台 AI 中把重复反馈沉淀为规则。</p>}
      </section>
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
