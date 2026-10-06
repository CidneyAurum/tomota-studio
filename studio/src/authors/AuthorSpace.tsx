import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, BookOpen, Bot, Check, ChevronRight, CircleAlert, Code2,
  Copy, FileText, Fingerprint, GitCompare, LibraryBig, Link2, LoaderCircle, MessageSquareText, PencilLine, Plus,
  Save, Search, Settings2, ShieldCheck, Sparkles, Trash2, UploadCloud, UserRound,
} from "lucide-react";
import { Link, NavLink, Navigate, Outlet, Route, Routes, useNavigate, useOutletContext, useParams, useSearchParams } from "../router";

import { api, del, post, put, uploadAuthorSource } from "../api";
import type {
  AgentJob, AuthorBindingAudit, AuthorProfile, AuthorProfileSummary, AuthorSource, AuthorStyleProfile,
  AuthorMethodReference, AuthorPersona, AuthorStyleDimension, AuthorStyleRule, AuthorVersion, JobArtifactBundle, JobEvent, PersonalTalk, ProjectDetail, ProjectSummary,
} from "../types";

type Run = (key: string, task: () => Promise<void>) => void;

export interface AuthorSpaceProps {
  authors: AuthorProfileSummary[];
  projects: ProjectSummary[];
  busy: string;
  run: Run;
  refreshAuthors: () => Promise<void>;
  onOpenProject: (bookId: string) => void;
}

interface AuthorDetailContext extends AuthorSpaceProps {
  author: AuthorProfile;
  refreshAuthor: () => Promise<void>;
}

interface CandidateBundle {
  job: AgentJob;
  artifact: Record<string, unknown> | null;
  candidateVersion: AuthorVersion | null;
  events: JobEvent[];
  pipeline: {
    run_id: string; phase: string; total_sources: number; completed_sources: number; current_source_id: string | null;
    total_batches: number; completed_batches: number; total_characters: number; completed_characters: number;
    coverage_percent: number; source_batch_index: number | null; source_batch_count: number | null; full_text_required: boolean;
    evidence_count: number; segment_portrait_count: number; phase_portrait_count: number; work_portrait_count: number; source_cache_hits: number;
    verify_group_count: number | null; verified_group_count: number; verified_dimension_count: number; duplicate_group_recoveries: number;
    pipeline_status: "running" | "advancing" | "retrying" | "completed" | "failed";
  } | null;
}

interface DistillationEvidenceTrace {
  id: string; sourceId: string; segmentId: string | null; phaseId: string | null;
  lineStart: number; lineEnd: number; exactQuote: string; axis: string; observationKind: string;
}

interface DistillationPortraitTrace {
  id: string; sourceId: string; level: "segment" | "phase" | "work"; scopeId: string;
  parentScopeId: string | null; profile: Record<string, unknown>;
}

const objectSections: Array<{key: keyof AuthorStyleProfile; title: string; hint: string; seeds: string[]}> = [
  {key: "narrative", title: "叙事视角与距离", hint: "视角、叙述距离与镜头习惯", seeds: ["pov", "distance", "camera"]},
  {key: "rhythm", title: "句段节奏", hint: "句长、段落和阅读速度", seeds: ["sentence", "paragraph"]},
  {key: "dialogue", title: "对白策略", hint: "对白密度、潜台词与信息承载", seeds: ["density", "subtext"]},
  {key: "character_voice", title: "人物换声", hint: "称呼、句长、词汇和知识边界", seeds: ["rule"]},
  {key: "emotion", title: "情绪落地", hint: "动作、感官与克制方式", seeds: ["rule"]},
  {key: "scene_pacing", title: "场景推进", hint: "目标、阻碍、变化与关系推进", seeds: ["rule"]},
  {key: "story_design", title: "故事设计契约", hint: "故事核、人物弧、关系、冲突、揭示和世界规则", seeds: ["premise", "protagonist", "relationship", "conflict", "revelation", "worldbuilding"]},
];

const dimensionArraySections: Array<{key: "story_design" | "book_architecture"; field: string; axis: string; title: string; hint: string}> = [
  {key: "story_design", field: "worldbuilding_mechanics", axis: "worldbuilding_mechanics", title: "世界观机制方法", hint: "机制、限制、代价、例外与权力结构的设计方法（只蒸馏方法，不复述设定）"},
  {key: "story_design", field: "character_design_mechanics", axis: "character_design_mechanics", title: "人设机制方法", hint: "欲望、限制、代价、身份压力与选择机制的设计方法"},
  {key: "book_architecture", field: "volume", axis: "volume_architecture", title: "分卷结构方法", hint: "分卷目标、升级、兑现与下一卷入口"},
  {key: "book_architecture", field: "chapter", axis: "chapter_architecture", title: "章节结构方法", hint: "章目标、阻碍、变化、钩子与下一章第一拍"},
  {key: "book_architecture", field: "scene", axis: "scene_causality", title: "场景结构方法", hint: "场景进入、价值变化、退出与因果交接"},
  {key: "book_architecture", field: "serial", axis: "serial_rhythm", title: "连载节奏方法", hint: "长线连载的节奏波形与防中段失速"},
];

const listSections: Array<{key: keyof AuthorStyleProfile; title: string; hint: string}> = [
  {key: "openings", title: "开篇习惯", hint: "每行一条可执行规则"},
  {key: "transitions", title: "转场方式", hint: "如何承接人物状态与因果"},
  {key: "endings", title: "章末策略", hint: "选择、代价、揭示或下一步动作"},
  {key: "lexical_preferences", title: "语言倾向", hint: "偏好的中文表达与用词边界"},
  {key: "forbidden_patterns", title: "明确禁忌", hint: "AI 套话、翻译腔和模板化表达"},
  {key: "platform_constraints", title: "平台约束", hint: "纯文字成立、移动端阅读等"},
  {key: "genre_tendencies", title: "题材倾向", hint: "偏好但不能覆盖 Canon 的题材习惯"},
];

const blankProfile = (): AuthorStyleProfile => ({
  narrative: {pov: "", distance: "", camera: ""}, rhythm: {sentence: "", paragraph: ""},
  dialogue: {density: "", subtext: ""}, character_voice: {rule: ""}, emotion: {rule: ""}, scene_pacing: {rule: ""},
  story_design: {premise: "", protagonist: "", relationship: "", conflict: "", revelation: "", worldbuilding: "", worldbuilding_mechanics: [], character_design_mechanics: []},
  book_architecture: {volume: [], chapter: [], scene: [], serial: []},
  openings: [], transitions: [], endings: [], lexical_preferences: [], forbidden_patterns: [],
  platform_constraints: [], genre_tendencies: [], rules: [{category: "通用文风", rule: ""}],
});

const blankDimension = (axis: string): AuthorStyleDimension => ({
  id: `${axis}-${Math.random().toString(36).slice(2, 8)}`, axis, label: "", finding: "", trigger: "",
  writing_instruction: "", implementation_steps: [], allowed_variations: [], acceptance_tests: [],
  avoid: "", scope: "author_core", confidence: 60, stability: 50,
  applies_to: axis === "volume_architecture" ? ["volume_design"] : axis === "serial_rhythm" ? ["volume_design", "chapter_design"] : ["chapter_design"], evidence_ids: [],
});

function asProfile(value: unknown): AuthorStyleProfile {
  const raw = value && !Array.isArray(value) && typeof value === "object" ? value as Record<string, unknown> : {};
  const result = blankProfile();
  for (const section of objectSections) {
    const current = raw[section.key];
    if (current && !Array.isArray(current) && typeof current === "object") {
      result[section.key] = Object.fromEntries(Object.entries(current).map(([key, item]) => [key, Array.isArray(item) ? item : String(item ?? "")])) as never;
    }
  }
  for (const section of listSections) {
    const current = raw[section.key];
    result[section.key] = (Array.isArray(current) ? current.map(String) : []) as never;
  }
  result.rules = Array.isArray(raw.rules) ? raw.rules.map((item) => item && !Array.isArray(item) && typeof item === "object"
    ? {...(item as Record<string, unknown>), category: String((item as Record<string, unknown>).category || "文风"), rule: String((item as Record<string, unknown>).rule || ""), evidence: String((item as Record<string, unknown>).evidence || "")} as AuthorStyleRule
    : {category: "文风", rule: String(item)}) : result.rules;
  if (Array.isArray(raw.style_dimensions)) result.style_dimensions = raw.style_dimensions as AuthorStyleDimension[];
  if (raw.statistical_signature && !Array.isArray(raw.statistical_signature) && typeof raw.statistical_signature === "object") result.statistical_signature = raw.statistical_signature as AuthorStyleProfile["statistical_signature"];
  if (raw.application_blueprint && !Array.isArray(raw.application_blueprint) && typeof raw.application_blueprint === "object") result.application_blueprint = raw.application_blueprint as AuthorStyleProfile["application_blueprint"];
  if (raw.distillation_quality && !Array.isArray(raw.distillation_quality) && typeof raw.distillation_quality === "object") result.distillation_quality = raw.distillation_quality as AuthorStyleProfile["distillation_quality"];
  if (raw.provenance && !Array.isArray(raw.provenance) && typeof raw.provenance === "object") result.provenance = raw.provenance as Record<string, unknown>;
  return result;
}

function profileErrors(profile: AuthorStyleProfile): string[] {
  const errors: string[] = [];
  for (const section of objectSections) {
    if (!profile[section.key] || Array.isArray(profile[section.key]) || typeof profile[section.key] !== "object") errors.push(`${section.title}必须是结构化对象`);
  }
  for (const section of listSections) if (!Array.isArray(profile[section.key])) errors.push(`${section.title}必须是列表`);
  if (!Array.isArray(profile.rules) || !profile.rules.some((item) => item.rule.trim())) errors.push("至少需要一条非空的可执行规则");
  if (profile.style_dimensions && profile.style_dimensions.some((item) => !item.id || !item.writing_instruction || item.confidence < 0 || item.confidence > 100 || item.stability < 0 || item.stability > 100)) errors.push("深度风格维度缺少编号、写作指令或有效置信度/稳定度");
  if (profile.provenance?.kind === "distilled" && profile.style_dimensions?.some((item) => !item.axis || !item.trigger || !item.implementation_steps?.length || !item.allowed_variations?.length || !item.acceptance_tests?.length)) errors.push("蒸馏指纹必须填写指纹轴、调用条件、执行步骤、允许变化和验收点");
  if (profile.provenance?.ledger_run_id) {
    const ids = new Set((profile.style_dimensions || []).map((item) => item.id));
    if (profile.style_dimensions?.some((item) => !Array.isArray(item.failure_modes) || !Array.isArray(item.non_applicable_cases) || !Array.isArray(item.counterevidence_ids) || !item.transfer_test || item.transfer_test.trials.length < 2)) errors.push("证据账本版本必须保留失败方式、不适用条件、反例证据和两个题材迁移测试");
    for (const section of dimensionArraySections) {
      const group = profile[section.key]?.[section.field];
      if (Array.isArray(group) && group.some((item) => item && typeof item === "object" && "dimension_id" in item && !ids.has(String((item as AuthorMethodReference).dimension_id)))) errors.push(`${section.title}引用了不存在的完整维度`);
    }
  }
  return errors;
}

const fmt = (value?: string | null) => value ? new Intl.DateTimeFormat("zh-CN", {month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"}).format(new Date(value)) : "—";
const bytes = (value: number) => value < 1024 * 1024 ? `${Math.max(1, value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`;
const statusText = (value: string) => ({active: "使用中", archived: "已归档", draft: "草稿", published: "已发布"} as Record<string, string>)[value] || value;
const fullDistillationStages = new Set(["author_style_full_read", "author_style_phase_portrait", "author_style_work_reduce", "author_style_verify"]);

function distillationCertification(version?: AuthorVersion): "certified" | "legacy" | "not_applicable" {
  if (!version || version.profile.provenance?.kind !== "distilled") return "not_applicable";
  const dimensions = version.profile.style_dimensions || [];
  const axes = new Set(dimensions.map((item) => item.axis).filter(Boolean));
  const evidence = Array.isArray(version.profile.provenance.evidence) ? version.profile.provenance.evidence : [];
  const minimumEvidence = Math.max(16, version.source_manifest.length * 3);
  return Number(version.profile.distillation_quality?.corpus_coverage) === 100
    && dimensions.length >= 16 && axes.size >= 12 && evidence.length >= minimumEvidence ? "certified" : "legacy";
}

function StateTag({value}: {value: string}) {
  return <span className={`author-state author-state-${value}`}>{statusText(value)}</span>;
}

function useCandidateJob(job: AgentJob | null, onSucceeded: () => Promise<void>) {
  const [bundle, setBundle] = useState<CandidateBundle | null>(null);
  const completed = useRef("");
  useEffect(() => {
    if (!job?.id) { setBundle(null); return; }
    let cancelled = false;
    let timer = 0;
    const refresh = async () => {
      const value = await api<CandidateBundle>(`/api/author-jobs/${job.id}`);
      if (cancelled) return;
      setBundle(value);
      const finalSuccess = value.job.status === "succeeded" && Boolean(value.candidateVersion);
      if (finalSuccess && completed.current !== value.job.id) {
        completed.current = value.job.id;
        await onSucceeded();
      }
      const pipelinePending = Boolean(value.pipeline && ["running", "advancing", "retrying"].includes(value.pipeline.pipeline_status));
      if (["queued", "running"].includes(value.job.status) || pipelinePending) timer = window.setTimeout(() => void refresh(), 1600);
    };
    void refresh();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [job?.id, onSucceeded]);
  return bundle;
}

function useCreativeJob(initial: AgentJob | null) {
  const [state, setState] = useState<{job: AgentJob; artifact: Record<string, unknown> | null} | null>(null);
  useEffect(() => {
    if (!initial?.id) { setState(null); return; }
    let cancelled = false; let timer = 0;
    const refresh = async () => {
      const [{job}, bundle] = await Promise.all([
        api<{job: AgentJob}>(`/api/jobs/${initial.id}`),
        api<JobArtifactBundle>(`/api/jobs/${initial.id}/artifact`),
      ]);
      if (cancelled) return;
      setState({job, artifact: bundle.artifact});
      if (["queued", "running"].includes(job.status)) timer = window.setTimeout(() => void refresh(), 1400);
    };
    void refresh();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [initial?.id]);
  return state;
}

export function AuthorSpace(props: AuthorSpaceProps) {
  return <Routes>
    <Route path="/authors" element={<AuthorLibrary {...props}/>}/>
    <Route path="/authors/new" element={<AuthorCreationWizard {...props}/>}/>
    <Route path="/authors/:authorId" element={<AuthorDetailLayout {...props}/>}>
      <Route index element={<AuthorOverview/>}/>
      <Route path="style" element={<AuthorStyleStudio/>}/>
      <Route path="sources" element={<AuthorSources/>}/>
      <Route path="versions" element={<AuthorVersions/>}/>
      <Route path="books" element={<AuthorBooks/>}/>
      <Route path="persona" element={<AuthorPersonaStudio/>}/>
      <Route path="talks" element={<AuthorPersonalTalks/>}/>
      <Route path="settings" element={<AuthorSettings/>}/>
    </Route>
    <Route path="*" element={<Navigate to="/authors" replace/>}/>
  </Routes>;
}

function AuthorLibrary({authors}: AuthorSpaceProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState("updated");
  const visible = useMemo(() => authors.filter((author) => {
    const matches = !query.trim() || `${author.name} ${author.description}`.toLocaleLowerCase("zh-CN").includes(query.trim().toLocaleLowerCase("zh-CN"));
    if (!matches) return false;
    if (filter === "unpublished") return !author.current_version_number;
    return filter === "all" || author.status === filter;
  }).sort((left, right) => sort === "name" ? left.name.localeCompare(right.name, "zh-CN") : right.updated_at.localeCompare(left.updated_at)), [authors, filter, query, sort]);
  return <div className="author-page author-library-page">
    <section className="author-page-hero"><div><p className="eyebrow">AUTHOR LIBRARY</p><h1>作者空间</h1><p>作者先独立成长，作品需要时再绑定已发布版本。这里不依赖任何当前书籍。</p></div><Link className="button-link primary" to="/authors/new"><Plus/>新建作者</Link></section>
    <section className="author-library-tools">
      <label className="author-search"><Search/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索作者名称或创作方向"/></label>
      <div className="author-filter-group">{[["all", "全部"], ["active", "使用中"], ["archived", "已归档"], ["unpublished", "未发布"]].map(([value, label]) => <button key={value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{label}</button>)}</div>
      <select value={sort} onChange={(event) => setSort(event.target.value)} aria-label="作者排序"><option value="updated">最近更新</option><option value="name">按名称</option></select>
    </section>
    {visible.length ? <section className="author-shelf">{visible.map((author) => <Link to={`/authors/${author.id}`} className="author-card" key={author.id}>
      <div className="author-card-mark">{author.name.slice(0, 1)}</div><div className="author-card-copy"><div><h2>{author.name}</h2><StateTag value={author.status}/></div><p>{author.description || "尚未填写创作方向"}</p><div className="author-card-stats"><span><b>{author.current_version_number ? `v${author.current_version_number}` : author.draft_count ? `${author.draft_count} 份草稿` : "未配置"}</b>版本状态</span><span><b>{author.source_count || 0}</b>授权来源</span><span><b>{author.binding_count || 0}</b>关联作品</span></div></div><ChevronRight/>
    </Link>)}</section> : <section className="author-empty"><Sparkles/><h2>{authors.length ? "没有符合筛选的作者" : "作者库还是空的"}</h2><p>可以先创建空白作者，以后再补文风；创建过程不会绑定书籍。</p><Link className="button-link primary" to="/authors/new">创建第一个作者</Link></section>}
  </div>;
}

function AuthorCreationWizard(props: AuthorSpaceProps) {
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [identity, setIdentity] = useState({name: "", description: ""});
  const [author, setAuthor] = useState<AuthorProfile | null>(null);
  const [mode, setMode] = useState<"blank" | "ai" | "distill" | "">("");
  const [instruction, setInstruction] = useState("");
  const [rights, setRights] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [job, setJob] = useState<AgentJob | null>(null);
  const refreshCreated = useCallback(async () => {
    if (!author?.id) return;
    const value = await api<{author: AuthorProfile}>(`/api/authors/${author.id}`);
    setAuthor(value.author);
    await props.refreshAuthors();
  }, [author?.id, props.refreshAuthors]);
  const candidate = useCandidateJob(job, refreshCreated);
  const candidateVersion = candidate?.candidateVersion || null;

  const createIdentity = () => props.run("author-wizard-create", async () => {
    const value = await post<{author: AuthorProfile}>("/api/authors", identity);
    setAuthor(value.author); await props.refreshAuthors(); setStep(2);
  });
  const uploadFile = (file?: File) => author && file && props.run("author-wizard-upload", async () => {
    if (!rights) throw new Error("请先确认拥有作品或具有分析授权");
    await uploadAuthorSource<{source: AuthorSource}>(author.id, file); await refreshCreated();
  });
  const start = () => author && props.run("author-wizard-generate", async () => {
    if (mode === "ai") {
      if (!instruction.trim()) throw new Error("请描述这个作者的写作目标和习惯");
      const value = await post<{job: AgentJob}>(`/api/authors/${author.id}/ai-draft`, {instruction}); setJob(value.job);
    } else {
      if (!selected.length) throw new Error("至少选择一个已授权来源");
      const value = await post<{job: AgentJob}>(`/api/authors/${author.id}/distill`, {sourceIds: selected}); setJob(value.job);
    }
    setStep(4);
  });
  const moveSelected = (sourceId: string, offset: -1 | 1) => setSelected((prior) => {
    const values = [...prior];
    const index = values.indexOf(sourceId);
    const target = index + offset;
    if (index < 0 || target < 0 || target >= values.length) return prior;
    [values[index], values[target]] = [values[target], values[index]];
    return values;
  });
  const finish = (publish: boolean) => author && candidateVersion && props.run("author-wizard-finish", async () => {
    if (publish) await post(`/api/authors/${author.id}/versions/${candidateVersion.id}/publish`);
    await props.refreshAuthors(); navigate(`/authors/${author.id}`);
  });
  const retry = () => job && props.run("author-wizard-retry", async () => {
    const value = await post<{job: AgentJob}>(`/api/jobs/${candidate?.job.id || job.id}/retry`); setJob(value.job);
  });

  return <div className="author-page author-wizard-page">
    <Link to="/authors" className="author-back"><ArrowLeft/>返回作者库</Link>
    <section className="author-page-hero compact"><div><p className="eyebrow">CREATE AUTHOR</p><h1>建立独立作者</h1><p>只创建内部写作身份，不会读取或绑定当前书籍。</p></div><span className="wizard-progress">步骤 {step} / 4</span></section>
    <div className="wizard-rail">{["身份", "创建方式", "准备材料", "确认版本"].map((item, index) => <span className={step >= index + 1 ? "active" : ""} key={item}><b>{index + 1}</b>{item}</span>)}</div>
    {step === 1 && <section className="author-focus-panel"><div className="focus-copy"><h2>先给作者一个管理身份</h2><p>内部名称不等于作品的发布署名。保存后即使暂时没有文风版本、没有关联作品，这个作者也会留在作者库。</p></div><div className="focus-form"><label><span>内部作者名称</span><input value={identity.name} maxLength={80} onChange={(event) => setIdentity({...identity, name: event.target.value})} placeholder="例如：蘑菇先辈"/></label><label><span>创作方向与目标读者</span><textarea value={identity.description} maxLength={2000} onChange={(event) => setIdentity({...identity, description: event.target.value})} placeholder="记录题材方向、读者体验与语言目标，不必写成 Prompt。"/></label><button className="primary" disabled={!identity.name.trim() || props.busy === "author-wizard-create"} onClick={createIdentity}>保存身份并继续<ArrowRight/></button></div></section>}
    {step === 2 && <section className="author-mode-grid">
      {[{id: "blank", icon: PencilLine, title: "暂时保持空白", text: "直接完成创建，以后从文风工作室补充规则。"}, {id: "ai", icon: Bot, title: "AI 创建文风", text: "根据你的目标生成结构化候选，确认前不会发布。"}, {id: "distill", icon: Fingerprint, title: "从授权作品蒸馏", text: "提炼统计和抽象规则，不把范文原句注入写作 Prompt。"}].map(({id, icon: Icon, title, text}) => <button key={id} onClick={() => { setMode(id as typeof mode); if (id === "blank") navigate(`/authors/${author?.id}`); else setStep(3); }}><Icon/><h2>{title}</h2><p>{text}</p><span>选择此方式<ChevronRight/></span></button>)}
    </section>}
    {step === 3 && mode === "ai" && <section className="author-focus-panel"><div className="focus-copy"><h2>描述这个作者的写作方法</h2><p>可以写轻小说感、中文自然、番茄阅读节奏等目标，但系统不会额外套预制作者或轻小说开关。</p></div><div className="focus-form"><label><span>作者要求</span><textarea value={instruction} maxLength={4000} onChange={(event) => setInstruction(event.target.value)} placeholder="叙事距离、对白气质、人物换声、情绪落地、章末方式、禁忌……"/></label><div className="inline-actions"><button className="secondary" onClick={() => setStep(2)}>上一步</button><button className="primary" disabled={!instruction.trim()} onClick={start}>生成候选版本<Sparkles/></button></div></div></section>}
    {step === 3 && mode === "distill" && <section className="author-focus-panel wide"><div className="focus-copy"><h2>上传同一作者的授权作品</h2><p>支持 TXT、MD、EPUB。单文件 50 MB、单作者 500 MB；不要跨作者混合来源。</p><label className="rights-check"><input type="checkbox" checked={rights} onChange={(event) => setRights(event.target.checked)}/><span>我拥有这些作品或具有分析授权，且所选来源属于同一作者。</span></label><label className={`upload-button ${rights ? "" : "disabled"}`}><UploadCloud/>上传作品<input type="file" accept=".txt,.md,.epub" disabled={!rights} onChange={(event) => { void uploadFile(event.target.files?.[0]); event.currentTarget.value = ""; }}/></label></div><div className="source-picker"><h3>选择用于本次蒸馏的来源</h3>{(author?.sources || []).filter((item) => !item.deleted_at).map((source) => <label key={source.id}><input type="checkbox" checked={selected.includes(source.id)} onChange={(event) => setSelected((prior) => event.target.checked ? [...prior, source.id] : prior.filter((id) => id !== source.id))}/><span><b>{source.original_name}</b><small>{bytes(source.size_bytes)} · SHA {source.sha256.slice(0, 12)}</small></span></label>)}{!(author?.sources || []).some((item) => !item.deleted_at) && <p className="quiet-empty">还没有来源文件。</p>}{selected.length > 1 && <div className="selected-source-order"><b>本次蒸馏顺序</b>{selected.map((sourceId, index) => { const source = author?.sources?.find((item) => item.id === sourceId); return <div key={sourceId}><span><i>{index + 1}</i>{source?.original_name || sourceId}</span><button className="icon-button" disabled={index === 0} onClick={() => moveSelected(sourceId, -1)}><ArrowUp/></button><button className="icon-button" disabled={index === selected.length - 1} onClick={() => moveSelected(sourceId, 1)}><ArrowDown/></button></div>; })}</div>}<div className="inline-actions"><button className="secondary" onClick={() => setStep(2)}>上一步</button><button className="primary" disabled={!selected.length} onClick={start}>蒸馏所选来源<Fingerprint/></button></div></div></section>}
    {step === 4 && <CandidatePanel bundle={candidate} busy={props.busy} onEdit={() => navigate(`/authors/${author?.id}/style?base=${candidateVersion?.id || ""}`)} onKeep={() => void finish(false)} onPublish={() => void finish(true)} onRetry={retry}/>}
  </div>;
}

function AuthorDetailLayout(props: AuthorSpaceProps) {
  const {authorId = ""} = useParams();
  const [author, setAuthor] = useState<AuthorProfile | null>(null);
  const [error, setError] = useState("");
  const refreshAuthor = useCallback(async () => {
    try { const value = await api<{author: AuthorProfile}>(`/api/authors/${authorId}`); setAuthor(value.author); setError(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }, [authorId]);
  useEffect(() => { setAuthor(null); void refreshAuthor(); }, [refreshAuthor]);
  if (error) return <div className="author-empty"><CircleAlert/><h2>作者空间无法打开</h2><p>{error}</p><Link className="button-link secondary" to="/authors">返回作者库</Link></div>;
  if (!author) return <div className="author-loading"><LoaderCircle className="spin"/>正在读取作者空间</div>;
  const context: AuthorDetailContext = {...props, author, refreshAuthor};
  return <div className="author-page author-detail-page">
    <div className="author-detail-head"><div><Link to="/authors" className="author-back"><ArrowLeft/>作者库</Link><div className="author-title-line"><span className="author-avatar">{author.name.slice(0, 1)}</span><div><p className="eyebrow">AUTHOR SPACE</p><h1>{author.name}</h1><p>{author.description || "尚未填写创作方向"}</p></div></div></div><div className="author-head-meta"><StateTag value={author.status}/><span>最新发布 {author.current_version_number ? `v${author.current_version_number}` : "—"}</span><span>{author.bindings?.length || 0} 本作品</span></div></div>
    <nav className="author-subnav" aria-label="作者空间导航">{[["", "总览", LibraryBig], ["style", "文风工作室", PencilLine], ["sources", "来源与蒸馏", Fingerprint], ["versions", "版本中心", GitCompare], ["persona", "个人人设", UserRound], ["talks", "个人谈", MessageSquareText], ["books", "关联作品", BookOpen], ["settings", "作者设置", Settings2]].map(([path, label, Icon]) => <NavLink end={!path} key={String(path)} to={`/authors/${author.id}${path ? `/${path}` : ""}`}><Icon/>{String(label)}</NavLink>)}</nav>
    <Outlet context={context}/>
  </div>;
}

function useAuthorDetail() { return useOutletContext<AuthorDetailContext>(); }

function AuthorOverview() {
  const {author, projects, onOpenProject} = useAuthorDetail();
  const published = (author.versions || []).find((version) => version.status === "published");
  const forbidden = published?.profile.forbidden_patterns || [];
  return <div className="author-overview">
    <section className="author-metric-row"><article><span>已发布版本</span><strong>{(author.versions || []).filter((item) => item.status === "published").length}</strong><small>作品绑定的是不可变快照</small></article><article><span>草稿候选</span><strong>{(author.versions || []).filter((item) => item.status === "draft").length}</strong><small>未确认前不会进入 Prompt</small></article><article><span>授权来源</span><strong>{(author.sources || []).filter((item) => !item.deleted_at).length}</strong><small>原句不会注入正文生成</small></article><article><span>关联作品</span><strong>{author.bindings?.length || 0}</strong><small>零关联作者完全有效</small></article></section>
    <div className="author-overview-grid"><section className="author-content-panel"><div className="content-panel-head"><div><span>当前推荐文风</span><h2>{published ? `版本 v${published.version_number}` : "尚未发布版本"}</h2></div><Link to={`/authors/${author.id}/style`}>打开工作室<ChevronRight/></Link></div>{published ? <>{distillationCertification(published) === "legacy" && <div className="legacy-distillation-warning"><CircleAlert/><span><b>旧版蒸馏，未通过全文认证</b>该版本会继续保留，但不能声称逐字读完全部来源；重新深度蒸馏并发布新版本后才会获得全文认证。</span></div>}<div className="style-summary-grid">{objectSections.slice(0, 4).map((section) => <article key={String(section.key)}><span>{section.title}</span><p>{Object.values(published.profile[section.key] as Record<string, string>).filter(Boolean).join(" · ") || "未填写"}</p></article>)}</div><div className="forbidden-strip"><ShieldCheck/><div><b>明确禁忌</b><p>{forbidden.length ? forbidden.join("、") : "尚未设置"}</p></div></div></> : <div className="quiet-empty large">可以从文风工作室手工建立，或从 AI / 授权作品蒸馏候选开始。</div>}</section>
      <section className="author-content-panel"><div className="content-panel-head"><div><span>实际作用链</span><h2>作者如何进入作品</h2></div><Link to={`/authors/${author.id}/books`}>查看证据<ChevronRight/></Link></div><div className="policy-chain"><span>作者版本</span><ChevronRight/><span>作品绑定</span><ChevronRight/><span>编译策略</span><ChevronRight/><span>工作流快照</span><ChevronRight/><span>阶段 Prompt</span></div><p className="policy-note">Canon、章节事实、审查门和发布规则始终高于作者文风。更新作者不会暗改已绑定作品或运行中的策略快照。</p></section></div>
    <section className="author-content-panel"><div className="content-panel-head"><div><span>LINKED WORKS</span><h2>关联作品</h2></div><Link to={`/authors/${author.id}/books`}>管理关联<ChevronRight/></Link></div>{author.bindings?.length ? <div className="author-book-preview">{author.bindings.slice(0, 3).map((binding) => { const project = projects.find((item) => item.id === binding.book_id); return <article key={binding.book_id}><BookOpen/><div><h3>{binding.book_title}</h3><p>绑定 v{binding.version_number} · {binding.effect_state === "next_workflow_only" ? "下个工作流生效" : binding.effect_state === "active_and_next" ? "当前与后续均生效" : "后续工作流生效"}</p><small>{project?.chapterCount || 0} 章 · 策略 {binding.compiled_policy_hash?.slice(0, 12) || "待编译"}</small></div><button className="secondary" onClick={() => onOpenProject(binding.book_id)}>打开作品</button></article>; })}</div> : <div className="quiet-empty large">这个作者尚未关联作品。可以先完善作者，再在开书或关联作品页主动绑定。</div>}</section>
  </div>;
}

const scopeText = (value: string) => ({author_core: "作者核心", work_specific: "单本特有", character_specific: "角色特有", uncertain: "待验证"} as Record<string, string>)[value] || value;

function CandidatePanel({bundle, busy, onEdit, onKeep, onPublish, onRetry}: {bundle: CandidateBundle | null; busy: string; onEdit: () => void; onKeep: () => void; onPublish: () => void; onRetry: () => void}) {
  const pipelinePending = Boolean(bundle?.pipeline && ["running", "advancing", "retrying"].includes(bundle.pipeline.pipeline_status));
  if (!bundle || ["queued", "running"].includes(bundle.job.status) || pipelinePending) {
    const pipeline = bundle?.pipeline;
    const phase = pipeline ? ({full_read: "逐字阅读全文", phase_portrait: "章节与阶段画像", work_reduce: "单书分层归纳", cross_work_aggregate: "跨作品等权聚合", independent_verify: "独立质量复核", dimension_verify: "分维度独立复核"} as Record<string, string>)[pipeline.phase] || pipeline.phase : "准备任务";
    return <section className="candidate-wait"><LoaderCircle className="spin"/><h2>{pipeline ? `深度蒸馏 · ${phase}` : "正在生成结构化作者候选"}</h2>{pipeline ? <><p>已阅读 {pipeline.completed_characters.toLocaleString()} / {pipeline.total_characters.toLocaleString()} 字符 · {pipeline.completed_batches}/{pipeline.total_batches} 块 · 已归纳 {pipeline.completed_sources}/{pipeline.total_sources} 部作品</p><div className="distillation-progress"><span style={{width: `${Math.max(1, pipeline.coverage_percent)}%`}}/></div><small>全文覆盖 {pipeline.coverage_percent}% · 每个字符只计一次；最终候选还需跨作品聚合和独立复核。</small>{pipeline.verified_group_count ? <p className="verify-progress-note">维度复核 {pipeline.verified_group_count}/{pipeline.verify_group_count} 组 · {pipeline.verified_dimension_count} 个维度已通过证据与迁移校验</p> : null}{pipeline.duplicate_group_recoveries ? <p className="verify-recovery-note">已阻止 {pipeline.duplicate_group_recoveries} 个维度组的重复提交，保留既有结果并继续推进后续维度。</p> : null}</> : <p>候选只会保存为草稿；未确认前不会影响任何书籍。</p>}</section>;
  }
  if (bundle.job.status !== "succeeded" || !bundle.candidateVersion) return <section className="candidate-wait failed"><CircleAlert/><h2>候选生成未完成</h2><p>{bundle.job.error || "请检查过程记录后重试。"}</p><button className="secondary" disabled={Boolean(busy)} onClick={onRetry}>从失败阶段继续重试</button></section>;
  const profile = asProfile((bundle.artifact?.profile as unknown) || bundle.candidateVersion.profile);
  const rationale = Array.isArray(bundle.artifact?.rationale) ? bundle.artifact.rationale.map(String) : [];
  const warnings = Array.isArray(bundle.artifact?.warnings) ? bundle.artifact.warnings.map(String) : [];
  const dimensions = profile.style_dimensions || [];
  const quality = profile.distillation_quality;
  const pipeline = bundle.pipeline;
  return <section className="candidate-review">
    <div className="candidate-title"><div><StateTag value="draft"/><h2>候选版本 v{bundle.candidateVersion.version_number}</h2><p>哈希 {bundle.candidateVersion.profile_hash.slice(0, 16)} · 仍未绑定任何作品</p></div><ShieldCheck/></div>
    {quality && <div className="distillation-score-row"><article><span>可靠级别</span><strong>{quality.reliability_level.toUpperCase()}</strong></article><article><span>跨作品一致性</span><strong>{quality.cross_source_consistency}</strong></article><article><span>留出片段一致性</span><strong>{quality.holdout_consistency}</strong></article><article><span>可执行度</span><strong>{quality.actionability_score}</strong></article><article><span>题材污染风险</span><strong>{quality.topic_leakage_risk}</strong></article></div>}
    {pipeline && <div className="distillation-trace-row" aria-label="蒸馏溯源摘要"><article><span>证据账本</span><strong>{pipeline.evidence_count}</strong><small>原文唯一定位</small></article><article><span>章节/固定段画像</span><strong>{pipeline.segment_portrait_count}</strong><small>不伪造章名</small></article><article><span>阶段画像</span><strong>{pipeline.phase_portrait_count}</strong><small>保留变化与反例</small></article><article><span>单书画像</span><strong>{pipeline.work_portrait_count}</strong><small>作品等权</small></article><article><span>增量复用</span><strong>{pipeline.source_cache_hits}</strong><small>未变来源未重读</small></article></div>}
    {pipeline?.run_id && <DistillationTraceExplorer authorId={bundle.job.scopeId || bundle.job.bookId.replace(/^author:/, "")} runId={pipeline.run_id}/>} 
    <div className="candidate-profile-grid">{objectSections.map((section) => <article key={String(section.key)}><span>{section.title}</span><p>{Object.values(profile[section.key] as Record<string, string | AuthorStyleDimension[]>).filter(Boolean).map((item) => Array.isArray(item) ? `${item.length} 项` : String(item)).join(" · ") || "未填写"}</p></article>)}</div>
    {dimensionArraySections.length > 0 && <div className="candidate-profile-grid">{dimensionArraySections.map((section) => { const current = profile[section.key] || {}; const rawDimensions = current[section.field]; const dimensions = Array.isArray(rawDimensions) ? rawDimensions : []; return <article key={`${section.key}.${section.field}`}><span>{section.title}</span><p>{dimensions.length ? `${dimensions.length} 项结构化方法` : "未蒸馏"}</p></article>; })}</div>}
    {dimensions.length > 0 && <div className="deep-dimension-panel"><div><h3>深度风格指纹 · {dimensions.length} 项</h3><p>每项都带调用条件、执行动作、允许变化和验收点。只有“作者核心”且达到稳定阈值的指纹会按阶段检索进入作品契约。</p></div><div className="deep-dimension-grid">{dimensions.map((item) => <article key={item.id}><header><b>{item.label}</b><span>{scopeText(item.scope)}</span></header><p>{item.finding}</p>{item.trigger && <><strong>调用条件</strong><p>{item.trigger}</p></>}<strong>写作动作</strong><p>{item.writing_instruction}</p>{item.implementation_steps?.length ? <small>步骤：{item.implementation_steps.join(" → ")}</small> : null}{item.allowed_variations?.length ? <small>允许变化：{item.allowed_variations.join("；")}</small> : null}{item.acceptance_tests?.length ? <small>验收：{item.acceptance_tests.join("；")}</small> : null}<small>避免：{item.avoid}</small><footer>{item.axis ? `${item.axis} · ` : ""}置信 {item.confidence} · 稳定 {item.stability} · {item.applies_to.join(" / ")}</footer></article>)}</div></div>}
    {rationale.length > 0 && <div className="candidate-notes"><h3>公开生成依据</h3>{rationale.map((item) => <p key={item}>{item}</p>)}</div>}{warnings.length > 0 && <div className="candidate-warnings"><h3>需要注意</h3>{warnings.map((item) => <p key={item}>{item}</p>)}</div>}
    <div className="candidate-actions"><button className="secondary" onClick={onEdit}><PencilLine/>先编辑规则</button><button className="secondary" disabled={Boolean(busy)} onClick={onKeep}>保留草稿</button><button className="primary" disabled={Boolean(busy)} onClick={onPublish}><Check/>发布这个版本</button></div>
  </section>;
}

function DistillationTraceExplorer({authorId, runId}: {authorId: string; runId: string}) {
  const [trace, setTrace] = useState<{evidence: DistillationEvidenceTrace[]; portraits: DistillationPortraitTrace[]} | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api<{evidence: DistillationEvidenceTrace[]}>(`/api/authors/${authorId}/distillation/runs/${runId}/evidence`),
      api<{portraits: DistillationPortraitTrace[]}>(`/api/authors/${authorId}/distillation/runs/${runId}/portraits`),
    ]).then(([evidence, portraits]) => { if (!cancelled) setTrace({evidence: evidence.evidence, portraits: portraits.portraits}); })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { cancelled = true; };
  }, [authorId, runId]);
  const coverage = useMemo(() => {
    const states = {supported: 0, contradicted: 0, absent: 0, unobserved: 0};
    for (const portrait of trace?.portraits || []) {
      const profile = portrait.profile;
      const state = String(profile.coverage_state || "");
      if (state in states) states[state as keyof typeof states] += 1;
      const matrix = Array.isArray(profile.coverage_matrix) ? profile.coverage_matrix as Array<Record<string, unknown>> : [];
      for (const cell of matrix) { const value = String(cell.state || ""); if (value in states) states[value as keyof typeof states] += 1; }
    }
    return states;
  }, [trace]);
  return <details className="distillation-trace-explorer"><summary><span><Fingerprint/><b>查看分层画像与原文证据</b></span><small>{trace ? `${trace.portraits.length} 个画像 · ${trace.evidence.length} 条证据` : error || "正在读取溯源记录"}</small><ChevronRight/></summary>{trace && <div className="distillation-trace-body"><div className="coverage-legend"><span className="supported">有证据支持 <b>{coverage.supported}</b></span><span className="contradicted">反例 <b>{coverage.contradicted}</b></span><span className="absent">确认未出现 <b>{coverage.absent}</b></span><span className="unobserved">未观察 <b>{coverage.unobserved}</b></span></div><section><h3>章节→阶段→单书画像</h3><div className="portrait-trace-list">{trace.portraits.map((portrait) => <article key={portrait.id}><span>{portrait.level === "segment" ? "章节/段落" : portrait.level === "phase" ? "阶段" : "单书"}</span><b>{portrait.sourceId} · {portrait.scopeId}</b><p>{String(portrait.profile.narrative_function || portrait.profile.conflict_movement || (Array.isArray(portrait.profile.story_and_structure) ? portrait.profile.story_and_structure.join("；") : "画像已建立"))}</p></article>)}</div></section><section><h3>证据账本（原文由服务器定位）</h3><div className="evidence-trace-list">{trace.evidence.slice(0, 60).map((item) => <article key={item.id}><code>{item.id}</code><span>{item.sourceId} · {item.phaseId || "未分阶段"} · 第 {item.lineStart}—{item.lineEnd} 行 · {item.axis}</span><blockquote>{item.exactQuote}</blockquote></article>)}</div>{trace.evidence.length > 60 && <p className="trace-limit-note">页面只展示前 60 条，完整证据仍保存在本地账本。</p>}</section></div>}</details>;
}

function AuthorStyleStudio() {
  const {author, busy, run, refreshAuthor, refreshAuthors} = useAuthorDetail();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const versions = author.versions || [];
  const requested = params.get("base") || "";
  const base = versions.find((item) => item.id === requested) || versions.find((item) => item.status === "published") || versions[0] || null;
  const [profile, setProfile] = useState<AuthorStyleProfile>(() => asProfile(base?.profile));
  const [summary, setSummary] = useState("");
  const [raw, setRaw] = useState(() => JSON.stringify(profile, null, 2));
  const [rawError, setRawError] = useState("");
  useEffect(() => { const next = asProfile(base?.profile); setProfile(next); setRaw(JSON.stringify(next, null, 2)); setRawError(""); }, [base?.id]);
  const updateProfile = (next: AuthorStyleProfile) => { setProfile(next); setRaw(JSON.stringify(next, null, 2)); };
  const applyRaw = () => {
    try { const next = asProfile(JSON.parse(raw)); const errors = profileErrors(next); if (errors.length) throw new Error(errors.join("；")); setProfile(next); setRaw(JSON.stringify(next, null, 2)); setRawError(""); }
    catch (error) { setRawError(error instanceof Error ? error.message : String(error)); }
  };
  const save = () => run("author-style-save", async () => {
    const cleaned = asProfile(profile);
    cleaned.rules = cleaned.rules.filter((item) => item.rule.trim()).map((item) => ({...item, category: item.category.trim() || "文风", rule: item.rule.trim()}));
    const errors = profileErrors(cleaned); if (errors.length) throw new Error(errors.join("；"));
    const value = await post<{version: AuthorVersion}>(`/api/authors/${author.id}/versions`, {baseVersionId: base?.id || null, profile: cleaned, changeSummary: summary});
    await refreshAuthor(); await refreshAuthors(); navigate(`/authors/${author.id}/versions?focus=${value.version.id}`);
  });
  return <div className="author-task-page style-studio-page">
    <section className="task-page-head"><div><p className="eyebrow">STYLE STUDIO</p><h2>文风工作室</h2><p>编辑的是新版本草稿。任何已发布版本和已绑定作品都不会被原地修改。</p></div><div className="task-head-actions"><select value={base?.id || ""} onChange={(event) => setParams(event.target.value ? {base: event.target.value} : {})}><option value="">从空白开始</option>{versions.map((version) => <option key={version.id} value={version.id}>基于 v{version.version_number} · {statusText(version.status)}</option>)}</select><button className="primary" disabled={busy === "author-style-save"} onClick={save}><Save/>保存为新草稿</button></div></section>
    <div className="style-editor-sections">{objectSections.map((section) => <ObjectSection key={String(section.key)} section={section} value={profile[section.key] as Record<string, string | AuthorStyleDimension[]>} onChange={(value) => updateProfile({...profile, [section.key]: value})}/>)}
      {dimensionArraySections.map((section) => {
        const current = profile[section.key] || {};
        const rawDimensions = current[section.field];
        const dimensions = Array.isArray(rawDimensions) ? rawDimensions : [];
        const usesReferences = dimensions.some((item) => item && typeof item === "object" && "dimension_id" in item)
          || Boolean(profile.provenance?.ledger_run_id);
        if (usesReferences) {
          const references = dimensions as AuthorMethodReference[];
          const eligible = (profile.style_dimensions || []).filter((item) => item.axis === section.axis);
          return <section className="style-section full" key={`${section.key}.${section.field}`}><div><h3>{section.title}</h3><p>{section.hint}；这里只引用下方完整维度，不再复制半套方法字段。</p></div><MethodReferenceEditor value={references} dimensions={profile.style_dimensions || []} onChange={(next) => updateProfile({...profile, [section.key]: {...current, [section.field]: next}})}/><button className="add-row" disabled={!eligible.length} onClick={() => updateProfile({...profile, [section.key]: {...current, [section.field]: [...references, {dimension_id: eligible[0].id, role: "primary", order: references.length + 1, local_note: ""}]}})}><Plus/>引用完整维度</button></section>;
        }
        return <section className="style-section full" key={`${section.key}.${section.field}`}><div><h3>{section.title}</h3><p>{section.hint}</p></div><ShallowMethodEditor value={dimensions as AuthorStyleDimension[]} onChange={(next) => updateProfile({...profile, [section.key]: {...current, [section.field]: next}})}/><button className="add-row" onClick={() => updateProfile({...profile, [section.key]: {...current, [section.field]: [...dimensions, blankDimension(section.axis)]}})}><Plus/>增加旧版方法卡</button></section>;
      })}
      {profile.style_dimensions?.length ? <section className="style-section full"><div><h3>深度蒸馏维度</h3><p>可修订写作动作、适用范围与置信度；单本特有和角色特有特点不会默认注入作品。</p></div><DeepDimensionEditor value={profile.style_dimensions} onChange={(style_dimensions) => updateProfile({...profile, style_dimensions})}/></section> : null}
      <section className="style-section full"><div><h3>可执行规则</h3><p>这些抽象规则会进入 CompiledWritingPolicy；不能要求跳过 Canon、审查或发布规则。</p></div><RuleEditor value={profile.rules} onChange={(rules) => updateProfile({...profile, rules})}/></section>
      {listSections.map((section) => <ListSection key={String(section.key)} section={section} value={profile[section.key] as string[]} onChange={(value) => updateProfile({...profile, [section.key]: value})}/>)}
    </div>
    <section className="change-summary"><label><span>版本变更说明</span><textarea value={summary} maxLength={1000} onChange={(event) => setSummary(event.target.value)} placeholder="说明为什么创建这次新版本，便于以后比较和追溯。"/></label></section>
    <details className="advanced-json"><summary><Code2/>高级 JSON<span>结构化编辑器仍是主入口；JSON 必须校验后才能应用。</span></summary><textarea value={raw} onChange={(event) => setRaw(event.target.value)} spellCheck={false}/>{rawError && <p className="field-error"><CircleAlert/>{rawError}</p>}<button className="secondary" onClick={applyRaw}>校验并应用到表单</button></details>
  </div>;
}

function ShallowMethodEditor({value, onChange}: {value: AuthorStyleDimension[]; onChange: (value: AuthorStyleDimension[]) => void}) {
  const update = (index: number, patch: Partial<AuthorStyleDimension>) => onChange(value.map((entry, position) => position === index ? {...entry, ...patch} : entry));
  return <div className="dimension-editor">{value.map((item, index) => <article key={item.id || index}>
    <div><input value={item.label} onChange={(event) => update(index, {label: event.target.value})} placeholder="方法名"/><input value={item.axis || ""} onChange={(event) => update(index, {axis: event.target.value})} placeholder="轴"/><button className="icon-button" onClick={() => onChange(value.filter((_, position) => position !== index))}><Trash2/></button></div>
    <label><span>写作动作</span><textarea value={item.writing_instruction} onChange={(event) => update(index, {writing_instruction: event.target.value})}/></label>
    <label><span>适用范围（每行一条）</span><textarea value={(item.applies_to || []).join("\n")} onChange={(event) => update(index, {applies_to: event.target.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)})}/></label>
    <label><span>证据 ID（每行一条）</span><textarea value={(item.evidence_ids || []).join("\n")} onChange={(event) => update(index, {evidence_ids: event.target.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)})}/></label>
  </article>)}</div>;
}

function MethodReferenceEditor({value, dimensions, onChange}: {value: AuthorMethodReference[]; dimensions: AuthorStyleDimension[]; onChange: (value: AuthorMethodReference[]) => void}) {
  const update = (index: number, patch: Partial<AuthorMethodReference>) => onChange(value.map((entry, position) => position === index ? {...entry, ...patch} : entry));
  return <div className="dimension-editor method-reference-editor">{value.map((item, index) => {
    const target = dimensions.find((dimension) => dimension.id === item.dimension_id);
    return <article key={`${item.dimension_id}-${index}`}>
      <div><select value={item.dimension_id} onChange={(event) => update(index, {dimension_id: event.target.value})}>{dimensions.map((dimension) => <option key={dimension.id} value={dimension.id}>{dimension.label || dimension.id} · {dimension.axis}</option>)}</select><select value={item.role} onChange={(event) => update(index, {role: event.target.value as AuthorMethodReference["role"]})}><option value="primary">主要方法</option><option value="supporting">辅助方法</option><option value="warning">风险提醒</option></select><button className="icon-button" onClick={() => onChange(value.filter((_, position) => position !== index))}><Trash2/></button></div>
      <p>{target?.writing_instruction || "引用目标不存在；保存会被拒绝"}</p>
      <label><span>分组说明</span><textarea value={item.local_note || ""} onChange={(event) => update(index, {local_note: event.target.value})}/></label>
      <label><span>顺序</span><input type="number" min="1" value={item.order} onChange={(event) => update(index, {order: Number(event.target.value)})}/></label>
    </article>;
  })}</div>;
}

function DeepDimensionEditor({value, onChange}: {value: AuthorStyleDimension[]; onChange: (value: AuthorStyleDimension[]) => void}) {
  const update = (index: number, patch: Partial<AuthorStyleDimension>) => onChange(value.map((entry, position) => position === index ? {...entry, ...patch} : entry));
  const lines = (text: string) => text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return <div className="dimension-editor">{value.map((item, index) => <article key={item.id || index}>
    <div><input value={item.label} onChange={(event) => update(index, {label: event.target.value})}/><select value={item.scope} onChange={(event) => update(index, {scope: event.target.value as AuthorStyleDimension["scope"]})}><option value="author_core">旧版作者核心</option><option value="author_core_strong">强作者核心</option><option value="author_core_candidate">候选作者核心</option><option value="work_cluster">作品簇方法</option><option value="work_specific">单本特有</option><option value="character_specific">角色特有</option><option value="uncertain">待验证</option><option value="contradicted">已有反例</option></select><button className="icon-button" onClick={() => onChange(value.filter((_, position) => position !== index))}><Trash2/></button></div>
    <label><span>指纹轴</span><input value={item.axis || ""} onChange={(event) => update(index, {axis: event.target.value})}/></label>
    <label><span>风格发现</span><textarea value={item.finding} onChange={(event) => update(index, {finding: event.target.value})}/></label>
    <label><span>调用条件</span><textarea value={item.trigger || ""} onChange={(event) => update(index, {trigger: event.target.value})}/></label>
    <label><span>写作动作</span><textarea value={item.writing_instruction} onChange={(event) => update(index, {writing_instruction: event.target.value})}/></label>
    <label><span>执行步骤（每行一条）</span><textarea value={(item.implementation_steps || []).join("\n")} onChange={(event) => update(index, {implementation_steps: lines(event.target.value)})}/></label>
    <label><span>允许变化（每行一条）</span><textarea value={(item.allowed_variations || []).join("\n")} onChange={(event) => update(index, {allowed_variations: lines(event.target.value)})}/></label>
    <label><span>验收点（每行一条）</span><textarea value={(item.acceptance_tests || []).join("\n")} onChange={(event) => update(index, {acceptance_tests: lines(event.target.value)})}/></label>
    <label><span>失败方式（每行一条）</span><textarea value={(item.failure_modes || []).join("\n")} onChange={(event) => update(index, {failure_modes: lines(event.target.value)})}/></label>
    <label><span>不适用条件（每行一条）</span><textarea value={(item.non_applicable_cases || []).join("\n")} onChange={(event) => update(index, {non_applicable_cases: lines(event.target.value)})}/></label>
    <label><span>避免方式</span><textarea value={item.avoid} onChange={(event) => update(index, {avoid: event.target.value})}/></label>
    <label><span>支持证据 ID（每行一条）</span><textarea value={(item.evidence_ids || []).join("\n")} onChange={(event) => update(index, {evidence_ids: lines(event.target.value)})}/></label>
    <label><span>反例证据 ID（每行一条）</span><textarea value={(item.counterevidence_ids || []).join("\n")} onChange={(event) => update(index, {counterevidence_ids: lines(event.target.value)})}/></label>
    {item.transfer_test && <div className="transfer-test-editor"><label><span>去题材后的机制</span><textarea value={item.transfer_test.abstract_mechanism} onChange={(event) => update(index, {transfer_test: {...item.transfer_test!, abstract_mechanism: event.target.value}})}/></label><label><span>已剔除词（每行一条）</span><textarea value={item.transfer_test.removed_terms.join("\n")} onChange={(event) => update(index, {transfer_test: {...item.transfer_test!, removed_terms: lines(event.target.value)}})}/></label><label><span>迁移结论</span><select value={item.transfer_test.verdict} onChange={(event) => update(index, {transfer_test: {...item.transfer_test!, verdict: event.target.value as "pass" | "partial" | "fail"}})}><option value="pass">通过</option><option value="partial">部分通过</option><option value="fail">失败</option></select></label><div>{item.transfer_test.trials.map((trial, trialIndex) => <label key={trialIndex}><span>迁移题材 {trialIndex + 1}</span><input value={trial.target_genre} readOnly/><textarea value={trial.translated_example} readOnly/></label>)}</div></div>}
    <footer><label>置信度<input type="number" min="0" max="100" value={item.confidence} onChange={(event) => update(index, {confidence: Number(event.target.value)})}/></label><label>稳定度<input type="number" min="0" max="100" value={item.stability} onChange={(event) => update(index, {stability: Number(event.target.value)})}/></label><span>{item.applies_to.join(" / ")}</span></footer>
  </article>)}</div>;
}

function ObjectSection({section, value, onChange}: {section: typeof objectSections[number]; value: Record<string, string | AuthorStyleDimension[]>; onChange: (value: Record<string, string | AuthorStyleDimension[]>) => void}) {
  const stringEntries = Object.entries(value || {}).filter((entry): entry is [string, string] => !Array.isArray(entry[1]));
  const arrayEntries = Object.entries(value || {}).filter((entry): entry is [string, AuthorStyleDimension[]] => Array.isArray(entry[1]));
  const rebuild = (nextStrings: [string, string][]) => {
    const next: Record<string, string | AuthorStyleDimension[]> = {...Object.fromEntries(arrayEntries)};
    for (const [key, item] of nextStrings) next[key] = item;
    onChange(next);
  };
  const change = (index: number, key: string, item: string) => rebuild(stringEntries.map(([oldKey, oldValue], position) => position === index ? [key, item] as [string, string] : [oldKey, oldValue]));
  return <section className="style-section"><div><h3>{section.title}</h3><p>{section.hint}</p></div><div className="style-kv-list">{stringEntries.map(([key, item], index) => <div key={`${key}-${index}`}><input value={key} aria-label={`${section.title}字段`} onChange={(event) => change(index, event.target.value, item)}/><textarea value={item} aria-label={`${section.title}规则`} onChange={(event) => change(index, key, event.target.value)}/><button className="icon-button" onClick={() => rebuild(stringEntries.filter((_, position) => position !== index))} aria-label="删除字段"><Trash2/></button></div>)}<button className="add-row" onClick={() => rebuild([...stringEntries, [`rule_${stringEntries.length + 1}`, ""]])}><Plus/>增加字段</button></div></section>;
}

function ListSection({section, value, onChange}: {section: typeof listSections[number]; value: string[]; onChange: (value: string[]) => void}) {
  return <section className="style-section list"><div><h3>{section.title}</h3><p>{section.hint}</p></div><textarea value={(value || []).join("\n")} onChange={(event) => onChange(event.target.value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))} placeholder="每行一条规则"/></section>;
}

function RuleEditor({value, onChange}: {value: AuthorStyleRule[]; onChange: (value: AuthorStyleRule[]) => void}) {
  return <div className="rule-editor">{value.map((item, index) => <div key={index}><input value={item.category} onChange={(event) => onChange(value.map((entry, position) => position === index ? {...entry, category: event.target.value} : entry))} placeholder="分类"/><textarea value={item.rule} onChange={(event) => onChange(value.map((entry, position) => position === index ? {...entry, rule: event.target.value} : entry))} placeholder="可执行规则"/><button className="icon-button" onClick={() => onChange(value.filter((_, position) => position !== index))}><Trash2/></button></div>)}<button className="add-row" onClick={() => onChange([...value, {category: "文风", rule: ""}])}><Plus/>增加规则</button></div>;
}

function AuthorSources() {
  const {author, busy, run, refreshAuthor, refreshAuthors} = useAuthorDetail();
  const navigate = useNavigate();
  const [rights, setRights] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [job, setJob] = useState<AgentJob | null>(null);
  useEffect(() => {
    if (job) return;
    let cancelled = false;
    void api<AgentJob[]>("/api/jobs").then((jobs) => {
      if (cancelled) return;
      const scoped = jobs.filter((item) => item.scopeType === "author" && item.scopeId === author.id);
      const fullRuns = new Set(scoped.filter((item) => fullDistillationStages.has(item.stage)).map((item) => item.runId));
      const latest = scoped.find((item) => fullDistillationStages.has(item.stage) || (item.stage === "author_style_distill" && fullRuns.has(item.runId)));
      if (latest) setJob(latest);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [author.id, job]);
  const done = useCallback(async () => { await refreshAuthor(); await refreshAuthors(); }, [refreshAuthor, refreshAuthors]);
  const candidate = useCandidateJob(job, done);
  const available = (author.sources || []).filter((item) => !item.deleted_at);
  const upload = (file?: File) => file && run("author-source-upload", async () => { if (!rights) throw new Error("请先确认分析授权"); await uploadAuthorSource(author.id, file); await refreshAuthor(); });
  const remove = (sourceId: string) => run("author-source-delete", async () => { await del(`/api/authors/${author.id}/sources/${sourceId}`); setSelected((prior) => prior.filter((item) => item !== sourceId)); await refreshAuthor(); });
  const orderedSelected = available.filter((source) => selected.includes(source.id)).map((source) => source.id);
  const move = (sourceId: string, offset: -1 | 1) => run("author-source-order", async () => {
    const sourceIds = available.map((source) => source.id);
    const index = sourceIds.indexOf(sourceId);
    const target = index + offset;
    if (index < 0 || target < 0 || target >= sourceIds.length) return;
    [sourceIds[index], sourceIds[target]] = [sourceIds[target], sourceIds[index]];
    await put(`/api/authors/${author.id}/sources/order`, {sourceIds});
    setSelected((prior) => sourceIds.filter((item) => prior.includes(item)));
    await refreshAuthor();
  });
  const distill = () => run("author-distill", async () => { if (!orderedSelected.length) throw new Error("至少选择一个来源"); const value = await post<{job: AgentJob}>(`/api/authors/${author.id}/distill`, {sourceIds: orderedSelected}); setJob(value.job); });
  const retry = () => job && run("author-distill-retry", async () => { const value = await post<{job: AgentJob}>(`/api/jobs/${candidate?.job.id || job.id}/retry`); setJob(value.job); });
  const publish = () => candidate?.candidateVersion && run("author-distill-publish", async () => { await post(`/api/authors/${author.id}/versions/${candidate.candidateVersion!.id}/publish`); await done(); navigate(`/authors/${author.id}`); });
  return <div className="author-task-page source-page"><section className="task-page-head"><div><p className="eyebrow">SOURCE LAB · MULTI-WORK</p><h2>作品来源与深度文风蒸馏</h2><p>每部作品先独立画像，再按作品等权求稳定交集；原件只在本地保存，范文原句不进入写作 Prompt。</p></div><label className={`upload-button ${rights ? "" : "disabled"}`}><UploadCloud/>上传 TXT / MD / EPUB<input type="file" accept=".txt,.md,.epub" disabled={!rights || busy === "author-source-upload"} onChange={(event) => { void upload(event.target.files?.[0]); event.currentTarget.value = ""; }}/></label></section>
    <section className="rights-banner"><ShieldCheck/><label><input type="checkbox" checked={rights} onChange={(event) => setRights(event.target.checked)}/><span><b>授权与同源确认</b>我拥有这些作品或具有分析授权，并确认本次所选来源属于同一作者。</span></label></section>
    <section className="source-table"><div className="source-table-head"><span>蒸馏</span><span>来源文件</span><span>确定性统计</span><span>哈希与状态</span><span>顺序</span></div>{available.map((source, index) => { const sentence = source.metrics.sentence_length as Record<string, unknown> | undefined; const validation = source.metrics.validation as Record<string, unknown> | undefined; return <article key={source.id}><input type="checkbox" checked={selected.includes(source.id)} onChange={(event) => setSelected((prior) => event.target.checked ? [...prior, source.id] : prior.filter((item) => item !== source.id))}/><div><FileText/><span><b><i className="source-order-number">{index + 1}</i>{source.original_name}</b><small>{bytes(source.size_bytes)} · {source.media_type}</small></span></div><div><b>{String(source.metrics.chapter_count || source.metrics.detected_chapters || "—")} 单元 · 句中位 {String(sentence?.median || "—")}</b><small>对白比 {String(source.metrics.dialogue_character_ratio || "—")} · 留出一致性 {String(validation?.holdout_consistency || "待重算")}</small></div><code>{source.sha256.slice(0, 16)}</code><div className="source-row-actions"><button className="icon-button" disabled={index === 0 || busy === "author-source-order"} onClick={() => move(source.id, -1)} aria-label={`上移 ${source.original_name}`}><ArrowUp/></button><button className="icon-button" disabled={index === available.length - 1 || busy === "author-source-order"} onClick={() => move(source.id, 1)} aria-label={`下移 ${source.original_name}`}><ArrowDown/></button><button className="icon-button danger" onClick={() => remove(source.id)} aria-label="移入来源回收区"><Trash2/></button></div></article>; })}{!available.length && <div className="quiet-empty large">尚未上传来源。AI 创建作者不需要任何来源文件。</div>}</section>
    <div className="distill-action"><div><h3>深度蒸馏所选 {orderedSelected.length} 部作品</h3><p>{orderedSelected.length > 1 ? `将按上方 1 → ${available.length} 的作品顺序读取，再逐本独立分析、等权聚合并提取跨作品作者核心；调整顺序不会改变等权权重。` : "单本可以蒸馏，但只能证明跨片段稳定性，作者核心置信度会被限制；建议选择同一作者至少两部作品。"}</p></div><button className="primary" disabled={!orderedSelected.length || busy === "author-distill" || Boolean(candidate && (["queued", "running"].includes(candidate.job.status) || (candidate.pipeline && ["running", "advancing", "retrying"].includes(candidate.pipeline.pipeline_status))))} onClick={distill}><Fingerprint/>开始深度蒸馏</button></div>
    {job && <CandidatePanel bundle={candidate} busy={busy} onEdit={() => navigate(`/authors/${author.id}/style?base=${candidate?.candidateVersion?.id || ""}`)} onKeep={() => navigate(`/authors/${author.id}/versions`)} onPublish={publish} onRetry={retry}/>} 
  </div>;
}

function AuthorVersions() {
  const {author, busy, run, refreshAuthor, refreshAuthors} = useAuthorDetail();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const versions = author.versions || [];
  const [leftId, setLeftId] = useState(versions[1]?.id || versions[0]?.id || "");
  const [rightId, setRightId] = useState(params.get("focus") || versions[0]?.id || "");
  const left = versions.find((item) => item.id === leftId);
  const right = versions.find((item) => item.id === rightId);
  const changed = useMemo(() => {
    if (!left || !right) return [];
    return [...new Set([...Object.keys(left.profile), ...Object.keys(right.profile)])].filter((key) => JSON.stringify(left.profile[key]) !== JSON.stringify(right.profile[key]));
  }, [left, right]);
  const publish = (versionId: string) => run("author-version-publish", async () => { await post(`/api/authors/${author.id}/versions/${versionId}/publish`); await refreshAuthor(); await refreshAuthors(); });
  const archive = (versionId: string) => run("author-version-archive", async () => { await post(`/api/authors/${author.id}/versions/${versionId}/archive`); await refreshAuthor(); await refreshAuthors(); });
  return <div className="author-task-page version-page"><section className="task-page-head"><div><p className="eyebrow">VERSION CONTROL</p><h2>不可变版本中心</h2><p>发布只是让版本获得绑定资格；已经绑定旧版本的作品不会自动升级。</p></div><Link className="button-link primary" to={`/authors/${author.id}/style`}><Plus/>创建新草稿</Link></section>
    <section className="version-compare"><div className="compare-selects"><label><span>基准版本</span><select value={leftId} onChange={(event) => setLeftId(event.target.value)}>{versions.map((version) => <option key={version.id} value={version.id}>v{version.version_number} · {statusText(version.status)}</option>)}</select></label><GitCompare/><label><span>目标版本</span><select value={rightId} onChange={(event) => setRightId(event.target.value)}>{versions.map((version) => <option key={version.id} value={version.id}>v{version.version_number} · {statusText(version.status)}</option>)}</select></label></div>{left && right ? <div className="diff-list"><h3>{changed.length} 个顶层规则域发生变化</h3>{changed.map((key) => <details key={key}><summary>{key}<ChevronRight/></summary><div><pre>{JSON.stringify(left.profile[key], null, 2)}</pre><pre>{JSON.stringify(right.profile[key], null, 2)}</pre></div></details>)}</div> : <div className="quiet-empty">至少需要一个版本才能比较。</div>}</section>
    <section className="version-timeline">{versions.map((version) => { const certification = distillationCertification(version); return <article className={params.get("focus") === version.id ? "focused" : ""} key={version.id}><div className="version-node">v{version.version_number}</div><div className="version-copy"><div><h3>版本 v{version.version_number}</h3><StateTag value={version.status}/>{certification === "certified" && <span className="certification-tag">全文蒸馏认证</span>}{certification === "legacy" && <span className="legacy-tag">旧版 · 未全文认证</span>}</div><p>Profile SHA-256 · {version.profile_hash}</p><small>{fmt(version.published_at || version.created_at)} · 来源 {version.source_manifest.length} 个</small><DistillationGrowthSummary version={version}/></div><div className="version-row-actions"><button className="secondary" onClick={() => navigate(`/authors/${author.id}/style?base=${version.id}`)}><PencilLine/>以此为基础</button>{version.status === "draft" && <button className="primary" disabled={busy === "author-version-publish"} onClick={() => publish(version.id)}>发布</button>}{version.status === "published" && <button className="secondary" onClick={() => archive(version.id)}><Archive/>归档</button>}{version.status === "archived" && <button className="secondary" onClick={() => publish(version.id)}>恢复发布</button>}</div></article>; })}{!versions.length && <div className="quiet-empty large">还没有作者版本。进入文风工作室创建第一份草稿。</div>}</section>
  </div>;
}

function DistillationGrowthSummary({version}: {version: AuthorVersion}) {
  const growth = version.profile.distillation_growth;
  if (!growth) return null;
  const labels: Record<string, string> = {new: "新方法", strengthened: "证据增强", weakened: "证据减弱", contradicted: "出现反例", upgraded: "升级", downgraded: "降级", retired: "退役", unchanged: "稳定"};
  const visible = Object.entries(growth.summary).filter(([, count]) => Number(count) > 0);
  const sources = growth.source_changes;
  return <details className="distillation-growth"><summary><span>增长蒸馏</span><b>{visible.filter(([key]) => key !== "unchanged").reduce((total, [, count]) => total + Number(count), 0)} 项变化</b><ChevronRight/></summary><div><p>来源：新增 {sources.added.length} · 变更 {sources.changed.length} · 移除 {sources.removed.length} · 复用 {sources.unchanged.length}</p><div>{visible.map(([key, count]) => <span key={key}>{labels[key] || key}<b>{count}</b></span>)}</div>{growth.dimension_changes.some((item) => item.change !== "unchanged") && <ul>{growth.dimension_changes.filter((item) => item.change !== "unchanged").slice(0, 12).map((item) => <li key={item.dimension_id}><b>{item.label}</b><span>{labels[item.change] || item.change} · {item.old_scope || "新建"} → {item.new_scope || "退役"} · 证据 {item.old_evidence_count} → {item.new_evidence_count}</span></li>)}</ul>}</div></details>;
}

function effectLabel(value: AuthorBindingAudit["effectState"]) {
  return value === "active_and_next" ? "当前运行与后续工作流均生效" : value === "next_workflow_only" ? "当前运行保留旧快照；下个工作流生效" : value === "next_workflow" ? "后续新工作流生效" : "尚未绑定作者版本";
}

function AuthorBooks() {
  const {author, projects, busy, run, refreshAuthor, onOpenProject} = useAuthorDetail();
  const [bookId, setBookId] = useState(projects[0]?.id || "");
  const [audits, setAudits] = useState<Record<string, AuthorBindingAudit>>({});
  const refreshAudits = useCallback(async () => {
    const ids = author.bindings?.map((item) => item.book_id) || [];
    const values = await Promise.all(ids.map(async (id) => [id, await api<AuthorBindingAudit>(`/api/projects/${id}/author-binding`)] as const));
    setAudits(Object.fromEntries(values));
  }, [author.bindings]);
  useEffect(() => { if (!bookId && projects[0]?.id) setBookId(projects[0].id); }, [bookId, projects]);
  useEffect(() => { void refreshAudits(); }, [refreshAudits]);
  return <div className="author-task-page author-books-page"><section className="task-page-head"><div><p className="eyebrow">AUTHOR → BOOKS</p><h2>关联作品与生效证据</h2><p>选择作者不会自动换绑。每次变更都必须先预览差异，再明确确认。</p></div></section>
    <section className="author-content-panel binding-launcher"><div><h3>给一本作品绑定 {author.name}</h3><p>可以选择未关联作品，也可以替换已有作者。当前运行中的工作流仍使用启动时冻结的策略。</p></div><select value={bookId} onChange={(event) => setBookId(event.target.value)}><option value="">选择作品</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}</select></section>
    {bookId && <AuthorBindingManager bookId={bookId} fixedAuthor={author} busy={busy} run={run} onChanged={async () => { await refreshAuthor(); await refreshAudits(); }}/>} 
    <section className="linked-work-shelf"><div className="content-panel-head"><div><span>BOUND WORKS</span><h2>真实关联作品</h2></div><em>{author.bindings?.length || 0} 本</em></div>{author.bindings?.length ? author.bindings.map((binding) => {
      const audit = audits[binding.book_id];
      const policy = audit?.compiledPolicy;
      return <article key={binding.book_id}><div className="linked-work-title"><BookOpen/><div><h3>{binding.book_title}</h3><p>作者版本 v{binding.version_number} · {binding.profile_hash.slice(0, 16)}</p></div><button className="secondary" onClick={() => onOpenProject(binding.book_id)}>打开作品</button></div><div className="binding-chain-row"><span><b>作者版本</b>v{binding.version_number}</span><ChevronRight/><span><b>作品绑定</b>{binding.updated_at ? fmt(binding.updated_at) : "—"}</span><ChevronRight/><span><b>编译策略</b>{String(policy?.policy_hash || binding.compiled_policy_hash || "待编译").slice(0, 16)}</span><ChevronRight/><span><b>工作流快照</b>{String(audit?.activeWorkflowPolicy?.policy_hash || "尚无运行快照").slice(0, 16)}</span></div><div className={`effect-proof effect-${audit?.effectState || binding.effect_state}`}><ShieldCheck/><div><b>{effectLabel(audit?.effectState || binding.effect_state)}</b><p>注入规则 {policy?.active_rules?.length || 0} 条 · 冲突拦截 {policy?.conflicts?.length || 0} 条</p></div></div>{Boolean(policy?.conflicts?.length) && <details className="conflict-details"><summary>查看被硬规则 / Canon 压制的冲突</summary>{policy!.conflicts!.map((item, index) => <p key={index}><b>{item.category}</b>{item.rule}<small>{item.reason}</small></p>)}</details>}</article>;
    }) : <div className="quiet-empty large">这个作者可以保持零关联。等开书或准备换绑时，再从上方选择作品。</div>}</section>
  </div>;
}

export function BookAuthorBindingPanel({project, busy, run, onChanged}: {project?: ProjectSummary; busy: string; run: Run; onChanged?: () => Promise<void>}) {
  if (!project) return <section className="author-content-panel"><div className="quiet-empty">请选择作品后管理作者绑定。</div></section>;
  return <AuthorBindingManager bookId={project.id} busy={busy} run={run} onChanged={onChanged}/>;
}

function AuthorBindingManager({bookId, fixedAuthor, busy, run, onChanged}: {bookId: string; fixedAuthor?: AuthorProfile; busy: string; run: Run; onChanged?: () => Promise<void>}) {
  const [authors, setAuthors] = useState<AuthorProfile[]>(fixedAuthor ? [fixedAuthor] : []);
  const [versionId, setVersionId] = useState("");
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [audit, setAudit] = useState<AuthorBindingAudit | null>(null);
  const refresh = useCallback(async () => {
    const nextAudit = await api<AuthorBindingAudit>(`/api/projects/${bookId}/author-binding`); setAudit(nextAudit);
    if (fixedAuthor) { setAuthors([fixedAuthor]); return; }
    const summaries = await api<{authors: AuthorProfileSummary[]}>("/api/authors?status=active");
    const details = await Promise.all(summaries.authors.map((item) => api<{author: AuthorProfile}>(`/api/authors/${item.id}`).then((value) => value.author)));
    setAuthors(details);
  }, [bookId, fixedAuthor]);
  useEffect(() => { setVersionId(""); setPreview(null); void refresh(); }, [refresh]);
  const versions = authors.flatMap((author) => (author.versions || []).filter((version) => version.status === "published").map((version) => ({author, version})));
  const previewBinding = () => run("binding-preview", async () => { if (!versionId) throw new Error("请选择已发布作者版本"); setPreview(await post(`/api/projects/${bookId}/author-binding/preview`, {authorProfileVersionId: versionId})); });
  const apply = () => run("binding-apply", async () => { if (!versionId || !preview) throw new Error("请先预览差异"); await put(`/api/projects/${bookId}/author-binding`, {authorProfileVersionId: versionId}); setPreview(null); await refresh(); await onChanged?.(); });
  const current = audit?.binding;
  const policy = audit?.compiledPolicy;
  return <section className="binding-manager"><div className="binding-current"><div><span>当前作品绑定</span><h3>{current ? `${current.author_name} · v${current.version_number}` : "尚未绑定作者"}</h3><p>{effectLabel(audit?.effectState || "unbound")}</p></div><div className="policy-hash-block"><span>作者哈希<code>{String(current?.profile_hash || "—").slice(0, 16)}</code></span><span>策略哈希<code>{String(policy?.policy_hash || "—").slice(0, 16)}</code></span><span>运行快照<code>{String(audit?.activeWorkflowPolicy?.policy_hash || "—").slice(0, 16)}</code></span></div></div><div className="binding-controls-large"><label><span>目标作者版本</span><select value={versionId} onChange={(event) => { setVersionId(event.target.value); setPreview(null); }}><option value="">请选择已发布版本</option>{versions.map(({author, version}) => <option key={version.id} value={version.id}>{author.name} · v{version.version_number} · {version.profile_hash.slice(0, 10)}</option>)}</select></label><button className="secondary" disabled={!versionId || busy === "binding-preview"} onClick={previewBinding}><GitCompare/>预览差异</button></div>{preview && <div className="binding-preview-large"><div><h3>{Array.isArray(preview.changed_fields) ? preview.changed_fields.length : 0} 个规则域变化</h3><p>已有正文不变；确认后重编译作品策略，运行中的工作流仍保留旧快照。</p></div><div className="binding-diff-list">{(Array.isArray(preview.changed_fields) ? preview.changed_fields : []).map((item, index) => { const change = item as Record<string, unknown>; return <details key={index}><summary>{String(change.field)}<ChevronRight/></summary><div><pre>{JSON.stringify(change.before, null, 2)}</pre><pre>{JSON.stringify(change.after, null, 2)}</pre></div></details>; })}</div><button className="primary" disabled={busy === "binding-apply"} onClick={apply}><Link2/>确认绑定并用于新工作流</button></div>}{policy && <details className="public-policy"><summary><ShieldCheck/>查看公开编译策略与冲突</summary><div className="policy-summary"><span>生效规则 <b>{policy.active_rules?.length || 0}</b></span><span>冲突拦截 <b>{policy.conflicts?.length || 0}</b></span><span>优先级 <b>{policy.precedence?.length || 0} 层</b></span></div>{policy.active_rules?.map((rule, index) => <p key={index}><b>{rule.category}</b>{rule.rule}</p>)}</details>}</section>;
}

const blankPersona = (): AuthorPersona => ({
  public_identity: "", speaking_tone: "", reader_relationship: "", humor_style: "", emotional_openness: "",
  values: [], preferred_topics: [], avoided_topics: [], interaction_habits: [], authenticity_rules: [], boundaries: [],
});
const personaListFields: Array<{key: keyof AuthorPersona; label: string; hint: string}> = [
  {key: "values", label: "稳定价值取向", hint: "每行一项；只写愿意公开坚持的价值"},
  {key: "preferred_topics", label: "适合主动谈的话题", hint: "创作感受、读者互动、生活观察等"},
  {key: "avoided_topics", label: "主动回避的话题", hint: "不希望被 AI 擅自触碰的主题"},
  {key: "interaction_habits", label: "互动习惯", hint: "如何称呼、回应和邀请读者参与"},
  {key: "authenticity_rules", label: "真实性规则", hint: "例如：不虚构亲身经历，不冒充专业身份"},
  {key: "boundaries", label: "公开边界", hint: "隐私、争议、剧透、商业表达等边界"},
];

function AuthorPersonaStudio() {
  const {author, busy, run, refreshAuthor, refreshAuthors} = useAuthorDetail();
  const [persona, setPersona] = useState<AuthorPersona>({...blankPersona(), ...(author.persona || {})});
  const [instruction, setInstruction] = useState("");
  const [job, setJob] = useState<AgentJob | null>(null);
  const candidate = useCreativeJob(job);
  useEffect(() => setPersona({...blankPersona(), ...(author.persona || {})}), [author.id, author.persona]);
  const save = () => run("author-persona-save", async () => {
    await put(`/api/authors/${author.id}`, {persona}); await refreshAuthor(); await refreshAuthors();
  });
  const generate = () => run("author-persona-ai", async () => {
    if (!instruction.trim()) throw new Error("请先描述希望公开呈现的作者人格");
    const value = await post<{job: AgentJob}>(`/api/authors/${author.id}/persona/ai-draft`, {instruction}); setJob(value.job);
  });
  const applyCandidate = () => {
    const value = candidate?.artifact?.persona;
    if (!value || Array.isArray(value) || typeof value !== "object") return;
    setPersona({...blankPersona(), ...(value as AuthorPersona)}); setJob(null);
  };
  const retry = () => job && run("author-persona-retry", async () => {
    const value = await post<{job: AgentJob}>(`/api/jobs/${job.id}/retry`); setJob(value.job);
  });
  const setList = (key: keyof AuthorPersona, value: string) => setPersona({...persona, [key]: value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)});
  return <div className="author-task-page persona-page">
    <section className="task-page-head"><div><p className="eyebrow">PUBLIC PERSONA</p><h2>作者个人人设</h2><p>管理作者面对读者时的公开人格。它不等于小说文风，也不会进入小说正文生成。</p></div><span className="author-state author-state-active">独立档案</span></section>
    <section className="persona-boundary"><UserRound/><div><b>默认独立，可显式协同</b><p>个人人设主要服务作者公开表达，小说文风主要服务作品写作；一方不会推导或限制另一方。开朗作者完全可以写阴暗作品。生成个人谈时，只有你显式选择才会借用某本书的表达气质。</p></div></section>
    <section className="author-focus-panel persona-ai-panel"><div className="focus-copy"><h2>用 AI 起草人设候选</h2><p>候选不会自动保存，也不会建立或修改任何文风版本。请描述公开形象，不要要求 AI 虚构真实经历。</p></div><div className="focus-form"><label><span>人设方向</span><textarea value={instruction} maxLength={4000} onChange={(event) => setInstruction(event.target.value)} placeholder="例如：平时开朗但不装熟，愿意谈创作卡点，会自嘲，不消费隐私，不对读者说教……"/></label><button className="primary" disabled={!instruction.trim() || Boolean(candidate && ["queued", "running"].includes(candidate.job.status))} onClick={generate}><Sparkles/>生成独立人设候选</button></div></section>
    {candidate && <section className={`creative-candidate ${candidate.job.status === "failed" ? "failed" : ""}`}>{["queued", "running"].includes(candidate.job.status) ? <><LoaderCircle className="spin"/><div><h3>Antigravity 正在设计个人人设</h3><p>只读取作者基础档案和本次要求，不读取小说文风。</p></div></> : candidate.job.status === "succeeded" ? <><UserRound/><div><h3>候选已完成，尚未保存</h3><p>{String((candidate.artifact?.persona as Record<string, unknown> | undefined)?.public_identity || "")}</p><div className="inline-actions"><button className="secondary" onClick={() => setJob(null)}>放弃</button><button className="primary" onClick={applyCandidate}><Check/>载入编辑器</button></div></div></> : <><CircleAlert/><div><h3>人设候选未完成</h3><p>{candidate.job.error}</p><button className="secondary" onClick={retry}>重试</button></div></>}</section>}
    <section className="author-content-panel persona-editor"><div className="content-panel-head"><div><span>MANUAL EDITOR</span><h2>公开人格编辑器</h2></div><button className="primary" disabled={busy === "author-persona-save"} onClick={save}><Save/>保存个人人设</button></div>
      <div className="persona-text-grid"><label><span>公开自我定位</span><textarea value={persona.public_identity} onChange={(event) => setPersona({...persona, public_identity: event.target.value})}/></label><label><span>日常表达口吻</span><textarea value={persona.speaking_tone} onChange={(event) => setPersona({...persona, speaking_tone: event.target.value})}/></label><label><span>与读者的关系</span><textarea value={persona.reader_relationship} onChange={(event) => setPersona({...persona, reader_relationship: event.target.value})}/></label><label><span>幽默习惯</span><textarea value={persona.humor_style} onChange={(event) => setPersona({...persona, humor_style: event.target.value})}/></label><label><span>情绪袒露程度</span><textarea value={persona.emotional_openness} onChange={(event) => setPersona({...persona, emotional_openness: event.target.value})}/></label></div>
      <div className="persona-list-grid">{personaListFields.map((field) => <label key={field.key}><span>{field.label}<small>{field.hint}</small></span><textarea value={(persona[field.key] as string[]).join("\n")} onChange={(event) => setList(field.key, event.target.value)}/></label>)}</div>
    </section>
  </div>;
}

function AuthorPersonalTalks() {
  const {author, busy, run} = useAuthorDetail();
  const [talks, setTalks] = useState<PersonalTalk[]>([]);
  const [editingId, setEditingId] = useState("");
  const [form, setForm] = useState({title: "", content: "", linkedBookId: "", progressThroughChapter: 0, styleInfluence: "none" as "none" | "current_book"});
  const [availableChapters, setAvailableChapters] = useState<Array<{chapter: number; title: string}>>([]);
  const [sourceJobId, setSourceJobId] = useState("");
  const [instruction, setInstruction] = useState("");
  const [job, setJob] = useState<AgentJob | null>(null);
  const candidate = useCreativeJob(job);
  const refresh = useCallback(async () => setTalks((await api<{talks: PersonalTalk[]}>(`/api/authors/${author.id}/personal-talks`)).talks), [author.id]);
  useEffect(() => { void refresh(); }, [refresh]);
  const reset = () => { setEditingId(""); setForm({title: "", content: "", linkedBookId: "", progressThroughChapter: 0, styleInfluence: "none"}); setAvailableChapters([]); setSourceJobId(""); setInstruction(""); setJob(null); };
  const selectBook = (bookId: string) => run("personal-talk-context", async () => {
    setSourceJobId(""); setJob(null);
    if (!bookId) { setAvailableChapters([]); setForm({...form, linkedBookId: "", progressThroughChapter: 0, styleInfluence: "none"}); return; }
    const detail = await api<ProjectDetail>(`/api/projects/${bookId}`);
    const chapters = (detail.chapters || []).map((item) => ({chapter: Number(item.chapter_number || 0), title: String(item.title || ""), status: String(item.status || "")}))
      .filter((item) => item.chapter > 0 && item.status !== "planned")
      .sort((a, b) => a.chapter - b.chapter);
    setAvailableChapters(chapters);
    setForm({...form, linkedBookId: bookId, progressThroughChapter: chapters.at(-1)?.chapter || 0});
  });
  const generate = () => run("personal-talk-ai", async () => {
    if (!instruction.trim()) throw new Error("请说明这次想和读者谈什么");
    const value = await post<{job: AgentJob}>(`/api/authors/${author.id}/personal-talks/ai-draft`, {...form, instruction}); setJob(value.job);
  });
  const applyCandidate = () => {
    if (!candidate?.artifact) return;
    setForm({...form, title: String(candidate.artifact.title || ""), content: String(candidate.artifact.content || "")}); setSourceJobId(candidate.job.id); setJob(null);
  };
  const save = (status: "draft" | "ready" = "draft") => run("personal-talk-save", async () => {
    const payload = {...form, status, sourceJobId: sourceJobId || null};
    if (editingId) await put(`/api/authors/${author.id}/personal-talks/${editingId}`, payload);
    else await post(`/api/authors/${author.id}/personal-talks`, payload);
    await refresh(); reset();
  });
  const edit = async (talk: PersonalTalk) => {
    setEditingId(talk.id); setSourceJobId(talk.sourceJobId || ""); setInstruction(""); setJob(null);
    if (talk.linkedBookId) {
      const detail = await api<ProjectDetail>(`/api/projects/${talk.linkedBookId}`);
      setAvailableChapters((detail.chapters || []).map((item) => ({chapter: Number(item.chapter_number || 0), title: String(item.title || "")})).filter((item) => item.chapter > 0).sort((a, b) => a.chapter - b.chapter));
    } else setAvailableChapters([]);
    setForm({title: talk.title, content: talk.content, linkedBookId: talk.linkedBookId || "", progressThroughChapter: progress(talk), styleInfluence: talk.styleInfluence});
    window.scrollTo({top: 0, behavior: "smooth"});
  };
  const updateStatus = (talk: PersonalTalk, status: PersonalTalk["status"]) => run("personal-talk-status", async () => { await put(`/api/authors/${author.id}/personal-talks/${talk.id}`, {status}); await refresh(); });
  const remove = (talk: PersonalTalk) => run("personal-talk-delete", async () => { if (!window.confirm(`删除个人谈“${talk.title}”吗？本地产物会移入作者回收区。`)) return; await del(`/api/authors/${author.id}/personal-talks/${talk.id}`); await refresh(); if (editingId === talk.id) reset(); });
  const copyTalk = async (talk: PersonalTalk) => navigator.clipboard.writeText(`${talk.title}\n\n${talk.content}`);
  const boundBooks = author.bindings || [];
  const progress = (talk: PersonalTalk) => Number((talk.progressSnapshot as Record<string, unknown>)?.progressed_through || 0);
  return <div className="author-task-page personal-talk-page">
    <section className="task-page-head"><div><p className="eyebrow">PERSONAL TALKS</p><h2>个人谈</h2><p>作者独立内容流。可关联作品当前进度，但不进入小说章节、目录、字数、Canon 或质量审查。</p></div><button className="secondary" onClick={reset}><Plus/>新建个人谈</button></section>
    <section className="personal-talk-composer"><div className="talk-context-row"><label><span>关联作品（可选）</span><select value={form.linkedBookId} onChange={(event) => selectBook(event.target.value)}><option value="">不关联作品</option>{boundBooks.map((binding) => <option key={binding.book_id} value={binding.book_id}>{binding.book_title}</option>)}</select></label><label><span>可公开剧情截止</span><select disabled={!form.linkedBookId || !availableChapters.length} value={form.progressThroughChapter} onChange={(event) => { setSourceJobId(""); setJob(null); setForm({...form, progressThroughChapter: Number(event.target.value)}); }}><option value={0}>不提供章节剧情</option>{availableChapters.map((item) => <option key={item.chapter} value={item.chapter}>第 {item.chapter} 章{item.title ? ` · ${item.title}` : ""}</option>)}</select></label><label><span>小说文风参与</span><select disabled={!form.linkedBookId} value={form.styleInfluence} onChange={(event) => { setSourceJobId(""); setJob(null); setForm({...form, styleInfluence: event.target.value as typeof form.styleInfluence}); }}><option value="none">不参与（默认）</option><option value="current_book">显式借用本书表达气质</option></select></label></div>
      <div className="talk-ai-box"><div><Bot/><span><b>让 Antigravity 起草</b><small>读取个人人设；关联作品时读取已发生的剧情进度。默认不读取小说文风。</small></span></div><textarea value={instruction} maxLength={4000} onChange={(event) => setInstruction(event.target.value)} placeholder="例如：想和追到第八章的读者谈谈为什么这一段写得很克制，同时感谢大家对某个角色的理解，但不要剧透后续。"/><button className="primary" disabled={!instruction.trim() || Boolean(candidate && ["queued", "running"].includes(candidate.job.status))} onClick={generate}><Sparkles/>生成个人谈候选</button></div>
      {candidate && <div className={`talk-candidate ${candidate.job.status === "failed" ? "failed" : ""}`}>{["queued", "running"].includes(candidate.job.status) ? <><LoaderCircle className="spin"/><p>正在对证个人人设与可公开剧情进度……</p></> : candidate.job.status === "succeeded" ? <><div><b>{String(candidate.artifact?.title || "候选已生成")}</b><p>{String(candidate.artifact?.content || "").slice(0, 260)}</p><small>人设落实：{Array.isArray(candidate.artifact?.persona_application) ? candidate.artifact.persona_application.map(String).join("；") : "—"}</small><small>风险检查：{Array.isArray(candidate.artifact?.risks) && candidate.artifact.risks.length ? candidate.artifact.risks.map(String).join("；") : "未发现"}</small></div><button className="primary" onClick={applyCandidate}>载入编辑器</button></> : <><CircleAlert/><p>{candidate.job.error}</p><button className="secondary" onClick={() => void post<{job: AgentJob}>(`/api/jobs/${candidate.job.id}/retry`).then((value) => setJob(value.job))}>重试</button></>}</div>}
      <div className="talk-editor"><label><span>标题</span><input maxLength={100} value={form.title} onChange={(event) => setForm({...form, title: event.target.value})} placeholder="这次想聊的主题"/></label><label><span>正文</span><textarea maxLength={8000} value={form.content} onChange={(event) => setForm({...form, content: event.target.value})} placeholder="个人谈正文不会混入小说。"/></label><div><small>{form.content.length} / 8000 字符 · {editingId ? "正在编辑已有个人谈" : "新草稿"}</small><div className="inline-actions"><button className="secondary" disabled={!form.title.trim() || !form.content.trim() || busy === "personal-talk-save"} onClick={() => save("draft")}><Save/>保存草稿</button><button className="primary" disabled={!form.title.trim() || !form.content.trim() || busy === "personal-talk-save"} onClick={() => save("ready")}><Check/>保存为待发布</button></div></div></div>
    </section>
    <section className="personal-talk-list"><div className="content-panel-head"><div><span>INDEPENDENT STREAM</span><h2>个人谈记录</h2></div><em>{talks.length} 条</em></div>{talks.map((talk) => <article key={talk.id}><header><div><span className={`author-state author-state-${talk.status}`}>{({draft: "草稿", ready: "待发布", published: "已发布登记", archived: "已归档"} as Record<string, string>)[talk.status]}</span><h3>{talk.title}</h3></div><small>{fmt(talk.updatedAt)}</small></header><p>{talk.content}</p><footer><div><span>{talk.linkedBookId ? `关联 ${boundBooks.find((item) => item.book_id === talk.linkedBookId)?.book_title || talk.linkedBookId}` : "未关联作品"}</span>{talk.linkedBookId && <span>快照进度：第 {progress(talk)} 章</span>}<span>人设 {talk.personaHash.slice(0, 12)}</span><span>{talk.styleInfluence === "current_book" ? "已显式借用本书气质" : "小说文风未参与"}</span></div><div className="talk-actions"><button className="secondary" onClick={() => edit(talk)}><PencilLine/>编辑</button><button className="secondary" onClick={() => void copyTalk(talk)}><Copy/>复制用于平台帖子</button>{talk.status === "ready" && <button className="primary" onClick={() => updateStatus(talk, "published")}><Check/>登记为已发布</button>}<button className="icon-button danger" onClick={() => remove(talk)}><Trash2/></button></div></footer></article>)}{!talks.length && <div className="quiet-empty large">还没有个人谈。它们独立保存在作者空间，不会污染任何小说工程。</div>}</section>
  </div>;
}

function AuthorSettings() {
  const {author, busy, run, refreshAuthor, refreshAuthors} = useAuthorDetail();
  const navigate = useNavigate();
  const [form, setForm] = useState({name: author.name, description: author.description});
  useEffect(() => setForm({name: author.name, description: author.description}), [author.id, author.name, author.description]);
  const save = () => run("author-settings-save", async () => { await put(`/api/authors/${author.id}`, form); await refreshAuthor(); await refreshAuthors(); });
  const toggleArchive = () => run("author-settings-archive", async () => { await put(`/api/authors/${author.id}`, {status: author.status === "active" ? "archived" : "active"}); await refreshAuthor(); await refreshAuthors(); });
  const remove = () => run("author-settings-delete", async () => {
    if (author.bindings?.length) throw new Error(`此作者仍被 ${author.bindings.length} 本书绑定：${author.bindings.map((item) => item.book_title).join("、")}`);
    if (!window.confirm(`确定删除作者“${author.name}”吗？本地来源会移入 authors/.trash。`)) return;
    await del(`/api/authors/${author.id}`); await refreshAuthors(); navigate("/authors");
  });
  return <div className="author-task-page author-settings-page"><section className="task-page-head"><div><p className="eyebrow">AUTHOR SETTINGS</p><h2>作者档案与安全操作</h2><p>归档不会解除现有作品绑定；删除只允许没有关联作品的用户作者。</p></div></section><section className="author-focus-panel"><div className="focus-copy"><h2>基础档案</h2><p>内部名称仅用于管理，作品发布署名仍在每本书中独立维护。</p></div><div className="focus-form"><label><span>内部作者名称</span><input value={form.name} maxLength={80} onChange={(event) => setForm({...form, name: event.target.value})}/></label><label><span>创作方向</span><textarea value={form.description} maxLength={2000} onChange={(event) => setForm({...form, description: event.target.value})}/></label><button className="primary" disabled={!form.name.trim() || busy === "author-settings-save"} onClick={save}><Save/>保存档案</button></div></section><section className="danger-zone"><div><h2>归档与删除</h2><p>{author.bindings?.length ? `当前仍关联 ${author.bindings.length} 本作品，不能删除。请先在“关联作品”中为它们换绑。` : "当前没有关联作品，可以安全删除作者记录；来源原件会移入本地回收区。"}</p></div><div><button className="secondary" onClick={toggleArchive}><Archive/>{author.status === "active" ? "归档作者" : "恢复作者"}</button><button className="danger" disabled={Boolean(author.bindings?.length) || busy === "author-settings-delete"} onClick={remove}><Trash2/>删除作者</button></div></section></div>;
}
