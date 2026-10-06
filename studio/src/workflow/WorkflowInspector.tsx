import type { ChapterCockpit, ContextReceipt, JobArtifactBundle } from "../types";

const labels: Record<string, string> = {
  stage: "阶段", passed: "结论", public_summary: "公开结论", summary: "摘要", verdict: "判断",
  reader_experience_contract: "读者体验契约", continuity_handoff: "跨章交接", constraint_application: "约束应用",
  objective: "本章目标", obstacle: "核心阻碍", change: "价值变化", chapter_hook: "章末钩子", next_first_beat: "下一章第一拍",
  entry_state: "入口状态", exit_state: "出口状态", actual_vs_plan_check: "计划偏差检查", must_deliver: "必须交付",
  emotional_curve: "情绪曲线", information_gain: "信息增量", relationship_shift: "关系变化", promise_payoff: "承诺兑现",
  facts: "正式事实", open_threads: "未闭合线索", foreshadowing: "伏笔变化", evidence: "原文证据",
  findings: "审查发现", checks: "检查项", quality_scorecard: "质量评分", revision_brief: "返工清单",
  content: "正文", scenes: "场景卡", location: "位置", quote: "原文", repair_requirement: "修复要求",
};

const asRecord = (value: unknown): Record<string, unknown> | null => value && !Array.isArray(value) && typeof value === "object" ? value as Record<string, unknown> : null;
const asRecords = (value: unknown): Array<Record<string, unknown>> => Array.isArray(value) ? value.map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item)) : [];
const text = (value: unknown): string => value === null || value === undefined ? "—" : typeof value === "boolean" ? value ? "是" : "否" : typeof value === "string" ? value : JSON.stringify(value, null, 2);
const shortHash = (value: unknown): string => String(value || "—").length > 18 ? `${String(value).slice(0, 12)}…${String(value).slice(-6)}` : String(value || "—");

function Value({value}: {value: unknown}) {
  if (Array.isArray(value)) {
    if (!value.length) return <span className="inspector-empty">无</span>;
    if (value.every((item) => typeof item !== "object" || item === null)) return <ul className="inspector-list">{value.map((item, index) => <li key={index}>{text(item)}</li>)}</ul>;
    return <div className="inspector-stack">{value.map((item, index) => <RecordCard key={index} value={asRecord(item) || {value: item}} title={`项目 ${index + 1}`}/>)}</div>;
  }
  const record = asRecord(value);
  if (record) return <RecordCard value={record}/>;
  return <p className="inspector-text">{text(value)}</p>;
}

function isComplex(value: unknown): boolean {
  return Boolean(asRecord(value)) || (Array.isArray(value) && value.some((item) => Boolean(asRecord(item))));
}

function RecordCard({value, title}: {value: Record<string, unknown>; title?: string}) {
  return <article className="inspector-record">{title && <h4>{title}</h4>}{Object.entries(value).map(([key, item]) => <div className={`inspector-field ${isComplex(item) ? "complex" : ""}`} key={key}><span>{labels[key] || key}</span><Value value={item}/></div>)}</article>;
}

function ReviewArtifact({artifact}: {artifact: Record<string, unknown>}) {
  const evidence = asRecords(artifact.evidence);
  const findings = asRecords(artifact.findings);
  const checks = asRecords(artifact.checks);
  const scorecard = asRecord(artifact.quality_scorecard);
  return <div className="semantic-artifact">
    <header className={`artifact-verdict ${artifact.passed === true ? "passed" : artifact.passed === false ? "failed" : ""}`}><div><span>质量闸门</span><h3>{artifact.passed === true ? "通过" : artifact.passed === false ? "需要返工" : "已完成判断"}</h3></div><p>{text(artifact.public_summary || artifact.summary || artifact.verdict || "所有判断均以公开检查项和原文证据为准。")}</p></header>
    {scorecard && <section><h4>评分卡</h4><div className="scorecard-grid">{Object.entries(scorecard).map(([key, value]) => { const item = asRecord(value); return <article key={key}><span>{labels[key] || key}</span><b>{text(item?.score ?? value)}</b></article>; })}</div></section>}
    {checks.length > 0 && <section><h4>检查项</h4><div className="check-grid">{checks.map((item, index) => <article className={item.passed === false ? "failed" : "passed"} key={index}><b>{String(item.name || `检查 ${index + 1}`)}</b><span>{item.passed === false ? "未通过" : "通过"}</span><small>证据 {Array.isArray(item.evidence_refs) ? item.evidence_refs.length : 0} 条</small></article>)}</div></section>}
    {findings.length > 0 && <section><h4>需要处理的问题</h4><div className="inspector-stack">{findings.map((item, index) => <RecordCard key={index} value={item} title={`问题 ${index + 1}`}/>)}</div></section>}
    {evidence.length > 0 && <section><h4>正文原句证据</h4><div className="evidence-list">{evidence.map((item, index) => <blockquote key={index}><span>{String(item.evidence_id || `E${index + 1}`)} · {String(item.location || "正文")}</span><p>{String(item.quote || "")}</p></blockquote>)}</div></section>}
    {Array.isArray(artifact.revision_brief) && artifact.revision_brief.length > 0 && <section><h4>可执行返工清单</h4><Value value={artifact.revision_brief}/></section>}
  </div>;
}

function DesignArtifact({artifact}: {artifact: Record<string, unknown>}) {
  const contract = asRecord(artifact.reader_experience_contract);
  const handoff = asRecord(artifact.continuity_handoff);
  const applications = asRecords(artifact.constraint_application);
  return <div className="semantic-artifact">
    <header className="artifact-verdict"><div><span>章节设计</span><h3>{String(artifact.title || artifact.chapter_title || "可执行章节契约")}</h3></div><p>先锁定读者获得什么、人物状态如何变化，再把约束映射到具体场景。</p></header>
    {contract && <section><h4>读者体验契约</h4><RecordCard value={contract}/></section>}
    {handoff && <section><h4>跨章交接</h4><RecordCard value={handoff}/></section>}
    {applications.length > 0 && <section><h4>规则如何落到场景</h4><div className="inspector-stack">{applications.map((item, index) => <RecordCard value={item} title={`应用 ${index + 1}`} key={index}/>)}</div></section>}
    {Boolean(artifact.scenes) && <section><h4>场景卡</h4><Value value={artifact.scenes}/></section>}
  </div>;
}

export function SemanticArtifact({stage, bundle}: {stage: string; bundle: JobArtifactBundle | null}) {
  const artifact = bundle?.artifact;
  if (!artifact) return <p className="muted">等待阶段 JSON 产物落盘；CLI 的确认话不会被当成生成内容。</p>;
  const actualStage = String(artifact.stage || stage);
  if (actualStage.includes("review")) return <ReviewArtifact artifact={artifact}/>;
  if (actualStage === "chapter_design" || actualStage === "story_foundation") return <DesignArtifact artifact={artifact}/>;
  if ((actualStage === "draft" || actualStage.startsWith("revise_")) && typeof artifact.content === "string") return <div className="semantic-artifact"><header className="artifact-verdict"><div><span>正文产物</span><h3>完整候选正文</h3></div><p>仍需通过逻辑、人物声音、连续性、冷读与 Canon 闸门。</p></header><section><div className="prose-preview">{artifact.content}</div></section></div>;
  if (actualStage === "canon_update") return <div className="semantic-artifact"><header className="artifact-verdict passed"><div><span>Canon 去向</span><h3>最终正文事实增量</h3></div><p>仅最终通过的正文可以进入正式事实库。</p></header><RecordCard value={artifact}/></div>;
  return <div className="semantic-artifact"><header className="artifact-verdict"><div><span>阶段产物</span><h3>{labels[actualStage] || actualStage}</h3></div><p>已按业务字段整理；完整对象可在“原始 JSON”查看。</p></header><RecordCard value={artifact}/></div>;
}

export function PublicRecord({value, empty}: {value: Record<string, unknown> | null | undefined; empty: string}) {
  return value && Object.keys(value).length ? <div className="semantic-artifact"><RecordCard value={value}/></div> : <p className="muted">{empty}</p>;
}

export function ContextReceiptView({receipt}: {receipt: ContextReceipt | null}) {
  if (!receipt) return <p className="muted">正在读取本阶段的公开上下文收据。收据不会返回上传范文原文或模型隐藏思维。</p>;
  const hardRules = Array.isArray(receipt.hardRules) ? receipt.hardRules : [];
  return <div className="semantic-artifact context-receipt">
    <header className="artifact-verdict"><div><span>上下文应用收据</span><h3>{receipt.executableRules.length} 条写作规则已编译</h3></div><p>must {receipt.classificationCounts?.must || 0} · should {receipt.classificationCounts?.should || 0} · avoid {receipt.classificationCounts?.avoid || 0}；硬规则 {hardRules.length} 条；另有 {receipt.withheldForOtherStages} 条仅用于其他阶段。</p></header>
    <section><h4>本阶段实际读取</h4><div className="context-blocks">{receipt.contextBlocks.length ? receipt.contextBlocks.map((item) => <article key={item.key}><b>{item.key}</b><span>已纳入</span><p>{item.purpose}</p></article>) : <p className="muted">该任务未签发 StageActionV2 最小上下文清单。</p>}</div></section>
    <section><h4>可执行文风规则</h4>{receipt.executableRules.length ? <div className="rule-receipts">{receipt.executableRules.map((item, index) => <article key={String(item.rule_id || index)}><span>{String(item.class || "should")} · {String(item.category || item.axis || "文风规则")}</span><p>{String(item.instruction || "")}</p><small>激活：{String(item.activation || "stage_applicable")} · {String(item.activation_reason || "当前阶段适用")}</small>{Array.isArray(item.scene_ids) && item.scene_ids.length > 0 && <small>场景：{item.scene_ids.map(String).join("、")}</small>}{Boolean(item.trigger) && <small>触发：{String(item.trigger)}</small>}{Boolean(item.avoid) && <small>避免：{String(item.avoid)}</small>}</article>)}</div> : <p className="muted">本阶段没有适用的作者文风规则；硬规则与 Canon 仍照常生效。</p>}{receipt.unmappedRuleIds?.length > 0 && <p className="muted">{receipt.unmappedRuleIds.length} 条规则尚未被设计映射，已作为全文底线或自然倾向保留，不会静默丢失。</p>}</section>
    <section><h4>硬规则</h4>{hardRules.length ? <div className="rule-receipts">{hardRules.map((item, index) => {const rule = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {}; return <article key={String(rule.rule_id || index)}><span>HARD · {String(rule.category || rule.axis || "硬规则")}</span><p>{String(rule.rule || rule.instruction || JSON.stringify(item))}</p>{Boolean(rule.reason) && <small>{String(rule.reason)}</small>}</article>;})}</div> : <p className="muted">本阶段没有单独登记的硬规则；Canon、用户明确要求和 must 级基础约束仍照常生效。</p>}</section>
    {receipt.conflicts.length > 0 && <section><h4>被上位规则压制的冲突</h4><div className="inspector-stack">{receipt.conflicts.map((item, index) => <RecordCard key={index} value={item}/>)}</div></section>}
    <section><h4>交接与哈希</h4><div className="receipt-meta"><span>策略哈希 <b>{shortHash(receipt.policyHash)}</b></span><span>Prompt 哈希 <b>{shortHash(receipt.promptHash)}</b></span><span>输入约 <b>{receipt.promptEstimatedTokens.toLocaleString()} tokens</b></span><span>输出字段 <b>{receipt.outputContract.required.length} 个必填</b></span></div></section>
  </div>;
}

export function ChapterCockpitView({cockpit}: {cockpit: ChapterCockpit | null}) {
  if (!cockpit) return <p className="muted">正在装载章节计划、审查与 Canon 对账。</p>;
  if (!cockpit.available) return <p className="muted">{cockpit.notice}</p>;
  return <div className="semantic-artifact chapter-cockpit">
    <header className="artifact-verdict"><div><span>第 {cockpit.chapter} 章驾驶舱</span><h3>{cockpit.canonDelta ? "计划与实际可对账" : "计划已冻结，等待实际正文"}</h3></div><p>{cockpit.notice}</p></header>
    <div className="plan-actual-grid"><section><h4>计划交付</h4>{cockpit.readerContract ? <RecordCard value={cockpit.readerContract}/> : <p className="muted">暂无读者体验契约</p>}</section><section><h4>实际 Canon 增量</h4>{cockpit.canonDelta ? <RecordCard value={cockpit.canonDelta}/> : <p className="muted">正文通过全部闸门前保持 pending，不提前写入事实库。</p>}</section></div>
    {cockpit.continuityHandoff && <section><h4>前后章状态交接</h4><RecordCard value={cockpit.continuityHandoff}/></section>}
    {cockpit.constraintApplication.length > 0 && <section><h4>场景级约束落地</h4><div className="inspector-stack">{cockpit.constraintApplication.map((item, index) => <RecordCard value={item} title={`映射 ${index + 1}`} key={index}/>)}</div></section>}
    <section><h4>质量闸门轨迹</h4><div className="gate-timeline">{cockpit.qualityGates.length ? cockpit.qualityGates.map((gate) => <article className={gate.passed === false ? "failed" : "passed"} key={gate.stage}><b>{gate.stage}</b><span>{gate.passed === false ? "需返工" : gate.passed === true ? "通过" : "已完成"}</span><p>{gate.summary}</p><small>原文证据 {gate.evidenceCount} 条</small></article>) : <p className="muted">尚未产生审查报告。</p>}</div></section>
  </div>;
}
