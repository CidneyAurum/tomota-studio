from __future__ import annotations

from .book_lock import book_operation

import hashlib
import json
import shutil
import uuid
from copy import copy
from collections import Counter
from pathlib import Path
from typing import Any

from .authors import AuthorService, HARD_POLICY_RULES, evaluate_statistical_targets
from .deslop import DeslopFinding, run_deslop_lint
from .models import ChapterContract, ReviewFinding, ReviewGate, WorkflowRun, utc_now
from .quality_context import build_corpus_prose_guard, compare_current_to_corpus, summarize_confirmed_revision
from .review import ChapterReviewer, STRICT_GATES
from .router import SkillRouter
from .skill_adapter import SkillAdapter
from .store import ProjectStore
from .story_rigor import (
    FACT_PREDICATES,
    detect_state_regression,
    fact_contract_prompt,
    merge_state_facts,
    normalize_state_fact,
)


# 硬性策略规则的稳定 ID（约束落地记录 source="hard_rule" 时必须引用这些真实 ID）。
HARD_RULE_IDS = {
    "hard-" + hashlib.sha256(rule.encode("utf-8")).hexdigest()[:12]
    for rule in HARD_POLICY_RULES
}
MAX_REWORK_INSTRUCTION_CHARACTERS = 12_000
# Canon 的可核验字段（source="canon" 的 constraint_id 必须引用这些字段名或 `字段.索引` 路径）。
CANON_FACT_FIELDS = {
    "facts", "character_states", "relationships", "open_threads", "foreshadowing", "state_facts",
    "characters", "inventory", "locations", "timeline",
}
# 章节契约的可核验字段（source="chapter_contract" 的 constraint_id 必须引用本章真实契约的非空字段）。
CHAPTER_CONTRACT_FIELDS = {
    "objective", "obstacle", "change", "next_first_beat", "chapter_hook", "new_information",
    "current_character_goal", "relationship_state", "body_information_state", "unresolved_foreshadowing",
    "previous_force", "ending_type", "causality_check", "boundary_check", "consequence_check",
    "entry_state", "entry_trigger", "retained_consequences", "exit_state",
}


def _canon_path_resolves(canon: dict[str, Any], constraint_id: str) -> bool:
    """约束落地记录的 canon 路径必须指向真实存在且非空的事实，不能只匹配字段名。"""
    if not isinstance(canon, dict):
        return False
    parts = constraint_id.split(".")
    root = parts[0]
    if root not in CANON_FACT_FIELDS:
        return False
    value = canon.get(root)
    if not isinstance(value, list) or not value:
        return False
    if len(parts) == 1:
        return True
    if len(parts) != 2:
        return False
    try:
        index = int(parts[1])
    except ValueError:
        return False
    if index < 0 or index >= len(value):
        return False
    item = value[index]
    return item is not None and item != "" and item != {} and item != []


def _nonempty_constraint_value(value: Any) -> bool:
    return value is not None and value != "" and value != {} and value != []


def _chapter_contract_path_resolves(chapter_contract: dict[str, Any], constraint_id: str) -> bool:
    return (
        isinstance(chapter_contract, dict)
        and constraint_id in CHAPTER_CONTRACT_FIELDS
        and _nonempty_constraint_value(chapter_contract.get(constraint_id))
    )


def _rule_priority(
    rule_id: str,
    foundation_items: list[dict[str, Any]],
    style_rules: list[dict[str, Any]],
    canon: dict[str, Any],
    chapter_contract: dict[str, Any] | None = None,
) -> int | None:
    """Resolve a real rule/fact and return its precedence rank.

    A whitelist entry alone is not an authority. Canon and chapter-contract
    suppressors must resolve to a current non-empty fact/field; hard policy IDs
    are authoritative by definition. ``None`` means the ID is fabricated or
    currently empty.
    """
    priority_rank = {"must": 3, "avoid": 3, "should": 2, "optional": 1, "optional_content_tendency": 1}
    for item in foundation_items:
        if str(item.get("constraint_id") or item.get("rule_id") or "") == rule_id:
            return 300 + priority_rank.get(str(item.get("priority") or "must").lower(), 2)
    for item in style_rules:
        if str(item.get("rule_id") or "") == rule_id:
            source_rank = 200 if item.get("source") == "book_override" else 100
            return source_rank + priority_rank.get(str(item.get("class") or "must").lower(), 2)
    if rule_id in HARD_RULE_IDS:
        return 400
    if _canon_path_resolves(canon, rule_id):
        return 400
    if chapter_contract is not None and _chapter_contract_path_resolves(chapter_contract, rule_id):
        return 400
    return None


def _require_conflict_dimensions(application: dict[str, Any], field_path: str) -> list[dict[str, str]]:
    """suppressed_by_higher_rule 必须提供结构化冲突维度与双方证据路径。

    确定性代码只能证明：压制依据真实存在、非空、优先级足够，以及冲突维度
    结构完整（每个维度都有 dimension + 被压制方证据 + 压制方证据）。两条
    自然语言规则是否在语义上真的冲突，交给独立审查读取这些结构化维度复核。
    """
    dimensions = application.get("conflict_dimensions")
    if not isinstance(dimensions, list) or not dimensions:
        raise WorkflowError(
            "suppressed_by_higher_rule 必须提供 conflict_dimensions（至少一项结构化冲突维度）",
            code="artifact_schema_invalid", failure_class="contract",
            field_path=f"{field_path}.conflict_dimensions",
            expected="non-empty array of {dimension, suppressed_evidence, suppressor_evidence}", retryable=True,
        )
    normalized: list[dict[str, str]] = []
    for dim_index, dim in enumerate(dimensions):
        if not isinstance(dim, dict):
            raise WorkflowError(
                f"conflict_dimensions[{dim_index}] 必须是对象",
                code="artifact_schema_invalid", failure_class="contract",
                field_path=f"{field_path}.conflict_dimensions[{dim_index}]", retryable=True,
            )
        dimension = str(dim.get("dimension") or "").strip()
        suppressed_evidence = str(dim.get("suppressed_evidence") or "").strip()
        suppressor_evidence = str(dim.get("suppressor_evidence") or "").strip()
        if not dimension or not suppressed_evidence or not suppressor_evidence:
            raise WorkflowError(
                f"conflict_dimensions[{dim_index}] 必须提供非空的 dimension、suppressed_evidence、suppressor_evidence",
                code="artifact_schema_invalid", failure_class="contract",
                field_path=f"{field_path}.conflict_dimensions[{dim_index}]",
                expected="dimension + suppressed_evidence + suppressor_evidence", retryable=True,
            )
        normalized.append({
            "dimension": dimension,
            "suppressed_evidence": suppressed_evidence,
            "suppressor_evidence": suppressor_evidence,
        })
    return normalized


REVIEW_STAGES = {"design_review", "review_logic", "review_voice", "review_continuity", "cold_review"}
REQUIRED_CHECKS = {
    "design_review": (
        "outline_contract", "canon_consistency", "knowledge_boundaries", "foreshadow_object_clarity",
        "scene_value_change", "chapter_four_questions", "opening_hook", "voice_signature",
        "author_contract_application",
    ),
    "review_logic": (
        "text_design_alignment", "timeline", "counts_and_terms", "motivation", "consequence",
        "scene_value_change", "conflict_escalation", "choice_cost", "next_scene_entry",
    ),
    "review_voice": (
        "character_consistency", "knowledge_boundaries", "dialogue_function", "voice_swap", "anti_ai",
        "voice_distinctiveness", "dialogue_density", "emotion_grounding", "author_style_realization",
    ),
    "review_continuity": (
        "foreshadow_object", "canon_consistency", "transitions", "ending", "next_chapter",
        "pacing_curve", "ending_pull", "foreshadow_density",
    ),
    "cold_review": (
        "who", "does_what", "why", "referents", "situation_change", "reason_to_continue",
    ),
}
CHECK_DESCRIPTIONS = {
    "outline_contract": "逐项核对章节目标、阻碍、变化、读者体验契约、约束落地映射和下一章入口",
    "canon_consistency": "核对 Canon 事实、人物状态、关系与正式术语",
    "knowledge_boundaries": "核对人物在当前时点能知道与不能知道的信息",
    "foreshadow_object_clarity": "核对伏笔是否落在可追踪物件、动作或原文证据",
    "scene_value_change": "核对每场局面价值是否发生可见变化",
    "chapter_four_questions": "核对主角所求、阻碍、局面变化与继续阅读理由",
    "opening_hook": "核对开篇是否迅速建立具体异常、目标或压力",
    "voice_signature": "核对主要人物是否有可辨识且符合身份的声音规则",
    "author_contract_application": "逐条核对冻结作者方法与阶段蓝图是否映射到真实场景和验收条件，而非只声明符合",
    "text_design_alignment": "核对正文是否落实已通过的场景卡而未擅自改线",
    "timeline": "核对时间顺序、耗时、先后与同时发生关系",
    "counts_and_terms": "核对数字、次数、名称、称呼与术语一致性",
    "motivation": "核对关键行动是否有当下可见动机",
    "consequence": "核对选择是否产生后果并被后文承接",
    "conflict_escalation": "核对压力与冲突是否递进而非原地重复",
    "choice_cost": "核对关键选择是否承担代价或放弃其他路径",
    "next_scene_entry": "核对场景间是否有明确触发和进入路径",
    "character_consistency": "核对人物目标、性格、状态与行为模式一致性",
    "dialogue_function": "核对对白是否改变关系、信息、压力或决定",
    "voice_swap": "执行换声测试，确认对白不能无差别互换说话者",
    "anti_ai": "核对机械总结、抽象套话、翻译腔，并与全书指纹对照开场、描写搭配和身体反应链的模板化复用",
    "voice_distinctiveness": "核对主要人物句长、称呼、回避与施压习惯差异",
    "dialogue_density": "核对对白回合与场景承载力，避免百科问答",
    "emotion_grounding": "核对情绪是否落到身体、动作、物件与选择",
    "author_style_realization": "核对正文是否以本书自己的内容实际呈现冻结作者句法、叙述、对白和情绪方法",
    "foreshadow_object": "核对伏笔物件、读者已知和隐藏事实连续性",
    "transitions": "核对转场触发、路径、时间和视角连续性",
    "ending": "核对章末是否收在真实局面变化而非作者总结",
    "next_chapter": "核对上一章真实尾段→本章入口→下一章第一拍的状态和因果交接",
    "pacing_curve": "核对信息、压力与缓冲的整章曲线",
    "ending_pull": "核对章末是否形成具体未完成行动、选择或反证",
    "foreshadow_density": "核对伏笔铺设、推进、兑现与积压密度",
    "who": "冷读后能否明确当前核心人物是谁",
    "does_what": "冷读后能否明确人物做了什么",
    "why": "冷读后能否从正文看懂行动原因",
    "referents": "冷读后代词、物件和省略指代是否清楚",
    "situation_change": "冷读后能否说清局面发生了什么变化",
    "reason_to_continue": "冷读后是否存在具体继续阅读理由",
}
QUALITY_SCORE_FIELDS = ("scene_change", "emotional_pressure", "character_voice", "information_clarity", "ending_pull")
REVISION_BRIEF_FIELDS = ("location", "quote", "violated_rule", "repair_direction", "protected_content", "review_gate_to_rerun")
REVISION_STAGES = {"revise_logic": "review_logic", "revise_voice": "review_voice", "revise_continuity": "review_continuity", "revise_cold": "cold_review"}
MODULE_BY_STAGE = {
    "story_foundation": ["concept_planning", "character_consistency"],
    "chapter_design": ["plot_logic", "character_consistency", "dialogue", "transition"],
    "design_review": ["plot_logic", "character_consistency", "consistency_review"],
    "draft": ["plot_logic", "dialogue", "transition", "chapter_ending", "anti_ai_voice"],
    "review_logic": ["plot_logic"], "review_voice": ["dialogue", "anti_ai_voice", "character_consistency"],
    "review_continuity": ["consistency_review", "transition", "chapter_ending"],
    "cold_review": ["consistency_review"], "canon_update": ["consistency_review"],
    "arc_review": ["volume_outline", "consistency_review"],
}


class WorkflowError(RuntimeError):
    """Stable workflow failure returned to Studio as machine-readable JSON.

    Contract and evidence failures are deliberately distinct from a legitimate
    creative-review failure.  Only the latter may consume ``revision_round``.
    """

    def __init__(
        self,
        message: str,
        *,
        code: str = "workflow_error",
        failure_class: str = "workflow",
        field_path: str = "",
        expected: Any = None,
        actual: Any = None,
        retryable: bool = False,
    ):
        super().__init__(message)
        self.code = code
        self.failure_class = failure_class
        self.field_path = field_path
        self.expected = expected
        self.actual = actual
        self.retryable = retryable

    def to_dict(self) -> dict[str, Any]:
        value: dict[str, Any] = {
            "status": "error",
            "error_type": type(self).__name__,
            "error_code": self.code,
            "failure_class": self.failure_class,
            "message": str(self),
            "retryable": self.retryable,
        }
        if self.field_path:
            value["field_path"] = self.field_path
        if self.expected is not None:
            value["expected"] = self.expected
        if self.actual is not None:
            value["actual"] = self.actual
        return value


class WorkflowEngine:
    """Persistent, fail-closed state machine driven by Codex task turns."""

    def __init__(self, project_root: Path | str, *, skill_root: Path | str | None = None):
        self.root = Path(project_root).resolve()
        self.store = ProjectStore(self.root)
        self.authors = AuthorService(self.root)
        self.skill = SkillAdapter(self.root, skill_root)
        self.reviewer = ChapterReviewer(self.skill, SkillRouter())

    @book_operation(recoverable=True)
    def start(self, book_id: str, chapter_numbers: list[int], *, max_revisions: int = 5, exclusive: bool = False) -> WorkflowRun:
        self.store.initialize()
        if not self.store.get_book(book_id):
            raise WorkflowError(f"book does not exist: {book_id}")
        numbers = sorted(set(int(item) for item in chapter_numbers))
        if not numbers or any(item <= 0 for item in numbers):
            raise WorkflowError("chapter_numbers 必须是非空正整数列表")
        if not 1 <= max_revisions <= 5:
            raise WorkflowError("max_revisions 必须在 1 到 5 之间")
        for number in numbers:
            self._contract(book_id, number)
        if exclusive:
            for item in self.store.list_workflow_runs(book_id):
                if item["status"] != "running":
                    continue
                current = self.store.load_workflow_run(item["id"])
                if current.chapter_numbers == numbers:
                    return current
                raise WorkflowError("本书已有运行中的工作流，请先完成或停止后再启动")
        run = WorkflowRun(
            run_id=f"workflow-{uuid.uuid4().hex[:12]}", book_id=book_id, chapter_numbers=numbers,
            status="running", current_chapter=numbers[0], current_stage="story_foundation",
            max_revisions=max_revisions,
        )
        self.store.save_workflow_run(run)
        self._freeze_writing_policy(run)
        self.store.append_event(book_id, None, "workflow_started", {"run_id": run.run_id, "chapters": numbers, "max_revisions": max_revisions})
        self.next_action(run.run_id)
        return run

    def start_rework(self, book_id: str, chapter_number: int, feedback: str, *, max_revisions: int = 5, request_id: str = "") -> WorkflowRun:
        """Start an author-directed rework without destroying the approved version.

        Rework deliberately begins at chapter design so the requested change is
        reflected in scene structure before a new draft is produced.  The old
        body and review report remain in their authoritative locations until the
        replacement passes every gate.
        """
        return self.start_scope_rework(
            book_id, [chapter_number], feedback, scope_type="chapter",
            scope_id=str(chapter_number), max_revisions=max_revisions, request_id=request_id,
        )

    @book_operation(recoverable=True)
    def start_scope_rework(
        self,
        book_id: str,
        chapter_numbers: list[int],
        feedback: str,
        *,
        scope_type: str = "chapter",
        scope_id: str = "",
        max_revisions: int = 5,
        request_id: str = "",
    ) -> WorkflowRun:
        """Rework one or more generated chapters from a shared clean Canon.

        Every old body and review remains untouched.  Each replacement gets an
        isolated source copy and request, while the first replacement is
        designed against Canon from before the earliest affected chapter.
        """
        self.store.initialize()
        if not self.store.get_book(book_id):
            raise WorkflowError(f"book does not exist: {book_id}")
        numbers = sorted(set(int(item) for item in chapter_numbers))
        if not numbers or any(item <= 0 for item in numbers):
            raise WorkflowError("chapter_numbers 必须是非空正整数列表")
        if scope_type not in {"book", "volume", "chapter"}:
            raise WorkflowError("返工范围必须是 book、volume 或 chapter")
        feedback = str(feedback).strip()
        if not feedback or len(feedback) > MAX_REWORK_INSTRUCTION_CHARACTERS:
            raise WorkflowError(f"返工要求必须为 1—{MAX_REWORK_INSTRUCTION_CHARACTERS} 个字符")
        if not 1 <= max_revisions <= 5:
            raise WorkflowError("max_revisions 必须在 1 到 5 之间")
        run_id = f"workflow-{uuid.uuid5(uuid.NAMESPACE_URL, book_id + ':' + request_id).hex}" if request_id else f"workflow-{uuid.uuid4().hex[:12]}"
        if request_id:
            prior = self.store.load_workflow_run(run_id)
            if prior:
                prior_feedback = prior.stage_history[0].get("result") if prior.stage_history else None
                if prior.book_id != book_id or prior.chapter_numbers != numbers or prior_feedback != feedback:
                    raise WorkflowError("幂等返工编号已绑定另一份请求")
                return prior
        sources: dict[int, tuple[dict[str, Any], str]] = {}
        for number in numbers:
            self._contract(book_id, number)
            chapter = self.store.get_chapter(book_id, number)
            if not chapter or chapter.get("status") not in {"approved", "reviewed_pending_approval", "scheduled", "submitted", "published", "draft_unreviewed", "legacy_unreviewed", "modified_after_review", "invalidated"}:
                raise WorkflowError(f"第 {number} 章当前没有可返工的已生成正文状态")
            content = self.store.read_content(book_id, number).strip()
            if not content:
                raise WorkflowError(f"第 {number} 章缺少可返工的正文")
            sources[number] = (chapter, content)
        run = WorkflowRun(
            run_id=run_id, book_id=book_id, chapter_numbers=numbers,
            status="running", current_chapter=numbers[0], current_stage="chapter_design",
            max_revisions=max_revisions,
            stage_history=[{
                "stage": "rework_requested", "result": feedback,
                "scope_type": scope_type, "scope_id": scope_id,
                "affected_chapters": numbers, "at": utc_now(),
            }],
        )
        workflow_dir = self.store.book_dir(book_id) / "workflow" / run.run_id
        workflow_dir.mkdir(parents=True, exist_ok=True)
        self.store.write_json(workflow_dir / "rework-baseline-canon.json", self.store.canon_before(book_id, numbers[0]))
        lineage_statuses = {"approved", "reviewed_pending_approval", "scheduled", "submitted", "published"}
        downstream = [
            int(item["chapter_number"]) for item in self.store.list_chapters(book_id)
            if int(item["chapter_number"]) > numbers[0]
            and int(item["chapter_number"]) not in numbers
            and item.get("status") in lineage_statuses
        ]
        reason = f"reader feedback rework {scope_type}:{scope_id or numbers[0]} -> {run.run_id}"
        canon_invalidation = self.store.invalidate_canon_from(book_id, numbers[0], reason=reason)
        downstream_invalidation = self.store.invalidate_chapters(book_id, downstream, reason=reason)
        dependency_invalidation = {
            "scope_type": scope_type, "scope_id": scope_id, "affected_chapters": numbers,
            "downstream_chapters_invalidated": downstream,
            "canon": canon_invalidation, "publish_batches": downstream_invalidation.get("batches", []),
            "old_bodies_and_reviews_preserved": True,
        }
        self.store.write_json(workflow_dir / "dependency-invalidation.json", dependency_invalidation)
        for number in numbers:
            chapter, content = sources[number]
            stage_dir = self._stage_dir_for_chapter(run, number)
            stage_dir.mkdir(parents=True, exist_ok=True)
            source_path = stage_dir / "rework-source.md"
            source_path.write_text(content + "\n", encoding="utf-8")
            self.store.write_json(stage_dir / "rework-request.json", {
                "chapter_number": number, "feedback": feedback,
                "scope_type": scope_type, "scope_id": scope_id,
                "affected_chapters": numbers,
                "prior_status": chapter.get("status"),
                "prior_content_hash": chapter.get("content_hash") or hashlib.sha256(content.encode("utf-8")).hexdigest(),
                "source_path": str(source_path), "requested_at": utc_now(),
            })
            self.store.update_chapter_status(book_id, number, "modified_after_review")
        self.store.save_workflow_run(run)
        self._freeze_writing_policy(run)
        self.store.append_event(book_id, numbers[0], "scope_rework_started", {
            "run_id": run.run_id, "feedback": feedback, "scope_type": scope_type,
            "scope_id": scope_id, "affected_chapters": numbers,
            "dependency_invalidation": dependency_invalidation,
        })
        self.next_action(run.run_id)
        return run

    def start_feedback_rework(
        self, book_id: str, chapter_numbers: list[int], feedback: str, *,
        book_rules: list[dict[str, Any]], scope_type: str = "book", scope_id: str = "",
        max_revisions: int = 5,
    ) -> WorkflowRun:
        """Confirm rules and start rework as one recoverable book operation."""
        if not self.store.get_book(book_id):
            raise WorkflowError(f"book does not exist: {book_id}")
        if not isinstance(book_rules, list) or not book_rules or any(not isinstance(rule, dict) for rule in book_rules):
            raise WorkflowError("反馈返工必须提供非空 book_rules")
        if not str(feedback).strip() or len(feedback) > MAX_REWORK_INSTRUCTION_CHARACTERS:
            raise WorkflowError(f"返工要求必须为 1—{MAX_REWORK_INSTRUCTION_CHARACTERS} 个字符")
        with self.store.recoverable_book_change(book_id):
            for rule in book_rules:
                self.authors.upsert_override(book_id, rule)
            return self.start_scope_rework(book_id, chapter_numbers, feedback, scope_type=scope_type,
                                          scope_id=scope_id, max_revisions=max_revisions)

    @book_operation(recoverable=True)
    def supersede_with_candidate(
        self,
        run_id: str,
        artifact: dict[str, Any],
        *,
        source_stage: str,
        chapter_number: int | None = None,
    ) -> dict[str, Any]:
        """Apply a previously generated alternate candidate on a fresh lineage.

        The prior run and all of its artifacts remain immutable evidence.  A new
        run starts at the overridden critical stage, the active Canon pointer is
        rolled back, and affected chapter release states are invalidated.  This
        avoids pretending that an already-consumed artifact can simply be
        overwritten in place.
        """
        prior = self._run(run_id)
        if prior.status == "superseded":
            raise WorkflowError("该工作流已经被其他候选取代", code="stale_inputs", failure_class="lineage", retryable=False)
        if source_stage not in {"story_foundation", "chapter_design"}:
            raise WorkflowError(
                "只有故事基础和章节设计双候选可以作废下游后改选",
                code="artifact_schema_invalid", failure_class="contract", field_path="source_stage",
                expected=["story_foundation", "chapter_design"], actual=source_stage, retryable=False,
            )
        if artifact.get("stage") != source_stage:
            raise WorkflowError(
                "候选阶段与被覆写阶段不一致", code="artifact_schema_invalid", failure_class="contract",
                field_path="stage", expected=source_stage, actual=artifact.get("stage"), retryable=False,
            )
        if source_stage == "story_foundation":
            affected = sorted(set(prior.chapter_numbers))
        else:
            if chapter_number is None or int(chapter_number) not in prior.chapter_numbers:
                raise WorkflowError(
                    "章节设计改选必须指定原工作流中的章节", code="artifact_schema_invalid",
                    failure_class="contract", field_path="chapter_number",
                    expected=prior.chapter_numbers, actual=chapter_number, retryable=False,
                )
            affected = [item for item in sorted(set(prior.chapter_numbers)) if item >= int(chapter_number)]
        if not affected:
            raise WorkflowError("没有可由候选改选重新执行的章节", code="stale_inputs", failure_class="lineage", retryable=False)
        externally_committed = []
        for number in affected:
            chapter = self.store.get_chapter(prior.book_id, number) or {}
            if chapter.get("status") in {"scheduled", "submitted", "published"}:
                externally_committed.append(number)
        if externally_committed:
            raise WorkflowError(
                "已有章节进入平台发布链，不能用候选改选假装撤回；请新建明确返工版本",
                code="external_state_committed", failure_class="release", field_path="chapter_number",
                expected="not scheduled/submitted/published", actual=externally_committed, retryable=False,
            )

        replacement = WorkflowRun(
            run_id=f"workflow-{uuid.uuid4().hex[:12]}", book_id=prior.book_id,
            chapter_numbers=affected, status="running", current_chapter=affected[0],
            current_stage=source_stage, max_revisions=prior.max_revisions,
            stage_history=[{
                "stage": "candidate_override", "result": f"取代 {run_id} 的 {source_stage}，旧产物只读保留",
                "supersedes_run_id": run_id, "at": utc_now(),
            }],
        )
        replacement_base = self.store.book_dir(prior.book_id) / "workflow" / replacement.run_id
        replacement_base.mkdir(parents=True, exist_ok=True)
        prior_policy = self.store.book_dir(prior.book_id) / "workflow" / prior.run_id / "writing-policy.json"
        if prior_policy.is_file():
            shutil.copy2(prior_policy, replacement_base / "writing-policy.json")
        else:
            self._freeze_writing_policy(replacement)
        self.store.save_workflow_run(replacement)
        action = self.next_action(replacement.run_id)
        try:
            result = self.submit(replacement.run_id, artifact, action_id=str(action["action_id"]))
        except Exception:
            replacement.status = "blocked"
            replacement.stage_history.append({"stage": source_stage, "result": "候选改选未通过权威校验，原工作流未作废", "at": utc_now()})
            self.store.save_workflow_run(replacement)
            raise

        canon_trace = self.store.invalidate_canon_from(
            prior.book_id, affected[0], reason=f"candidate override {run_id} -> {replacement.run_id}",
        )
        prior.status = "superseded"
        prior.stage_history.append({
            "stage": prior.current_stage, "result": f"由 {replacement.run_id} 从 {source_stage} 重新建立依赖链",
            "superseded_by_run_id": replacement.run_id, "at": utc_now(),
        })
        self.store.save_workflow_run(prior)
        for number in affected:
            chapter = self.store.get_chapter(prior.book_id, number) or {}
            if chapter.get("status") in {"approved", "reviewed_pending_approval", "modified_after_review"}:
                self.store.update_chapter_status(prior.book_id, number, "modified_after_review")
        invalidation = {
            "superseded_run_id": prior.run_id,
            "replacement_run_id": replacement.run_id,
            "source_stage": source_stage,
            "affected_chapters": affected,
            "canon": canon_trace,
            "old_artifacts_preserved": True,
        }
        self.store.write_json(replacement_base / "dependency-invalidation.json", invalidation)
        self.store.append_event(prior.book_id, affected[0], "workflow_superseded", invalidation)
        return {**result, "candidate_override": invalidation}

    def status(self, run_id: str) -> dict[str, Any]:
        run = self._run(run_id)
        policy = self._writing_policy(run)
        trace_path = self.store.book_dir(run.book_id) / "workflow" / run.run_id / "traceability.json"
        return {
            **run.to_dict(),
            "next": None if run.status != "running" else self._action_summary(run),
            "progress": {"approved": len(run.completed_chapters), "total": len(run.chapter_numbers)},
            "writing_policy_hash": policy.get("policy_hash"),
            "author_binding": policy.get("author_binding"),
            "traceability": self._read_json(trace_path),
        }

    @book_operation
    def next_action(self, run_id: str) -> dict[str, Any]:
        run = self._run(run_id)
        if run.status != "running":
            return {"run_id": run_id, "status": run.status, "stage": run.current_stage, "message": "工作流当前不可领取新任务"}
        action = self._action_summary(run)
        inputs = self._stage_action_inputs(run)
        stage_dir = self._stage_dir(run)
        stage_dir.mkdir(parents=True, exist_ok=True)
        action_path = stage_dir / f"{run.current_stage}.action.json"
        previous = self._read_json(action_path)
        action_id = (
            str(previous.get("action_id"))
            if isinstance(previous, dict)
            and previous.get("stage") == run.current_stage
            and previous.get("inputs_hash") == inputs["inputs_hash"]
            else f"action-{uuid.uuid4().hex[:16]}"
        )
        action.update({
            "schema_version": "stage-action-v2",
            "action_id": action_id,
            **inputs,
            "allowed_context": sorted(self._stage_context(run).keys()),
            "required_submission": {
                "payload_only": True,
                "public_decision": run.current_stage in REVIEW_STAGES,
                "evidence_type": "exact_quote" if run.current_stage in REVIEW_STAGES | {"canon_update"} else "stage_payload",
                "required_check_ids": list(self._required_checks(run)),
            },
        })
        prompt = self._render_stage_prompt(run, action)
        prompt_path = stage_dir / f"{run.current_stage}.prompt.md"
        prompt_path.write_text(prompt, encoding="utf-8")
        action["prompt_path"] = str(prompt_path)
        action["prompt_bytes"] = prompt_path.stat().st_size
        action["prompt_hash"] = hashlib.sha256(prompt.encode("utf-8")).hexdigest()
        self.store.write_json(action_path, action)
        action["action_path"] = str(action_path)
        return action

    @book_operation(recoverable=True)
    def submit(self, run_id: str, artifact: dict[str, Any], *, action_id: str | None = None) -> dict[str, Any]:
        run = self._run(run_id)
        if run.status != "running":
            raise WorkflowError(f"workflow is not running: {run.status}")
        if any(field in artifact for field in ("action_id", "inputs_hash", "input_hashes", "lineage")):
            raise WorkflowError(
                "业务 payload 不得自行填写 action_id、输入哈希或来源链；这些字段只能由 Tomota 封装",
                code="artifact_schema_invalid", failure_class="contract", field_path="action_id",
                expected="omitted from model payload", actual="present", retryable=True,
            )
        issued_action = self._validate_stage_action(run, action_id)
        self._validate_payload_against_schema(artifact, issued_action.get("output_schema", {}))
        if artifact.get("stage") != run.current_stage:
            raise WorkflowError(
                f"提交阶段不匹配：需要 {run.current_stage}，收到 {artifact.get('stage')}",
                code="artifact_schema_invalid", failure_class="contract", field_path="stage",
                expected=run.current_stage, actual=artifact.get("stage"), retryable=True,
            )
        stage = run.current_stage
        chapter_at_issue = run.current_chapter
        if stage == "story_foundation":
            self._submit_foundation(run, artifact)
            self._advance(run, "chapter_design", "全书基础层已建立")
        elif stage == "chapter_design":
            self._submit_design(run, artifact)
            self._advance(run, "design_review", "场景卡已完成")
        elif stage in REVIEW_STAGES:
            self._submit_review(run, artifact)
        elif stage == "draft" or stage in REVISION_STAGES:
            self._submit_draft(run, artifact)
        elif stage == "canon_update":
            self._submit_canon(run, artifact)
        elif stage == "arc_review":
            replacement_run = self._submit_arc_review(run, artifact)
        else:
            raise WorkflowError(f"未知工作流阶段：{stage}")
        self._update_traceability(run, stage, chapter_at_issue, artifact)
        self.store.save_workflow_run(run)
        if stage == "arc_review" and replacement_run is not None:
            result = self.status(replacement_run.run_id)
            result["redirect_run_id"] = replacement_run.run_id
            result["superseded_run_id"] = run_id
            result["automatic_resolution"] = "arc_scope_rework"
            return result
        return self.status(run_id)

    def submit_file(self, run_id: str, path: Path | str, *, action_id: str | None = None) -> dict[str, Any]:
        source = Path(path).resolve()
        if not source.is_file():
            raise WorkflowError(f"artifact does not exist: {source}")
        try:
            value = json.loads(source.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise WorkflowError(
                f"artifact 必须是 UTF-8 JSON：{exc}", code="artifact_schema_invalid",
                failure_class="contract", field_path="$", expected="JSON object",
                actual=f"JSON decode error at line {exc.lineno}, column {exc.colno}", retryable=True,
            ) from exc
        if not isinstance(value, dict):
            raise WorkflowError(
                "artifact 顶层必须是对象", code="artifact_schema_invalid", failure_class="contract",
                field_path="$", expected="object", actual=type(value).__name__, retryable=True,
            )
        return self.submit(run_id, value, action_id=action_id)

    def _submit_foundation(self, run: WorkflowRun, value: dict[str, Any]) -> None:
        # Books created before the author/constraint contract migration use the
        # system compatibility author. They may submit the legacy foundation
        # shape once; all user-bound author runs must provide the explicit
        # constraint application receipt.
        if "constraint_application" not in value and self._is_system_compatibility_run(run):
            value = {**value, "constraint_application": []}
        required = [
            "world_rules", "terminology", "timeline", "characters", "relationship_matrix",
            "knowledge_boundaries", "foreshadowing", "market_position", "reader_promise", "hook",
            "story_engine", "differentiation", "trope_risks", "volume_objectives", "constraint_application",
        ]
        if self._is_system_compatibility_run(run):
            required.remove("constraint_application")
        self._require_nonempty(value, required, "故事圣经")
        for character in value["characters"]:
            self._require_nonempty(character, ["name", "goal", "fear", "boundary", "behavior_pattern", "speech_rhythm", "avoidance", "pressure_method"], "人物档案")
        for volume in value["volume_objectives"]:
            self._require_nonempty(volume, ["volume_id", "objective", "change", "payoff", "next_volume_entry"], "分卷目标")
        master = self.store.load_master_outline(run.book_id)
        locked_volume_ids = {
            str(item.get("volume_id") or "") for item in master.get("volumes", [])
            if isinstance(item, dict) and str(item.get("volume_id") or "")
        }
        submitted_volume_ids = {str(item.get("volume_id") or "") for item in value["volume_objectives"] if isinstance(item, dict)}
        if locked_volume_ids and submitted_volume_ids != locked_volume_ids:
            raise WorkflowError(
                "故事基础的 volume_objectives 必须逐卷覆盖当前正式总纲，不能遗漏、增造或改名分卷",
                code="artifact_schema_invalid", failure_class="contract", field_path="volume_objectives",
                expected=sorted(locked_volume_ids), actual=sorted(submitted_volume_ids), retryable=True,
            )
        for application in value["constraint_application"]:
            self._require_nonempty(application, [
                "constraint_id", "source", "target_fields", "execution", "acceptance_test", "conflict_status",
            ], "故事基础约束落地记录")
        self._validate_foundation_constraint_application(run, value)
        if str(value["differentiation"]).strip() in {"奇幻", "悬疑", "奇幻悬疑", "男频", "女频"}:
            raise WorkflowError(
                "differentiation 不能只写泛题材定位，必须说明与同题材常见套路的差异点",
                code="content_generation_invalid", failure_class="content", field_path="differentiation",
                expected="specific executable differentiation", actual=value["differentiation"], retryable=True,
            )
        canon_dir = self.store.book_dir(run.book_id) / "canon"
        story_bible_keys = required[:7]
        story_path = canon_dir / "story-bible.json"
        quality_path = canon_dir / "quality-foundation.json"
        manifest_path = canon_dir / "foundation-version.json"
        story_value = {key: value[key] for key in story_bible_keys}
        quality_value = {key: value[key] for key in required[7:]}
        prior_story = self._read_json(story_path)
        prior_quality = self._read_json(quality_path)
        prior_manifest = self._read_json(manifest_path)
        prior_hash = self._canonical_hash({"story_bible": prior_story or {}, "quality_foundation": prior_quality or {}}) if prior_story or prior_quality else ""
        next_hash = self._canonical_hash({"story_bible": story_value, "quality_foundation": quality_value})
        prior_revision = int((prior_manifest or {}).get("revision") or 0)
        revision = prior_revision if prior_hash == next_hash and prior_hash else prior_revision + 1
        if prior_hash and prior_hash != next_hash:
            history = canon_dir / "foundation-history"
            history.mkdir(parents=True, exist_ok=True)
            history_revision = max(1, prior_revision)
            self.store.write_json(history / f"revision-{history_revision:04d}.story-bible.json", prior_story or {})
            self.store.write_json(history / f"revision-{history_revision:04d}.quality-foundation.json", prior_quality or {})
        if prior_hash != next_hash:
            self.store.write_json(story_path, story_value)
            self.store.write_json(quality_path, quality_value)
        self.store.write_json(manifest_path, {
            "schema_version": "story-foundation-version-v1", "revision": max(1, revision),
            "content_hash": next_hash,
            "parent_hash": prior_hash if prior_hash != next_hash else str((prior_manifest or {}).get("parent_hash") or ""),
            "source_run_id": run.run_id, "updated_at": utc_now(),
        })
        self._write_artifact(run, "story_foundation", value)

    def _is_system_compatibility_run(self, run: WorkflowRun) -> bool:
        policy = self._writing_policy(run)
        binding = policy.get("author_binding") if isinstance(policy, dict) else {}
        return bool(isinstance(binding, dict) and (
            binding.get("is_system") or str(binding.get("author_id") or "") == "system-legacy-author"
        ))

    def _required_checks(self, run: WorkflowRun, stage: str | None = None) -> tuple[str, ...]:
        selected = stage or run.current_stage
        checks = list(REQUIRED_CHECKS.get(selected, ()))
        if self._is_system_compatibility_run(run):
            checks = [name for name in checks if name not in {"author_contract_application", "author_style_realization"}]
        return tuple(checks)

    def _validate_foundation_constraint_application(self, run: WorkflowRun, value: dict[str, Any]) -> None:
        foundation = self.store.effective_foundation_contract(run.book_id)
        foundation_items = [
            item for item in foundation.get("active_constraints", [])
            if isinstance(item, dict) and item.get("constraint_id")
        ]
        foundation_ids = {str(item["constraint_id"]) for item in foundation_items}
        required_ids = {
            str(item["constraint_id"]) for item in foundation_items
            if str(item.get("priority") or "must") in {"must", "avoid"}
        }
        policy = self._writing_policy(run)
        compiled = self._compile_stage_writing_policy(run, policy, self._stage_context(run))
        style_rules = [item for item in compiled.get("executable_style_rules", []) if isinstance(item, dict)]
        style_ids = {str(item["rule_id"]) for item in style_rules if item.get("rule_id")}
        required_ids.update(
            str(item["rule_id"]) for item in style_rules
            if item.get("rule_id") and str(item.get("class")) in {"must", "avoid"}
        )
        allowed_sources = {"hard_rule", "canon", "foundation", "book_override", "author_profile", "distilled_dimension", "author_blueprint"}
        allowed_targets = {
            "world_rules", "terminology", "timeline", "characters", "relationship_matrix",
            "knowledge_boundaries", "foreshadowing", "market_position", "reader_promise", "hook",
            "story_engine", "differentiation", "trope_risks", "volume_objectives",
        }
        canon = self.store.load_canon(run.book_id)
        mapped: set[str] = set()
        for index, application in enumerate(value.get("constraint_application", [])):
            if not isinstance(application, dict):
                raise WorkflowError(
                    "故事基础约束落地记录必须是对象", code="artifact_schema_invalid",
                    failure_class="contract", field_path=f"constraint_application[{index}]", retryable=True,
                )
            constraint_id = str(application.get("constraint_id") or "")
            source = str(application.get("source") or "")
            if constraint_id in mapped:
                raise WorkflowError(
                    f"故事基础约束 {constraint_id} 重复映射", code="artifact_schema_invalid",
                    failure_class="contract", field_path=f"constraint_application[{index}].constraint_id", retryable=True,
                )
            if source not in allowed_sources:
                raise WorkflowError(
                    f"故事基础约束使用未知来源：{source}", code="artifact_schema_invalid",
                    failure_class="contract", field_path=f"constraint_application[{index}].source",
                    expected=sorted(allowed_sources), actual=source, retryable=True,
                )
            targets = application.get("target_fields")
            if not isinstance(targets, list) or not targets or any(str(field) not in allowed_targets or not value.get(str(field)) for field in targets):
                raise WorkflowError(
                    f"故事基础约束 {constraint_id} 必须引用本次真实非空字段", code="artifact_schema_invalid",
                    failure_class="contract", field_path=f"constraint_application[{index}].target_fields",
                    expected=sorted(allowed_targets), actual=targets, retryable=True,
                )
            status = str(application.get("conflict_status") or "")
            if status not in {"active", "suppressed_by_higher_rule"}:
                raise WorkflowError(
                    "conflict_status 无效", code="artifact_schema_invalid", failure_class="contract",
                    field_path=f"constraint_application[{index}].conflict_status",
                    expected=["active", "suppressed_by_higher_rule"], actual=status, retryable=True,
                )
            if status == "suppressed_by_higher_rule":
                suppressed_by = str(application.get("suppressed_by") or "")
                conflict_reason = str(application.get("conflict_reason") or "")
                if not suppressed_by or not conflict_reason:
                    raise WorkflowError(
                        "suppressed_by_higher_rule 必须同时提供 suppressed_by（上位规则 ID）和 conflict_reason（冲突说明）",
                        code="artifact_schema_invalid", failure_class="contract",
                        field_path=f"constraint_application[{index}]",
                        expected="suppressed_by + conflict_reason", actual=application, retryable=True,
                    )
                if suppressed_by == constraint_id:
                    raise WorkflowError(
                        f"约束不能自我压制：{constraint_id}", code="artifact_schema_invalid",
                        failure_class="contract", field_path=f"constraint_application[{index}].suppressed_by", retryable=True,
                    )
                _require_conflict_dimensions(application, f"constraint_application[{index}]")
                suppressor_priority = _rule_priority(suppressed_by, foundation_items, style_rules, canon)
                if suppressor_priority is None:
                    raise WorkflowError(
                        f"suppressed_by 引用了不存在或为空的上位规则：{suppressed_by}", code="artifact_schema_invalid",
                        failure_class="contract", field_path=f"constraint_application[{index}].suppressed_by", retryable=True,
                    )
                suppressed_priority = _rule_priority(constraint_id, foundation_items, style_rules, canon)
                if suppressed_priority is None:
                    raise WorkflowError(
                        f"被压制约束本身不存在或为空：{constraint_id}", code="artifact_schema_invalid",
                        failure_class="contract", field_path=f"constraint_application[{index}].constraint_id", retryable=True,
                    )
                if suppressor_priority <= suppressed_priority:
                    raise WorkflowError(
                        f"suppressed_by 必须严格高于被压制规则；同级冲突需要显式裁决：{suppressed_by} <= {constraint_id}", code="artifact_schema_invalid",
                        failure_class="contract", field_path=f"constraint_application[{index}].suppressed_by", retryable=True,
                    )
            if source == "foundation" and constraint_id not in foundation_ids:
                raise WorkflowError(
                    f"故事基础引用了不存在的正式约束：{constraint_id}", code="artifact_schema_invalid",
                    failure_class="contract", field_path=f"constraint_application[{index}].constraint_id", retryable=True,
                )
            if source in {"book_override", "author_profile", "distilled_dimension", "author_blueprint"} and constraint_id not in style_ids:
                raise WorkflowError(
                    f"故事基础引用了未进入冻结作者策略的规则：{constraint_id}", code="artifact_schema_invalid",
                    failure_class="contract", field_path=f"constraint_application[{index}].constraint_id", retryable=True,
                )
            if source == "hard_rule" and constraint_id not in HARD_RULE_IDS:
                raise WorkflowError(
                    f"故事基础引用了不存在的硬性策略规则：{constraint_id}", code="artifact_schema_invalid",
                    failure_class="contract", field_path=f"constraint_application[{index}].constraint_id", retryable=True,
                )
            if source == "canon":
                if not _canon_path_resolves(canon, constraint_id):
                    raise WorkflowError(
                        f"故事基础引用了不存在或为空的 Canon 事实：{constraint_id}", code="artifact_schema_invalid",
                        failure_class="contract", field_path=f"constraint_application[{index}].constraint_id", retryable=True,
                    )
            mapped.add(constraint_id)
        missing = sorted(required_ids - mapped)
        if missing:
            raise WorkflowError(
                "故事基础未落实全部当前生效的 must/avoid 约束：" + ", ".join(missing),
                code="artifact_schema_invalid", failure_class="contract",
                field_path="constraint_application", expected=missing, actual=sorted(mapped), retryable=True,
            )

    def _submit_design(self, run: WorkflowRun, value: dict[str, Any]) -> None:
        self._require_nonempty(value, [
            "scenes", "dialogue_pressure_plan", "character_knowledge", "foreshadow_actions", "core_reveal_closeup",
            "reader_experience_contract", "continuity_handoff", "constraint_application",
        ], "章节设计")
        scene_fields = [
            "scene_id", "setting", "objective", "obstacle", "motivation", "trigger", "choice", "consequence", "next_scene_entry",
            "reader_question", "value_change", "pressure_level", "information_delta", "emotion_shift", "scene_function", "cut_or_merge_reason",
        ]
        for scene in value["scenes"]:
            self._require_nonempty(scene, scene_fields, "场景卡")
        self._require_nonempty(value, ["chapter_questions", "chapter_ending"], "章节设计")
        self._require_nonempty(value["chapter_questions"], ["protagonist_want", "who_or_what_blocks", "situation_change", "why_continue"], "章节四问")
        self._require_nonempty(value["chapter_ending"], ["ending_change", "hook_type", "next_first_beat"], "章末设计")
        self._require_nonempty(value["reader_experience_contract"], [
            "inherited_obligation", "chapter_reward", "emotional_curve", "information_contract",
            "non_negotiable_change", "exit_obligation", "acceptance_tests",
        ], "本章读者体验契约")
        self._require_nonempty(value["continuity_handoff"], [
            "entry_state", "entry_trigger", "retained_consequences", "exit_state",
            "next_chapter_first_beat", "actual_vs_plan_check",
        ], "上下章连续性交接")
        for plan in value["dialogue_pressure_plan"]:
            self._require_nonempty(plan, ["speaker", "goal", "target", "withheld", "voice_rule", "pressure_function", "dialogue_budget"], "对白压力计划")
        for action in value["foreshadow_actions"]:
            self._require_nonempty(action, ["id", "action", "reader_effect", "reader_knows", "hidden", "advance_or_payoff"], "伏笔动作")
        for application in value["constraint_application"]:
            self._require_nonempty(application, [
                "constraint_id", "source", "scene_ids", "execution", "acceptance_test", "conflict_status",
            ], "约束落地记录")
        self._validate_design_constraint_application(run, value)
        self._write_artifact(run, "chapter_design", value)

    def _validate_design_constraint_application(self, run: WorkflowRun, design: dict[str, Any]) -> None:
        """Prove that hard planning/style rules were compiled into executable scenes.

        Shape validation alone allowed a design to submit plausible-looking but
        invented IDs, or to omit every real rule.  This gate resolves the IDs
        from the frozen inputs and rejects that false hand-off before drafting.
        """
        scene_ids = {
            str(item.get("scene_id")) for item in design.get("scenes", [])
            if isinstance(item, dict) and str(item.get("scene_id") or "").strip()
        }
        applications = [item for item in design.get("constraint_application", []) if isinstance(item, dict)]
        mapped: set[str] = set()
        foundation = self.store.effective_foundation_contract(
            run.book_id, chapter_number=int(run.current_chapter or 0),
        )
        foundation_items = [
            item for item in foundation.get("active_constraints", [])
            if isinstance(item, dict) and item.get("constraint_id")
        ]
        foundation_ids = {str(item["constraint_id"]) for item in foundation_items}
        required_foundation_ids = {
            str(item["constraint_id"]) for item in foundation_items
            if str(item.get("priority") or "must") in {"must", "avoid"}
        }
        policy = self._writing_policy(run)
        compiled = self._compile_stage_writing_policy(run, policy, self._stage_context(run)) if policy else {}
        style_rules = [item for item in compiled.get("executable_style_rules", []) if isinstance(item, dict)]
        style_ids = {str(item.get("rule_id")) for item in style_rules if item.get("rule_id")}
        required_style_ids = {
            str(item.get("rule_id")) for item in style_rules
            if item.get("rule_id") and str(item.get("class")) in {"must", "avoid"}
        }
        canon = self.store.load_canon(run.book_id)
        chapter_record = self.store.get_chapter(run.book_id, int(run.current_chapter or 0))
        chapter_contract = chapter_record.get("contract") if isinstance(chapter_record, dict) else None
        if not isinstance(chapter_contract, dict):
            chapter_contract = {}
        seen: set[str] = set()
        allowed_sources = {
            "hard_rule", "canon", "foundation", "chapter_contract", "book_override",
            "author_profile", "distilled_dimension", "author_blueprint",
        }
        for index, application in enumerate(applications):
            constraint_id = str(application.get("constraint_id") or "")
            source = str(application.get("source") or "")
            if source not in allowed_sources:
                raise WorkflowError(
                    f"约束落地记录使用未知来源：{source}", code="artifact_schema_invalid",
                    failure_class="contract", field_path=f"constraint_application[{index}].source",
                    expected=sorted(allowed_sources), actual=source, retryable=True,
                )
            if constraint_id in seen:
                raise WorkflowError(
                    f"约束 {constraint_id} 被拆成多条互相竞争的落地记录；请合并 scene_ids",
                    code="artifact_schema_invalid", failure_class="contract",
                    field_path=f"constraint_application[{index}].constraint_id",
                    expected="one application per constraint", actual=constraint_id, retryable=True,
                )
            seen.add(constraint_id)
            mapped.add(constraint_id)
            application_scenes = application.get("scene_ids")
            if not isinstance(application_scenes, list) or not application_scenes or any(str(item) not in scene_ids for item in application_scenes):
                raise WorkflowError(
                    f"约束 {constraint_id} 必须映射到本次真实场景卡",
                    code="artifact_schema_invalid", failure_class="contract",
                    field_path=f"constraint_application[{index}].scene_ids",
                    expected=sorted(scene_ids), actual=application_scenes, retryable=True,
                )
            status = str(application.get("conflict_status") or "")
            if status not in {"active", "suppressed_by_higher_rule"}:
                raise WorkflowError(
                    "conflict_status 只能公开声明为 active 或 suppressed_by_higher_rule",
                    code="artifact_schema_invalid", failure_class="contract",
                    field_path=f"constraint_application[{index}].conflict_status",
                    expected=["active", "suppressed_by_higher_rule"], actual=status, retryable=True,
                )
            if status == "suppressed_by_higher_rule":
                # 被上位规则压制必须留可核验证据：上位规则 ID + 冲突说明，不能无证据宣布压制。
                suppressed_by = str(application.get("suppressed_by") or "")
                conflict_reason = str(application.get("conflict_reason") or "")
                if not suppressed_by or not conflict_reason:
                    raise WorkflowError(
                        "suppressed_by_higher_rule 必须同时提供 suppressed_by（上位规则 ID）和 conflict_reason（冲突说明）",
                        code="artifact_schema_invalid", failure_class="contract",
                        field_path=f"constraint_application[{index}]",
                        expected="suppressed_by + conflict_reason", actual=application, retryable=True,
                    )
                if suppressed_by == constraint_id:
                    raise WorkflowError(
                        f"约束不能自我压制：{constraint_id}", code="artifact_schema_invalid",
                        failure_class="contract", field_path=f"constraint_application[{index}].suppressed_by", retryable=True,
                    )
                _require_conflict_dimensions(application, f"constraint_application[{index}]")
                suppressor_priority = _rule_priority(suppressed_by, foundation_items, style_rules, canon, chapter_contract)
                if suppressor_priority is None:
                    raise WorkflowError(
                        f"suppressed_by 引用了不存在或为空的上位规则：{suppressed_by}",
                        code="artifact_schema_invalid", failure_class="contract",
                        field_path=f"constraint_application[{index}].suppressed_by",
                        actual=suppressed_by, retryable=True,
                    )
                # 严格递增的优先级同时禁止同级互相压制和任意长度的压制环。
                suppressed_priority = _rule_priority(constraint_id, foundation_items, style_rules, canon, chapter_contract)
                if suppressed_priority is None:
                    raise WorkflowError(
                        f"被压制约束本身不存在或为空：{constraint_id}", code="artifact_schema_invalid",
                        failure_class="contract", field_path=f"constraint_application[{index}].constraint_id", retryable=True,
                    )
                if suppressor_priority <= suppressed_priority:
                    raise WorkflowError(
                        f"suppressed_by 必须严格高于被压制规则；同级冲突需要显式裁决：{suppressed_by} <= {constraint_id}",
                        code="artifact_schema_invalid", failure_class="contract",
                        field_path=f"constraint_application[{index}].suppressed_by", retryable=True,
                    )
            # 约束来源必须真实存在，不得伪造；正式集合为空时引用任何 ID 都非法。
            if source == "foundation":
                if constraint_id not in foundation_ids:
                    raise WorkflowError(
                        f"约束落地引用了不存在或不适用于本章的全书约束：{constraint_id}",
                        code="artifact_schema_invalid", failure_class="contract",
                        field_path=f"constraint_application[{index}].constraint_id",
                        expected=sorted(foundation_ids), actual=constraint_id, retryable=True,
                    )
            if source in {"book_override", "author_profile", "distilled_dimension", "author_blueprint"}:
                if constraint_id not in style_ids:
                    raise WorkflowError(
                        f"约束落地引用了未进入冻结作者策略的规则：{constraint_id}",
                        code="artifact_schema_invalid", failure_class="contract",
                        field_path=f"constraint_application[{index}].constraint_id",
                        expected=sorted(style_ids), actual=constraint_id, retryable=True,
                    )
            if source == "hard_rule" and constraint_id not in HARD_RULE_IDS:
                raise WorkflowError(
                    f"约束落地引用了不存在的硬性策略规则：{constraint_id}",
                    code="artifact_schema_invalid", failure_class="contract",
                    field_path=f"constraint_application[{index}].constraint_id",
                    expected=sorted(HARD_RULE_IDS), actual=constraint_id, retryable=True,
                )
            if source == "canon":
                if not _canon_path_resolves(canon, constraint_id):
                    raise WorkflowError(
                        f"约束落地引用了不存在或为空的 Canon 事实：{constraint_id}",
                        code="artifact_schema_invalid", failure_class="contract",
                        field_path=f"constraint_application[{index}].constraint_id",
                        expected=sorted(CANON_FACT_FIELDS), actual=constraint_id, retryable=True,
                    )
            if source == "chapter_contract":
                if not _chapter_contract_path_resolves(chapter_contract, constraint_id):
                    raise WorkflowError(
                        f"约束落地引用了不存在或为空的章节契约字段：{constraint_id}",
                        code="artifact_schema_invalid", failure_class="contract",
                        field_path=f"constraint_application[{index}].constraint_id",
                        expected=sorted(CHAPTER_CONTRACT_FIELDS), actual=constraint_id, retryable=True,
                    )
        missing = sorted((required_foundation_ids | required_style_ids) - mapped)
        if missing:
            raise WorkflowError(
                "章节设计未逐场落实所有当前生效的 must/avoid 规则：" + ", ".join(missing),
                code="artifact_schema_invalid", failure_class="contract",
                field_path="constraint_application", expected=missing, actual=sorted(mapped), retryable=True,
            )

    def _submit_review(self, run: WorkflowRun, value: dict[str, Any]) -> None:
        gate = self._gate_from_value(run.current_stage, value)
        source_text = self._review_source_text(run)
        evidence_map = self._review_evidence_map(value.get("evidence"), source_text, field_path="evidence")
        revision_brief = value.get("revision_brief")
        if not isinstance(revision_brief, list):
            raise WorkflowError(
                "ReviewArtifactV2 必须始终提交 revision_brief 数组；通过时应为空数组",
                code="artifact_schema_invalid", failure_class="contract", field_path="revision_brief",
                expected="array", actual=type(revision_brief).__name__, retryable=True,
            )
        if gate.passed and revision_brief:
            raise WorkflowError(
                "passed=true 时 revision_brief 必须为空数组",
                code="artifact_schema_invalid", failure_class="contract", field_path="revision_brief",
                expected=[], actual=revision_brief, retryable=True,
            )
        if gate.passed:
            self._validate_required_checks(run, run.current_stage, value.get("checks"), evidence_map, source_text)
            self._validate_quality_scorecard(run, value.get("quality_scorecard"), evidence_map, source_text)
            if run.current_stage == "review_voice":
                self._validate_author_realization(run, value.get("author_realization"), source_text)
            if run.current_stage != "design_review":
                content = self._current_draft(run)
                lint_findings = self.reviewer.lint(content, gate=run.current_stage)
                if lint_findings:
                    gate.passed = False
                    gate.findings.extend(lint_findings)
                    revision_brief = self._revision_brief_from_findings(lint_findings)
            if gate.passed and run.current_stage == "review_voice":
                deslop_findings = run_deslop_lint(self._current_draft(run), skill_root=self.skill.root)
                deslop_blockers = [item for item in deslop_findings if item.severity == "blocking"]
                deterministic_findings = self._deslop_review_findings(deslop_blockers)
                if deterministic_findings:
                    gate.passed = False
                    gate.findings.extend(deterministic_findings)
                    revision_brief = self._revision_brief_from_findings(deterministic_findings)
            if gate.passed and run.current_stage == "review_voice":
                fingerprint = self._prose_fingerprint(run, self._current_draft(run))
                fingerprint_findings = [
                    ReviewFinding(
                        finding_id=f"fingerprint-{str(item.get('code') or 'repeat')}",
                        gate="review_voice", severity="blocker", category="全书文风重复",
                        location="全文/开场", quote=str(item.get("quote") or "")[:160],
                        violated_rule="全书不得机械复用开场骨架、描写搭配或身体反应链",
                        repair_requirement=str(item.get("repair") or "从叙事功能出发重写重复段落"),
                        diagnosis=str(item.get("diagnosis") or "与既有章节形成系统性重复"),
                    )
                    for item in fingerprint.get("blockers", []) if isinstance(item, dict)
                ]
                if fingerprint_findings:
                    gate.passed = False
                    gate.findings.extend(fingerprint_findings)
                    revision_brief = self._revision_brief_from_findings(fingerprint_findings)
        if run.current_stage == "cold_review":
            answers = value.get("reader_answers")
            self._require_nonempty(answers or {}, ["who", "does_what", "why", "referents", "situation_change", "reason_to_continue"], "无提示冷审读者回答")
        accepted = {
            **value,
            **gate.to_dict(),
            "schema_version": "review-artifact-v2",
            "revision_brief": revision_brief,
            "review_lineage": self._review_binding(run, run.current_stage),
        }
        self._write_artifact(run, run.current_stage, accepted)
        if gate.passed and not gate.findings:
            following = {
                "design_review": "draft", "review_logic": "review_voice", "review_voice": "review_continuity",
                "review_continuity": "cold_review", "cold_review": "canon_update",
            }[run.current_stage]
            self._advance(run, following, f"{gate.gate} 通过，证据 {len(gate.evidence)} 条")
            return
        if not gate.findings:
            raise WorkflowError(
                "未通过的审查门必须至少包含一条完整 finding",
                code="artifact_schema_invalid", failure_class="contract", field_path="findings",
                expected="non-empty array when passed=false", actual=value.get("findings"), retryable=True,
            )
        self._validate_revision_brief(revision_brief)
        if run.current_stage == "design_review":
            self._advance(run, "chapter_design", f"设计审查退回：{len(gate.findings)} 个问题")
            return
        if run.revision_round >= run.max_revisions:
            run.status = "blocked"
            run.stage_history.append({"stage": gate.gate, "result": "blocked", "findings": len(gate.findings), "at": utc_now()})
            self.store.update_chapter_status(run.book_id, int(run.current_chapter), "blocked")
            return
        run.revision_round += 1
        revision_stage = {"review_logic": "revise_logic", "review_voice": "revise_voice", "review_continuity": "revise_continuity", "cold_review": "revise_cold"}[run.current_stage]
        self._advance(run, revision_stage, f"发现 {len(gate.findings)} 个问题，进入第 {run.revision_round} 轮返工")

    @staticmethod
    def _deslop_review_findings(findings: list[DeslopFinding]) -> list[ReviewFinding]:
        """Convert deterministic anti-AI blockers into ordinary voice findings."""
        result: list[ReviewFinding] = []
        for index, item in enumerate(findings, 1):
            quote = item.excerpt.strip() or item.message
            digest = hashlib.sha1(
                f"{item.rule_type}:{item.line}:{item.column}:{quote}".encode("utf-8")
            ).hexdigest()[:10]
            result.append(ReviewFinding(
                finding_id=f"deslop-{digest}", gate="review_voice", severity="blocker",
                category="去AI味", location=f"第{item.line}行第{item.column}列",
                quote=quote[:240], violated_rule=f"确定性去 AI 味门禁：{item.rule_type}",
                repair_requirement=item.message,
                diagnosis="项目内确定性扫描命中；必须修订后重新执行 review_voice",
            ))
        return result

    def _validate_quality_scorecard(
        self,
        run: WorkflowRun,
        scorecard: Any,
        evidence_map: dict[str, str],
        source_text: str,
    ) -> None:
        """Require a five-dimension scorecard whose evidence comes from the text."""
        if not isinstance(scorecard, dict):
            raise WorkflowError(
                "通过前必须提交 QualityScorecard", code="artifact_schema_invalid",
                failure_class="contract", field_path="quality_scorecard", expected="object",
                actual=type(scorecard).__name__, retryable=True,
            )
        missing = [name for name in QUALITY_SCORE_FIELDS if name not in scorecard]
        if missing:
            raise WorkflowError(
                f"QualityScorecard 缺少评分项：{', '.join(missing)}", code="artifact_schema_invalid",
                failure_class="contract", field_path="quality_scorecard", expected=list(QUALITY_SCORE_FIELDS),
                actual=sorted(scorecard), retryable=True,
            )
        for name in QUALITY_SCORE_FIELDS:
            item = scorecard[name]
            if not isinstance(item, dict):
                raise WorkflowError(
                    f"QualityScorecard.{name} 必须是对象", code="artifact_schema_invalid",
                    failure_class="contract", field_path=f"quality_scorecard.{name}",
                    expected="object", actual=type(item).__name__, retryable=True,
                )
            score = item.get("score")
            if not isinstance(score, int) or isinstance(score, bool) or not 1 <= score <= 5:
                raise WorkflowError(
                    f"QualityScorecard.{name}.score 必须是 1—5 的整数",
                    code="artifact_schema_invalid", failure_class="contract",
                    field_path=f"quality_scorecard.{name}.score", expected="integer 1..5",
                    actual=score, retryable=True,
                )
            self._validate_evidence_binding(
                item, evidence_map, source_text, field_path=f"quality_scorecard.{name}",
            )
            if score < 3:
                raise WorkflowError(
                    f"通过审查要求每项至少 3 分；{name}={score} 必须报告问题并返工",
                    code="artifact_schema_invalid", failure_class="contract",
                    field_path=f"quality_scorecard.{name}.score", expected="3..5 when passed=true",
                    actual=score, retryable=True,
                )

    def _prose_author_rules(self, run: WorkflowRun) -> list[dict[str, Any]]:
        """Use one rule scope for draft self-checks and independent voice review."""
        policy = self._writing_policy(run)
        if not policy:
            return []
        scoped = copy(run)
        scoped.current_stage = "review_voice"
        context = {"design": self._read_json(self._stage_dir(run) / "chapter_design.json")}
        return self._compile_stage_writing_policy(scoped, policy, context)["executable_style_rules"]

    def _validate_author_realization(self, run: WorkflowRun, receipts: Any, content: str) -> None:
        rules = {item["rule_id"]: item for item in self._prose_author_rules(run)}
        if not rules and receipts is None:
            return
        def fail(message: str) -> None:
            raise WorkflowError(message, code="artifact_schema_invalid", failure_class="contract",
                                field_path="author_realization", retryable=True)
        if not isinstance(receipts, list):
            fail("author_realization 必须逐条报告作者方法落实状态")
        seen: set[str] = set()
        for receipt in receipts:
            if not isinstance(receipt, dict):
                fail("作者落实记录必须是对象")
            rule_id = str(receipt.get("rule_id") or "")
            if rule_id not in rules or rule_id in seen:
                fail(f"作者落实记录引用未知或重复规则：{rule_id}")
            seen.add(rule_id)
            rule = rules[rule_id]
            status = receipt.get("status")
            if not str(receipt.get("reason") or "").strip():
                fail(f"{rule_id} 必须说明具体实现或未采用原因")
            if rule.get("activation") == "suppressed":
                if status != "suppressed" or receipt.get("suppressed_by") != rule.get("suppressed_by"):
                    fail(f"{rule_id} 必须沿用已核准的压制关系，不得重新激活")
            elif status == "realized":
                self._require_grounded_quote(str(receipt.get("quote") or ""), content,
                                             f"author_realization.{rule_id}.quote")
                if not str(receipt.get("location") or "").strip():
                    fail(f"{rule_id} 必须提供正文位置")
                if receipt.get("suppressed_by"):
                    fail(f"{rule_id} 已落实记录不得同时声明压制")
            elif status == "not_used" and not rule.get("execution_required") and not rule.get("scene_ids"):
                if receipt.get("suppressed_by"):
                    fail(f"{rule_id} 未采用不等于被上位规则压制")
            else:
                fail(f"{rule_id} 必须落实；未采用仅允许未映射的可选方法，压制必须在设计中核准")
        if seen != set(rules):
            fail("作者落实记录遗漏规则：" + ", ".join(sorted(set(rules) - seen)))

    def _validate_revision_brief(self, brief: Any) -> None:
        if not isinstance(brief, list) or not brief:
            raise WorkflowError(
                "未通过的审查门必须提交 RevisionBrief 列表",
                code="artifact_schema_invalid", failure_class="contract", field_path="revision_brief",
                expected="non-empty array when passed=false", actual=brief, retryable=True,
            )
        for index, item in enumerate(brief):
            if not isinstance(item, dict):
                raise WorkflowError(
                    "RevisionBrief 必须是对象", code="artifact_schema_invalid", failure_class="contract",
                    field_path=f"revision_brief[{index}]", expected="object",
                    actual=type(item).__name__, retryable=True,
                )
            missing = [name for name in REVISION_BRIEF_FIELDS if not str(item.get(name, "")).strip()]
            if missing:
                raise WorkflowError(
                    f"RevisionBrief 缺少字段：{', '.join(missing)}", code="artifact_schema_invalid",
                    failure_class="contract", field_path=f"revision_brief[{index}]",
                    expected=list(REVISION_BRIEF_FIELDS), actual=sorted(item), retryable=True,
                )
            if str(item["review_gate_to_rerun"]) not in REVIEW_STAGES:
                raise WorkflowError(
                    f"RevisionBrief.review_gate_to_rerun 非法：{item['review_gate_to_rerun']}",
                    code="artifact_schema_invalid", failure_class="contract",
                    field_path=f"revision_brief[{index}].review_gate_to_rerun",
                    expected=sorted(REVIEW_STAGES), actual=item["review_gate_to_rerun"], retryable=True,
                )

    def _review_source_text(self, run: WorkflowRun) -> str:
        if run.current_stage == "design_review":
            source = self._stage_dir(run) / "chapter_design.json"
            if not source.is_file():
                raise WorkflowError("设计审查缺少 chapter_design 产物")
            return source.read_text(encoding="utf-8")
        return self._current_draft(run)

    def _review_evidence_map(self, evidence: Any, source_text: str, *, field_path: str) -> dict[str, str]:
        if not isinstance(evidence, list) or not evidence:
            raise WorkflowError(
                "每个审查门都必须提供非空 evidence", code="artifact_schema_invalid",
                failure_class="contract", field_path=field_path, expected="non-empty array",
                actual=evidence, retryable=True,
            )
        values: dict[str, str] = {}
        for index, raw in enumerate(evidence):
            if isinstance(raw, dict):
                evidence_id = str(raw.get("evidence_id") or f"E{index + 1}").strip()
                location = str(raw.get("location") or "").strip()
                quote = str(raw.get("quote") or "").strip()
                if not location:
                    raise WorkflowError(
                        "ReviewEvidence.location 不能为空", code="artifact_schema_invalid",
                        failure_class="contract", field_path=f"{field_path}[{index}].location",
                        expected="non-empty string", actual=raw.get("location"), retryable=True,
                    )
            else:
                # Legacy artifacts remain readable; all newly generated prompts use V2 objects.
                evidence_id = f"E{index + 1}"
                quote = str(raw).strip()
            if not evidence_id or evidence_id in values:
                raise WorkflowError(
                    "ReviewEvidence.evidence_id 必须唯一且非空", code="artifact_schema_invalid",
                    failure_class="contract", field_path=f"{field_path}[{index}].evidence_id",
                    expected="unique non-empty string", actual=evidence_id, retryable=True,
                )
            self._require_grounded_quote(quote, source_text, f"{field_path}[{index}].quote")
            values[evidence_id] = quote
        return values

    def _require_grounded_quote(self, quote: str, source_text: str, field_path: str) -> None:
        normalized = " ".join(quote.split())
        normalized_source = " ".join(source_text.split())
        if (
            not quote
            or quote in {"非空审查证据", "具体证据", "当前正文原文"}
            or (quote not in source_text and normalized not in normalized_source)
        ):
            raise WorkflowError(
                f"{field_path} 必须逐字引用当前受审产物，不能使用概括或占位文本",
                code="evidence_not_grounded", failure_class="evidence", field_path=field_path,
                expected="exact quote from current review source", actual=quote[:200], retryable=True,
            )

    def _validate_evidence_binding(
        self,
        item: dict[str, Any],
        evidence_map: dict[str, str],
        source_text: str,
        *,
        field_path: str,
    ) -> None:
        refs = item.get("evidence_refs")
        if isinstance(refs, list) and refs:
            missing = [str(ref) for ref in refs if str(ref) not in evidence_map]
            if missing:
                raise WorkflowError(
                    f"{field_path}.evidence_refs 引用了不存在的证据：{', '.join(missing)}",
                    code="artifact_schema_invalid", failure_class="contract",
                    field_path=f"{field_path}.evidence_refs", expected=sorted(evidence_map),
                    actual=refs, retryable=True,
                )
            return
        raw = item.get("evidence")
        quote = str(raw.get("quote") if isinstance(raw, dict) else raw or "").strip()
        self._require_grounded_quote(quote, source_text, f"{field_path}.evidence")

    @staticmethod
    def _revision_brief_from_findings(findings: list[ReviewFinding]) -> list[dict[str, str]]:
        return [
            {
                "location": finding.location,
                "quote": finding.quote,
                "violated_rule": finding.violated_rule,
                "repair_direction": finding.repair_requirement,
                "protected_content": "保留未被该 finding 指认的有效事实、人物状态与已通过场景结构",
                "review_gate_to_rerun": finding.gate,
            }
            for finding in findings
        ]

    def _submit_draft(self, run: WorkflowRun, value: dict[str, Any]) -> None:
        content = str(value.get("content", "")).strip()
        if not content and run.current_stage in REVISION_STAGES and isinstance(value.get("replacements"), list):
            content = self._current_draft(run).strip()
            for item in value["replacements"]:
                before = str(item.get("before", ""))
                after = str(item.get("after", ""))
                if not before or content.count(before) != 1:
                    raise WorkflowError(
                        f"定点修订的 before 必须在当前稿中恰好出现一次：{before[:80]}",
                        code="content_generation_invalid", failure_class="content", field_path="replacements.before",
                        expected="one exact occurrence in current draft", actual=content.count(before) if before else 0, retryable=True,
                    )
                content = content.replace(before, after, 1)
        if not content:
            raise WorkflowError(
                "正文/修订稿 content 为空", code="artifact_schema_invalid", failure_class="contract",
                field_path="content", expected="non-empty chapter body", actual=content, retryable=True,
            )
        if run.current_stage in REVISION_STAGES and content == self._current_draft(run).strip():
            raise WorkflowError(
                "修订稿与上一稿完全相同", code="content_generation_invalid", failure_class="content",
                field_path="content", expected="draft with requested repairs applied", actual="unchanged", retryable=True,
            )
        revised = run.current_stage in REVISION_STAGES
        self._validate_author_realization(run, value.get("author_realization"), content)
        version = self._draft_versions(run) + 1
        path = self._stage_dir(run) / "drafts" / f"draft-v{version:02d}.md"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content + "\n", encoding="utf-8")
        self._write_artifact(run, "draft_self_check", {
            "draft_hash": hashlib.sha256(content.encode("utf-8")).hexdigest(),
            "author_realization": value.get("author_realization", []),
        })
        if revised:
            self._invalidate_review_artifacts(run, reason=f"正文在 {run.current_stage} 阶段产生新版本；旧审查只保留审计用途")
        self._retain_two_working_drafts(run)
        # Any body change invalidates every downstream prose gate.  Re-enter at
        # review_logic so a later voice/continuity approval can never outlive a
        # newly changed causal chain.
        following = "review_logic"
        self._advance(run, following, f"工作稿 v{version:02d} 已保存")

    def _submit_canon(self, run: WorkflowRun, value: dict[str, Any]) -> None:
        delta_fields = ["facts", "character_states", "relationships", "open_threads", "foreshadowing"]
        missing = [field for field in [*delta_fields, "evidence"] if field not in value]
        invalid = [field for field in [*delta_fields, "evidence"] if field in value and not isinstance(value[field], list)]
        if missing or invalid:
            raise WorkflowError(
                "Canon 更新必须提交全部数组字段；没有变化的类别使用空数组，禁止为了过校验编造事实",
                code="artifact_schema_invalid", failure_class="contract", field_path="canon_update",
                expected={field: "array (empty allowed)" for field in delta_fields} | {"evidence": "non-empty array"},
                actual={"missing": missing, "non_arrays": invalid}, retryable=True,
            )
        if not value["evidence"]:
            raise WorkflowError(
                "Canon 更新至少需要一条最终正文原文证据；事实类别可以为空",
                code="artifact_schema_invalid", failure_class="contract", field_path="evidence",
                expected="non-empty array of exact quotes", actual=value["evidence"], retryable=True,
            )
        content = self._current_draft(run)
        evidence = [str(item).strip() for item in value["evidence"]]
        for index, quote in enumerate(evidence):
            if quote not in content:
                raise WorkflowError(
                    "Canon evidence 必须逐条原样引用当前最终正文；请只修正 Canon 提取结果，不要改写已通过正文",
                    code="evidence_not_grounded", failure_class="evidence",
                    field_path=f"evidence[{index}]", expected="exact quote from current final draft",
                    actual=quote[:300], retryable=True,
                )
        raw_state_facts = value.get("state_facts", [])
        if not isinstance(raw_state_facts, list):
            raise WorkflowError(
                "state_facts 必须是数组", code="artifact_schema_invalid",
                failure_class="contract", field_path="state_facts",
                expected="array", actual=type(raw_state_facts).__name__, retryable=True,
            )
        state_facts: list[dict[str, Any]] = []
        for index, raw in enumerate(raw_state_facts):
            if not isinstance(raw, dict):
                raise WorkflowError(
                    f"state_facts[{index}] 必须是对象", code="artifact_schema_invalid",
                    failure_class="contract", field_path=f"state_facts[{index}]", retryable=True,
                )
            normalized = normalize_state_fact(
                str(raw.get("subject") or ""), str(raw.get("predicate") or ""), str(raw.get("value") or ""),
            )
            if normalized is None:
                raise WorkflowError(
                    f"state_facts[{index}] 谓词或取值无效；只允许类型无关谓词 {sorted(FACT_PREDICATES)}",
                    code="content_generation_invalid", failure_class="content",
                    field_path=f"state_facts[{index}]", retryable=True,
                )
            state_facts.append(normalized)
        gates = [self._load_gate(run, name) for name in STRICT_GATES]
        contract = self._contract(run.book_id, int(run.current_chapter))
        report = self.reviewer.review(contract, content, run.revision_round, gates=gates)
        if not report.passed:
            failures = "；".join(report.hard_failures)
            self._write_artifact(run, "final_validation", {
                "stage": "final_validation", "passed": False,
                "evidence": report.hard_failures,
                "repair_requirement": "修复确定性检查问题后重新执行对应审查门与 Canon 提取",
            })
            if run.revision_round >= run.max_revisions:
                run.status = "blocked"
                self.store.update_chapter_status(run.book_id, int(run.current_chapter), "blocked")
                return
            run.revision_round += 1
            # Length, duplicate-paragraph and summary-ending failures are body-level
            # repairs.  Sending them to continuity revision hid the actual failure
            # behind an already-passed continuity report and caused no-op loops.
            body_failure = any(
                marker in failure
                for failure in report.hard_failures
                for marker in ("正文长度", "重复段落", "总结式结尾")
            )
            revision_stage = "revise_logic" if body_failure else "revise_continuity"
            self._advance(run, revision_stage, f"最终确定性审查退回：{failures}")
            return
        prior = self.store.load_canon(run.book_id)
        prior_state_facts = prior.get("state_facts", []) if isinstance(prior.get("state_facts"), list) else []
        merged_state_facts, state_fact_conflicts = merge_state_facts(prior_state_facts, state_facts)
        regressions = detect_state_regression(prior_state_facts, merged_state_facts)
        hard_regressions = [item for item in regressions if item["severity"] == "hard"]
        if hard_regressions:
            detail = "；".join(str(item["detail"]) for item in hard_regressions)
            self._write_artifact(run, "final_validation", {
                "stage": "final_validation", "passed": False,
                "evidence": [str(item["detail"]) for item in hard_regressions],
                "repair_requirement": "修正 Canon 状态回退或补出可核验证据后重新提取",
            })
            if run.revision_round >= run.max_revisions:
                run.status = "blocked"
                self.store.update_chapter_status(run.book_id, int(run.current_chapter), "blocked")
                return
            run.revision_round += 1
            self._advance(run, "revise_continuity", f"确定性状态回归退回：{detail}")
            return
        self.store.save_chapter(contract, status="reviewed_pending_approval", content=content)
        self.store.save_review(report)
        snapshot: dict[str, Any] = {}
        for key in ["facts", "character_states", "relationships", "open_threads", "foreshadowing"]:
            merged: list[Any] = []
            seen: set[str] = set()
            for item in [*prior.get(key, []), *value[key]]:
                fingerprint = json.dumps(item, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
                if fingerprint in seen:
                    continue
                seen.add(fingerprint)
                merged.append(item)
            snapshot[key] = merged
        snapshot["state_facts"] = merged_state_facts
        if state_fact_conflicts:
            prior_conflicts = prior.get("state_fact_conflicts", [])
            prior_conflicts = prior_conflicts if isinstance(prior_conflicts, list) else []
            snapshot["state_fact_conflicts"] = [*prior_conflicts, *state_fact_conflicts]
        soft_regressions = [item for item in regressions if item["severity"] == "soft"]
        if soft_regressions:
            prior_notes = prior.get("state_regression_notes", [])
            prior_notes = prior_notes if isinstance(prior_notes, list) else []
            snapshot["state_regression_notes"] = [
                *prior_notes,
                *[{"chapter": int(run.current_chapter), **item} for item in soft_regressions],
            ]
        snapshot["evidence"] = evidence
        snapshot["evidence_history"] = [
            *prior.get("evidence_history", ([{"chapter": prior.get("chapter_number"), "quotes": prior.get("evidence", [])}] if prior.get("chapter_number") else [])),
            {"chapter": int(run.current_chapter), "quotes": evidence},
        ]
        snapshot["content_fingerprint"] = hashlib.sha256(content.encode("utf-8")).hexdigest()
        self.store.save_canon(run.book_id, int(run.current_chapter), snapshot)
        self._write_artifact(run, "canon_update", snapshot)
        self._record_confirmed_revision_learning(run, content)
        self._compact_approved_chapter(run)
        run.completed_chapters.append(int(run.current_chapter))
        self._finish_or_next(run)

    def _submit_arc_review(self, run: WorkflowRun, value: dict[str, Any]) -> WorkflowRun | None:
        text_fields = [
            "story_engine", "pacing", "character_change", "foreshadow_density", "pattern_repetition",
            "conflict_escalation", "mainline_progress", "reader_promise_fulfillment",
        ]
        list_fields = [
            "foreshadow_backlog", "ending_hook_repetition", "low_change_scenes", "next_batch_adjustments",
            "affected_chapters", "preserve", "changes", "risks", "evidence",
        ]
        missing = [field for field in ["passed", *text_fields, *list_fields] if field not in value]
        invalid_lists = [field for field in list_fields if field in value and not isinstance(value[field], list)]
        empty_text = [field for field in text_fields if not str(value.get(field, "")).strip()]
        if missing or invalid_lists or empty_text or not isinstance(value.get("passed"), bool):
            raise WorkflowError(
                "三章阶段审查字段必须与 StageAction Schema 完全一致",
                code="artifact_schema_invalid", failure_class="contract", field_path="arc_review",
                expected={"text": text_fields, "arrays": list_fields, "passed": "boolean"},
                actual={"missing": missing, "non_arrays": invalid_lists, "empty_text": empty_text}, retryable=True,
            )
        if not value["evidence"]:
            raise WorkflowError(
                "三章阶段审查必须提供正文原文证据", code="artifact_schema_invalid",
                failure_class="contract", field_path="evidence", expected="non-empty exact quotes",
                actual=value["evidence"], retryable=True,
            )
        workflow_dir = self.store.book_dir(run.book_id) / "workflow" / run.run_id
        arc_lineage = self._read_json(workflow_dir / "automatic-arc-repair.json")
        batch_numbers = (
            [int(item) for item in arc_lineage.get("review_chapters", [])]
            if isinstance(arc_lineage, dict) and not arc_lineage.get("resolved") and arc_lineage.get("review_chapters")
            else run.completed_chapters[-3:]
        )
        source_text = "\n".join(self.store.read_content(run.book_id, number) for number in batch_numbers)
        for index, raw_quote in enumerate(value["evidence"]):
            quote = str(raw_quote).strip()
            if not quote or quote not in source_text:
                raise WorkflowError(
                    "三章阶段审查 evidence 必须逐字来自本批正文",
                    code="evidence_not_grounded", failure_class="evidence",
                    field_path=f"evidence[{index}]", expected="exact quote from reviewed three-chapter batch",
                    actual=quote[:300], retryable=True,
                )
        self._write_artifact(run, "arc_review", value)
        if not value["passed"]:
            affected = sorted(set(int(item) for item in value["affected_chapters"] if str(item).isdigit()))
            if not affected or any(item not in batch_numbers for item in affected):
                raise WorkflowError(
                    "未通过的三章审查必须给出本批内的 affected_chapters",
                    code="artifact_schema_invalid", failure_class="contract", field_path="affected_chapters",
                    expected=batch_numbers, actual=value["affected_chapters"], retryable=True,
                )
            if not value["changes"] or not value["next_batch_adjustments"]:
                raise WorkflowError(
                    "未通过的三章审查必须给出可执行 changes 和 next_batch_adjustments",
                    code="artifact_schema_invalid", failure_class="contract", field_path="changes",
                    expected="non-empty repair plan", actual={"changes": value["changes"], "next_batch_adjustments": value["next_batch_adjustments"]}, retryable=True,
                )
            # Rebuilding an earlier chapter invalidates later accepted Canon.
            # Carry those dependencies too, not only the model's diagnosis.
            diagnosed = affected[:]
            affected = sorted(set(affected + [number for number in set(run.completed_chapters + batch_numbers)
                                               if number >= min(diagnosed)]))
            lineage = arc_lineage
            repair_round = int(lineage.get("round", 0)) if isinstance(lineage, dict) and not lineage.get("resolved") else 0
            if repair_round >= 2:
                run.status = "blocked"
                run.stage_history.append({
                    "stage": "arc_review", "result": "automatic_repair_limit_reached",
                    "affected_chapters": affected, "repair_round": repair_round, "at": utc_now(),
                })
                return None
            instruction = json.dumps({
                "source": "automatic_arc_review", "goal": "从章节设计开始解决三章复盘发现的结构问题",
                "preserve": value["preserve"], "changes": value["changes"],
                "next_batch_adjustments": value["next_batch_adjustments"], "risks": value["risks"],
                "evidence": value["evidence"],
            }, ensure_ascii=False, separators=(",", ":"))
            replacement = self.start_scope_rework(
                run.book_id, affected, instruction, scope_type="book",
                scope_id=f"arc:{run.run_id}", max_revisions=run.max_revisions,
            )
            replacement_dir = self.store.book_dir(run.book_id) / "workflow" / replacement.run_id
            pending = [number for number in run.chapter_numbers if number not in run.completed_chapters and number not in affected]
            replacement.chapter_numbers = sorted(set([*affected, *pending]))
            self.store.save_workflow_run(replacement)
            self.store.write_json(replacement_dir / "automatic-arc-repair.json", {
                "round": repair_round + 1, "source_run_id": run.run_id,
                "affected_chapters": affected, "diagnosed_chapters": diagnosed, "pending_chapters": pending,
                "review_chapters": batch_numbers, "created_at": utc_now(), "resolved": False,
            })
            self.next_action(replacement.run_id)
            run.status = "superseded"
            run.current_stage = "superseded"
            run.stage_history.append({
                "stage": "arc_review", "result": "automatic_scope_rework_started",
                "replacement_run_id": replacement.run_id, "affected_chapters": affected,
                "repair_round": repair_round + 1, "at": utc_now(),
            })
            return replacement
        if isinstance(arc_lineage, dict) and arc_lineage and not arc_lineage.get("resolved"):
            self.store.write_json(workflow_dir / "automatic-arc-repair.json", {**arc_lineage, "resolved": True})
        remaining = [item for item in run.chapter_numbers if item not in run.completed_chapters]
        if remaining:
            run.current_chapter = remaining[0]
            run.revision_round = 0
            self._advance(run, "chapter_design", "三章阶段审查通过")
        else:
            run.status = "completed"
            run.current_stage = "completed"
        return None

    def _update_traceability(
        self,
        run: WorkflowRun,
        submitted_stage: str,
        chapter_number: int | None,
        payload: dict[str, Any],
    ) -> None:
        """Update the reader-promise-to-Canon evidence chain.

        Failed reviews and working drafts stay pending.  A Canon delta is only
        recorded when the accepted ``canon_update.json`` exists, which means
        every strict review and the final deterministic validator passed.
        """
        trace_path = self.store.book_dir(run.book_id) / "workflow" / run.run_id / "traceability.json"
        existing = self._read_json(trace_path)
        trace: dict[str, Any] = existing if isinstance(existing, dict) else {
            "schema_version": "traceability-v1", "run_id": run.run_id,
            "book_id": run.book_id, "reader_promise": None,
            "volume_objectives": [], "chapters": {},
        }
        directory = self._stage_dir_for_chapter(run, chapter_number)
        if submitted_stage == "story_foundation":
            trace["reader_promise"] = payload.get("reader_promise")
            trace["volume_objectives"] = payload.get("volume_objectives", [])
            trace["foundation_artifact"] = str(directory / "story_foundation.json")
        if chapter_number is not None:
            contract = self._contract(run.book_id, chapter_number)
            chapters = trace.setdefault("chapters", {})
            chapter = chapters.setdefault(str(chapter_number), {
                "chapter_number": chapter_number, "contract": contract.to_dict(),
                "scene_card": None, "body": None, "reviews": {},
                "canon_delta": None, "next_chapter_entry": contract.next_first_beat,
            })
            if submitted_stage == "chapter_design":
                chapter["scene_card"] = {
                    "status": "pending_review",
                    "artifact": str(directory / "chapter_design.json"),
                    "scene_ids": [str(item.get("scene_id")) for item in payload.get("scenes", []) if isinstance(item, dict)],
                    "chapter_ending": payload.get("chapter_ending"),
                    "reader_experience_contract": payload.get("reader_experience_contract"),
                    "continuity_handoff": payload.get("continuity_handoff"),
                    "constraint_application": payload.get("constraint_application", []),
                }
            elif submitted_stage == "design_review" and payload.get("passed") is True and chapter.get("scene_card"):
                chapter["scene_card"]["status"] = "accepted"
            elif submitted_stage == "draft" or submitted_stage in REVISION_STAGES:
                draft_dir = directory / "drafts"
                drafts = sorted(draft_dir.glob("draft-v*.md")) if draft_dir.is_dir() else []
                if drafts:
                    chapter["body"] = {
                        "status": "pending_review", "path": str(drafts[-1]),
                        "sha256": self._file_hash(drafts[-1]), "source_stage": submitted_stage,
                    }
            if submitted_stage in REVIEW_STAGES:
                chapter["reviews"][submitted_stage] = {
                    "passed": bool(payload.get("passed")),
                    "artifact": str(directory / f"{submitted_stage}.json"),
                    "evidence": payload.get("evidence", []), "findings": payload.get("findings", []),
                    "revision_brief": payload.get("revision_brief", []),
                }
            if submitted_stage == "canon_update" and (directory / "canon_update.json").is_file():
                body_path = self.store.book_dir(run.book_id) / "drafts" / f"chapter-{chapter_number:04d}.md"
                if body_path.is_file():
                    chapter["body"] = {
                        **(chapter.get("body") or {}), "status": "accepted", "path": str(body_path),
                        "sha256": self._file_hash(body_path), "evidence": payload.get("evidence", []),
                    }
                chapter["canon_delta"] = {
                    "status": "accepted", "artifact": str(directory / "canon_update.json"),
                    "facts": payload.get("facts", []), "character_states": payload.get("character_states", []),
                    "relationships": payload.get("relationships", []), "open_threads": payload.get("open_threads", []),
                    "foreshadowing": payload.get("foreshadowing", []), "evidence": payload.get("evidence", []),
                }
            chapter["updated_at"] = utc_now()
        trace["updated_at"] = utc_now()
        self.store.write_json(trace_path, trace)

    def _stage_dir_for_chapter(self, run: WorkflowRun, chapter_number: int | None) -> Path:
        base = self.store.book_dir(run.book_id) / "workflow" / run.run_id
        return base if chapter_number is None else base / f"chapter-{chapter_number:04d}"

    def _finish_or_next(self, run: WorkflowRun) -> None:
        remaining = [item for item in run.chapter_numbers if item not in run.completed_chapters]
        workflow_dir = self.store.book_dir(run.book_id) / "workflow" / run.run_id
        arc_repair = self._read_json(workflow_dir / "automatic-arc-repair.json")
        automatic_arc_recheck = bool(arc_repair and not arc_repair.get("resolved")
                                    and set(arc_repair.get("affected_chapters", [])) <= set(run.completed_chapters))
        if len(run.completed_chapters) % 3 == 0 or automatic_arc_recheck:
            run.current_stage = "arc_review"
            return
        if remaining:
            run.current_chapter = remaining[0]
            run.current_stage = "chapter_design"
            run.revision_round = 0
        else:
            run.status = "completed"
            run.current_chapter = None
            run.current_stage = "completed"

    def _gate_from_value(self, stage: str, value: dict[str, Any]) -> ReviewGate:
        if value.get("gate") != stage:
            raise WorkflowError(
                f"review gate 必须是 {stage}", code="artifact_schema_invalid",
                failure_class="contract", field_path="gate", expected=stage,
                actual=value.get("gate"), retryable=True,
            )
        evidence = value.get("evidence")
        if not isinstance(evidence, list) or not evidence:
            raise WorkflowError(
                "每个审查门都必须提供非空 evidence", code="artifact_schema_invalid",
                failure_class="contract", field_path="evidence", expected="non-empty array",
                actual=evidence, retryable=True,
            )
        normalized_evidence = [
            str(item.get("quote") or "").strip() if isinstance(item, dict) else str(item).strip()
            for item in evidence
        ]
        if not all(normalized_evidence):
            raise WorkflowError(
                "每条 ReviewEvidence.quote 都不能为空", code="artifact_schema_invalid",
                failure_class="contract", field_path="evidence", expected="non-empty quotes",
                actual=evidence, retryable=True,
            )
        findings: list[ReviewFinding] = []
        raw_findings = value.get("findings", [])
        if not isinstance(raw_findings, list):
            raise WorkflowError(
                "findings 必须是数组", code="artifact_schema_invalid", failure_class="contract",
                field_path="findings", expected="array", actual=type(raw_findings).__name__, retryable=True,
            )
        for index, raw in enumerate(raw_findings):
            required = ["finding_id", "severity", "category", "location", "quote", "violated_rule", "repair_requirement"]
            try:
                self._require_nonempty(raw, required, "ReviewFinding")
            except WorkflowError as exc:
                raise WorkflowError(
                    str(exc), code="artifact_schema_invalid", failure_class="contract",
                    field_path=f"findings[{index}]", expected=required,
                    actual=sorted(raw) if isinstance(raw, dict) else type(raw).__name__, retryable=True,
                ) from exc
            findings.append(ReviewFinding(gate=stage, diagnosis=str(raw.get("diagnosis", "")), status=str(raw.get("status", "open")), **{key: raw[key] for key in required}))
        passed = bool(value.get("passed"))
        if passed and any(item.status == "open" for item in findings):
            raise WorkflowError(
                "passed=true 时不能保留 open finding", code="artifact_schema_invalid",
                failure_class="contract", field_path="findings", expected="no open finding",
                actual=[item.finding_id for item in findings if item.status == "open"], retryable=True,
            )
        return ReviewGate(
            gate=stage, passed=passed, evidence=normalized_evidence, findings=findings,
            summary=str(value.get("summary", "")), checks=list(value.get("checks") or []),
        )

    def _validate_required_checks(
        self,
        run: WorkflowRun,
        stage: str,
        checks: Any,
        evidence_map: dict[str, str],
        source_text: str,
    ) -> None:
        if not isinstance(checks, list):
            raise WorkflowError(
                f"{stage} 通过前必须提交结构化 checks", code="artifact_schema_invalid",
                failure_class="contract", field_path="checks", expected="array",
                actual=type(checks).__name__, retryable=True,
            )
        malformed = [index for index, item in enumerate(checks) if not isinstance(item, dict)]
        names = [str(item.get("name", "")) for item in checks if isinstance(item, dict)]
        duplicates = sorted({name for name in names if name and names.count(name) > 1})
        expected_names = list(self._required_checks(run, stage))
        missing = sorted(set(expected_names) - set(names))
        unexpected = sorted(set(names) - set(expected_names))
        if malformed or missing or unexpected or duplicates or len(checks) != len(expected_names):
            raise WorkflowError(
                f"{stage} checks 必须逐项使用 StageAction 中的固定检查 ID；"
                f"缺少：{', '.join(missing) or '无'}；多余：{', '.join(unexpected) or '无'}；"
                f"重复：{', '.join(duplicates) or '无'}",
                code="artifact_schema_invalid", failure_class="contract", field_path="checks",
                expected=expected_names,
                actual={"names": names, "malformed_indexes": malformed}, retryable=True,
            )
        by_name = {str(item["name"]): item for item in checks}
        for name in expected_names:
            item = by_name[name]
            if item.get("passed") is not True:
                raise WorkflowError(
                    f"{stage} 检查项未通过：{name}", code="artifact_schema_invalid",
                    failure_class="contract", field_path=f"checks.{name}.passed",
                    expected=True, actual=item.get("passed"), retryable=True,
                )
            self._validate_evidence_binding(
                item, evidence_map, source_text, field_path=f"checks.{name}",
            )

    def _load_gate(self, run: WorkflowRun, stage: str) -> ReviewGate:
        path = self._stage_dir(run) / f"{stage}.json"
        if not path.is_file():
            raise WorkflowError(f"缺少审查产物：{stage}")
        value = json.loads(path.read_text(encoding="utf-8"))
        self._validate_review_binding(run, stage, value)
        return self._gate_from_value(stage, value)

    def _review_binding(self, run: WorkflowRun, stage: str) -> dict[str, Any]:
        stage_dir = self._stage_dir(run)
        book_dir = self.store.book_dir(run.book_id)
        design_path = stage_dir / "chapter_design.json"
        action = self._read_json(stage_dir / f"{stage}.action.json")
        policy = self._writing_policy(run)
        source_kind = "chapter_design" if stage == "design_review" else "draft"
        if source_kind == "chapter_design":
            if not design_path.is_file():
                raise WorkflowError("设计审查缺少 chapter_design 产物")
            source_hash = self._file_hash(design_path)
            draft_hash = ""
        else:
            source_text = self._current_draft(run)
            source_hash = hashlib.sha256(source_text.encode("utf-8")).hexdigest()
            draft_hash = source_hash
        hashes: dict[str, str] = {}
        for name, path in {
            "master_outline_hash": book_dir / "outlines" / "master.json",
            "chapters_outline_hash": book_dir / "outlines" / "chapters.json",
            "foundation_contract_hash": book_dir / "outlines" / "foundation-contract.json",
        }.items():
            hashes[name] = self._file_hash(path) if path.is_file() else ""
        contract = self._contract(run.book_id, int(run.current_chapter)).to_dict() if run.current_chapter else {}
        return {
            "schema_version": "review-lineage-v1",
            "run_id": run.run_id,
            "book_id": run.book_id,
            "chapter_number": run.current_chapter,
            "review_stage": stage,
            "source_kind": source_kind,
            "source_hash": source_hash,
            "draft_hash": draft_hash,
            "chapter_design_hash": self._file_hash(design_path) if design_path.is_file() else "",
            "chapter_contract_hash": self._canonical_hash(contract),
            "canon_hash": self._canonical_hash(self.store.load_canon(run.book_id)),
            "author_policy_hash": str(policy.get("policy_hash") or self._canonical_hash(policy)),
            "action_id": str(action.get("action_id") or "") if isinstance(action, dict) else "",
            "action_inputs_hash": str(action.get("inputs_hash") or "") if isinstance(action, dict) else "",
            **hashes,
        }

    def _validate_review_binding(self, run: WorkflowRun, stage: str, value: dict[str, Any]) -> None:
        actual = value.get("review_lineage")
        if not isinstance(actual, dict) or actual.get("schema_version") != "review-lineage-v1":
            raise WorkflowError(
                f"审查产物 {stage} 缺少当前正文来源链；旧审查不得批准新稿",
                code="stale_review", failure_class="lineage", field_path=f"{stage}.review_lineage",
                expected="review-lineage-v1", actual=actual, retryable=False,
            )
        expected = self._review_binding(run, stage)
        changed = sorted(key for key, digest in expected.items() if actual.get(key) != digest)
        if changed:
            raise WorkflowError(
                f"审查产物 {stage} 已过期（{', '.join(changed)} 发生变化）；必须从 review_logic 重新审查当前稿",
                code="stale_review", failure_class="lineage", field_path=f"{stage}.review_lineage",
                expected={key: expected[key] for key in changed},
                actual={key: actual.get(key) for key in changed}, retryable=False,
            )

    def _invalidate_review_artifacts(self, run: WorkflowRun, *, reason: str) -> None:
        stage_dir = self._stage_dir(run)
        draft_version = self._draft_versions(run)
        archive = stage_dir / "audit" / "review-history" / f"superseded-by-draft-v{draft_version:02d}"
        if archive.exists():
            archive = archive.with_name(f"{archive.name}-{uuid.uuid4().hex[:8]}")
        archived: list[str] = []
        for stage in ("review_logic", "review_voice", "review_continuity", "cold_review", "final_validation", "canon_update"):
            for name in (f"{stage}.json", f"{stage}.action.json", f"{stage}.prompt.md"):
                source = stage_dir / name
                if not source.is_file():
                    continue
                destination = archive / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(source), str(destination))
                archived.append(name)
        if not archived:
            return
        self.store.write_json(archive / "manifest.json", {
            "schema_version": "superseded-review-bundle-v1",
            "run_id": run.run_id,
            "chapter_number": run.current_chapter,
            "superseded_by_draft_version": draft_version,
            "superseded_by_draft_hash": hashlib.sha256(self._current_draft(run).encode("utf-8")).hexdigest(),
            "reason": reason,
            "archived_files": archived,
            "archived_at": utc_now(),
            "active": False,
        })
        self.store.append_event(run.book_id, run.current_chapter, "review_artifacts_superseded", {
            "run_id": run.run_id, "draft_version": draft_version, "archived_files": archived,
        })

    @staticmethod
    def _canonical_hash(value: Any) -> str:
        payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    @staticmethod
    def _file_hash(path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()

    def _stage_action_inputs(self, run: WorkflowRun) -> dict[str, Any]:
        """Build the authoritative, deterministic input snapshot for one stage.

        The model never supplies these hashes.  The snapshot intentionally
        covers both the compact context and its authoritative files so an edit
        made after task issue cannot silently flow into a stale downstream
        artifact.
        """
        context = self._stage_context(run)
        policy = self._writing_policy(run)
        book_dir = self.store.book_dir(run.book_id)
        stage_dir = self._stage_dir(run)
        paths: set[Path] = set()
        for candidate in (
            book_dir / "outlines" / "master.json",
            book_dir / "outlines" / "chapters.json",
            book_dir / "outlines" / "foundation-contract.json",
            book_dir / "workflow" / run.run_id / "writing-policy.json",
        ):
            if candidate.is_file():
                paths.add(candidate)
        canon_dir = book_dir / "canon"
        if canon_dir.is_dir():
            paths.update(
                path for path in canon_dir.glob("*.json")
                if path.name not in {"writing-policy.json", "author-preferences.json"}
            )
        upstream_by_stage = {
            "chapter_design": ["story_foundation.json"],
            "design_review": ["chapter_design.json"],
            "draft": ["chapter_design.json", "design_review.json"],
            "review_logic": ["chapter_design.json"],
            "review_voice": ["chapter_design.json", "review_logic.json"],
            "review_continuity": ["chapter_design.json", "review_logic.json", "review_voice.json"],
            "cold_review": ["chapter_design.json", "review_logic.json", "review_voice.json", "review_continuity.json"],
            "canon_update": ["chapter_design.json", "review_logic.json", "review_voice.json", "review_continuity.json", "cold_review.json"],
        }
        stage = run.current_stage
        for name in upstream_by_stage.get(stage, []):
            candidate = stage_dir / name
            if candidate.is_file():
                paths.add(candidate)
        if stage in REVISION_STAGES:
            failed = stage_dir / f"{REVISION_STAGES[stage]}.json"
            validation = stage_dir / "final_validation.json"
            if failed.is_file():
                paths.add(failed)
            if validation.is_file():
                paths.add(validation)
        for candidate in (stage_dir / "rework-request.json", stage_dir / "rework-source.md"):
            if candidate.is_file():
                paths.add(candidate)
        draft_dir = stage_dir / "drafts"
        drafts = sorted(draft_dir.glob("draft-v*.md")) if draft_dir.is_dir() else []
        if drafts and stage in REVIEW_STAGES | REVISION_STAGES.keys() | {"canon_update"}:
            paths.add(drafts[-1])
        input_files = {
            str(path.relative_to(self.root)).replace("\\", "/"): self._file_hash(path)
            for path in sorted(paths, key=lambda item: str(item).lower())
        }
        contract = self._contract(run.book_id, int(run.current_chapter)).to_dict() if run.current_chapter else {}
        input_hashes = {
            "context": self._canonical_hash(context),
            "author_policy": str(policy.get("policy_hash") or self._canonical_hash(policy)),
            "canon": self._canonical_hash(self.store.load_canon(run.book_id)),
            "chapter_contract": self._canonical_hash(contract),
            "files": self._canonical_hash(input_files),
        }
        return {
            "input_hashes": input_hashes,
            "input_files": input_files,
            "inputs_hash": self._canonical_hash(input_hashes),
            "author_version_hash": input_hashes["author_policy"],
            "canon_hash": input_hashes["canon"],
            "chapter_contract_hash": input_hashes["chapter_contract"],
        }

    def _validate_stage_action(self, run: WorkflowRun, submitted_action_id: str | None) -> dict[str, Any]:
        action_path = self._stage_dir(run) / f"{run.current_stage}.action.json"
        issued = self._read_json(action_path)
        # Direct Python callers from the pre-V2 API remain source-compatible.
        # CLI/Studio submissions always provide an explicit action id and never
        # receive this convenience path.
        if submitted_action_id is None:
            self.next_action(run.run_id)
            issued = self._read_json(action_path)
        if not isinstance(issued, dict) or issued.get("schema_version") != "stage-action-v2":
            raise WorkflowError(
                "当前阶段缺少 StageActionV2；请刷新阶段任务后再提交",
                code="stale_inputs", failure_class="lineage", field_path="action_id",
                expected="issued StageActionV2", actual=submitted_action_id or "missing", retryable=False,
            )
        effective_action_id = submitted_action_id or str(issued.get("action_id") or "")
        if effective_action_id != issued.get("action_id"):
            raise WorkflowError(
                "提交引用的 action_id 已过期；下游旧产物不得继续使用",
                code="stale_inputs", failure_class="lineage", field_path="action_id",
                expected=issued.get("action_id"), actual=effective_action_id, retryable=False,
            )
        current = self._stage_action_inputs(run)
        if current["inputs_hash"] != issued.get("inputs_hash"):
            changed = sorted(
                key for key, digest in current["input_hashes"].items()
                if digest != (issued.get("input_hashes") or {}).get(key)
            )
            raise WorkflowError(
                f"阶段输入在任务签发后发生变化：{', '.join(changed) or 'unknown'}；请刷新输入并重建任务",
                code="stale_inputs", failure_class="lineage", field_path="inputs_hash",
                expected=issued.get("inputs_hash"), actual=current["inputs_hash"], retryable=False,
            )
        return issued

    @classmethod
    def _validate_payload_against_schema(
        cls,
        value: Any,
        schema: Any,
        *,
        field_path: str = "$",
    ) -> None:
        """Validate the StageAction subset of JSON Schema before business gates.

        The generator, the prompt and the submitter now consume the same
        contract.  Keeping this small validator in-process avoids making an
        optional dependency authoritative while still covering every keyword
        emitted by ``_output_json_schema``.
        """
        if not isinstance(schema, dict) or not schema:
            return
        expected_type = schema.get("type")
        type_ok = {
            "object": isinstance(value, dict),
            "array": isinstance(value, list),
            "string": isinstance(value, str),
            "integer": isinstance(value, int) and not isinstance(value, bool),
            "number": isinstance(value, (int, float)) and not isinstance(value, bool),
            "boolean": isinstance(value, bool),
        }.get(str(expected_type), True)
        if not type_ok:
            raise WorkflowError(
                f"JSON Schema 校验失败：{field_path} 类型应为 {expected_type}",
                code="artifact_schema_invalid", failure_class="contract", field_path=field_path,
                expected=expected_type, actual=type(value).__name__, retryable=True,
            )
        if "const" in schema and value != schema["const"]:
            raise WorkflowError(
                f"JSON Schema 校验失败：{field_path} 必须等于固定值",
                code="artifact_schema_invalid", failure_class="contract", field_path=field_path,
                expected=schema["const"], actual=value, retryable=True,
            )
        if isinstance(schema.get("enum"), list) and value not in schema["enum"]:
            raise WorkflowError(
                f"JSON Schema 校验失败：{field_path} 不在允许值中",
                code="artifact_schema_invalid", failure_class="contract", field_path=field_path,
                expected=schema["enum"], actual=value, retryable=True,
            )
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            if "minimum" in schema and value < schema["minimum"]:
                raise WorkflowError(
                    f"JSON Schema 校验失败：{field_path} 小于最小值",
                    code="artifact_schema_invalid", failure_class="contract", field_path=field_path,
                    expected=f">={schema['minimum']}", actual=value, retryable=True,
                )
            if "maximum" in schema and value > schema["maximum"]:
                raise WorkflowError(
                    f"JSON Schema 校验失败：{field_path} 大于最大值",
                    code="artifact_schema_invalid", failure_class="contract", field_path=field_path,
                    expected=f"<={schema['maximum']}", actual=value, retryable=True,
                )
        if isinstance(value, dict):
            required = schema.get("required") or []
            missing = [name for name in required if name not in value]
            if missing:
                missing_path = missing[0] if field_path == "$" and len(missing) == 1 else field_path
                raise WorkflowError(
                    f"JSON Schema 校验失败：{field_path} 缺少字段 {', '.join(missing)}",
                    code="artifact_schema_invalid", failure_class="contract", field_path=missing_path,
                    expected=required, actual=sorted(value), retryable=True,
                )
            properties = schema.get("properties") or {}
            if schema.get("additionalProperties") is False:
                unexpected = sorted(set(value) - set(properties))
                if unexpected:
                    raise WorkflowError(
                        f"JSON Schema 校验失败：{field_path} 含未声明字段 {', '.join(unexpected)}",
                        code="artifact_schema_invalid", failure_class="contract", field_path=field_path,
                        expected=sorted(properties), actual=sorted(value), retryable=True,
                    )
            elif isinstance(schema.get("additionalProperties"), dict):
                for name, child_value in value.items():
                    cls._validate_payload_against_schema(
                        child_value, schema["additionalProperties"], field_path=name if field_path == "$" else f"{field_path}.{name}"
                    )
            if "minProperties" in schema and len(value) < int(schema["minProperties"]):
                raise WorkflowError(
                    f"JSON Schema 校验失败：{field_path} 至少需要 {schema['minProperties']} 个字段",
                    code="artifact_schema_invalid", failure_class="contract", field_path=field_path,
                    expected=f"minProperties={schema['minProperties']}", actual=len(value), retryable=True,
                )
            for name, child in properties.items():
                if name in value:
                    cls._validate_payload_against_schema(value[name], child, field_path=name if field_path == "$" else f"{field_path}.{name}")
        if isinstance(value, list):
            if "minItems" in schema and len(value) < int(schema["minItems"]):
                label = "RevisionBrief" if field_path.endswith("revision_brief") else field_path
                raise WorkflowError(
                    f"JSON Schema 校验失败：{label} 至少需要 {schema['minItems']} 项",
                    code="artifact_schema_invalid", failure_class="contract", field_path=field_path,
                    expected=f"minItems={schema['minItems']}", actual=len(value), retryable=True,
                )
            if "maxItems" in schema and len(value) > int(schema["maxItems"]):
                raise WorkflowError(
                    f"JSON Schema 校验失败：{field_path} 最多允许 {schema['maxItems']} 项",
                    code="artifact_schema_invalid", failure_class="contract", field_path=field_path,
                    expected=f"maxItems={schema['maxItems']}", actual=len(value), retryable=True,
                )
            if schema.get("uniqueItems"):
                fingerprints = [json.dumps(item, ensure_ascii=False, sort_keys=True, separators=(",", ":")) for item in value]
                if len(fingerprints) != len(set(fingerprints)):
                    raise WorkflowError(
                        f"JSON Schema 校验失败：{field_path} 不允许重复项",
                        code="artifact_schema_invalid", failure_class="contract", field_path=field_path,
                        expected="uniqueItems", actual=value, retryable=True,
                    )
            prefix = schema.get("prefixItems") or []
            for index, child in enumerate(prefix[:len(value)]):
                cls._validate_payload_against_schema(value[index], child, field_path=f"{field_path}[{index}]")
            items = schema.get("items")
            if items is False and len(value) > len(prefix):
                raise WorkflowError(
                    f"JSON Schema 校验失败：{field_path} 包含额外数组项",
                    code="artifact_schema_invalid", failure_class="contract", field_path=field_path,
                    expected=len(prefix), actual=len(value), retryable=True,
                )
            if isinstance(items, dict):
                start = len(prefix) if prefix else 0
                for index in range(start, len(value)):
                    cls._validate_payload_against_schema(value[index], items, field_path=f"{field_path}[{index}]")
        for child in schema.get("allOf") or []:
            condition = child.get("if") if isinstance(child, dict) else None
            if condition is None:
                cls._validate_payload_against_schema(value, child, field_path=field_path)
                continue
            branch = child.get("then") if cls._schema_matches(value, condition) else child.get("else")
            if isinstance(branch, dict):
                cls._validate_payload_against_schema(value, branch, field_path=field_path)
        options = schema.get("oneOf") or []
        if options:
            matches = sum(1 for option in options if cls._schema_matches(value, option))
            if matches != 1:
                raise WorkflowError(
                    f"JSON Schema 校验失败：{field_path} 必须且只能符合 oneOf 中一个分支",
                    code="artifact_schema_invalid", failure_class="contract", field_path=field_path,
                    expected="exactly one oneOf branch", actual=matches, retryable=True,
                )

    @classmethod
    def _schema_matches(cls, value: Any, schema: Any) -> bool:
        try:
            cls._validate_payload_against_schema(value, schema)
            return True
        except WorkflowError:
            return False

    @classmethod
    def _schema_from_shape(cls, value: Any, *, field: str = "") -> dict[str, Any]:
        if isinstance(value, dict):
            if field in {"terminology", "character_knowledge"}:
                sample = next(iter(value.values()), "")
                return {
                    "type": "object", "minProperties": 1,
                    "additionalProperties": cls._schema_from_shape(sample, field=f"{field}_entry"),
                }
            properties = {key: cls._schema_from_shape(item, field=key) for key, item in value.items()}
            schema: dict[str, Any] = {"type": "object", "properties": properties, "required": list(value), "additionalProperties": False}
            if field == "quality_scorecard":
                schema["minProperties"] = len(value)
            return schema
        if isinstance(value, list):
            schema = {"type": "array", "items": cls._schema_from_shape(value[0], field=field) if value else {}}
            # constraint_application 允许为空（system 兼容运行无约束时合法）；"必须映射"
            # 的强制由 _validate_*_constraint_application 的 required 校验负责。
            if value and field not in {"findings", "revision_brief", "constraint_application", "conflict_dimensions", "author_realization"}:
                schema["minItems"] = 1
            return schema
        if isinstance(value, bool):
            return {"type": "boolean"}
        if isinstance(value, int):
            schema = {"type": "integer"}
            if field == "score":
                schema.update({"minimum": 1, "maximum": 5})
            return schema
        if isinstance(value, (int, float)):
            return {"type": "number"}
        text = str(value)
        enum_values = [item.strip() for item in text.split("|") if item.strip()]
        if "|" in text and 1 < len(enum_values) <= 16 and all(len(item) <= 32 for item in enum_values):
            return {"type": "string", "enum": enum_values}
        return {"type": "string", "description": text}

    def _output_json_schema(self, run: WorkflowRun, stage: str, shape: dict[str, Any]) -> dict[str, Any]:
        schema = self._schema_from_shape(shape)
        schema.update({"$schema": "https://json-schema.org/draft/2020-12/schema", "title": f"Tomota {stage} payload"})
        properties = schema.get("properties", {})
        if "stage" in properties:
            properties["stage"] = {"type": "string", "const": stage}
        if "schema_version" in properties:
            properties["schema_version"] = {"type": "string", "const": "review-artifact-v2"}
        if stage in REVIEW_STAGES:
            properties["gate"] = {"type": "string", "const": stage}
            required_checks = self._required_checks(run, stage)
            check_schemas = [
                {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string", "const": name},
                        "passed": {"type": "boolean"},
                        "evidence_refs": {"type": "array", "items": {"type": "string"}, "minItems": 1},
                    },
                    "required": ["name", "passed", "evidence_refs"],
                    "additionalProperties": False,
                    "description": CHECK_DESCRIPTIONS[name],
                }
                for name in required_checks
            ]
            properties["checks"] = {
                "type": "array", "prefixItems": check_schemas, "items": False,
                "minItems": len(check_schemas), "maxItems": len(check_schemas),
                "description": "固定顺序、固定 ID；不得用近义名称替换",
            }
            finding_properties = (((properties.get("findings") or {}).get("items") or {}).get("properties") or {})
            if finding_properties:
                finding_properties["severity"] = {"type": "string", "enum": ["blocker", "warning"]}
                finding_properties["status"] = {"type": "string", "const": "open"}
            schema["x-tomota-required-checks"] = list(required_checks)
            schema["allOf"] = [{
                "if": {"properties": {"passed": {"const": True}}, "required": ["passed"]},
                "then": {"properties": {"revision_brief": {"maxItems": 0}, "findings": {"maxItems": 0}}},
                "else": {"properties": {"revision_brief": {"minItems": 1}, "findings": {"minItems": 1}}},
            }]
        if stage == "arc_review":
            for field in [
                "foreshadow_backlog", "ending_hook_repetition", "low_change_scenes",
                "next_batch_adjustments", "preserve", "changes", "risks",
            ]:
                properties[field] = {"type": "array", "items": {"type": "string"}}
            properties["affected_chapters"] = {"type": "array", "items": {"type": "integer", "minimum": 1}, "uniqueItems": True}
            properties["evidence"] = {"type": "array", "items": {"type": "string"}, "minItems": 1}
            schema["allOf"] = [{
                "if": {"properties": {"passed": {"const": False}}, "required": ["passed"]},
                "then": {"properties": {
                    "affected_chapters": {"minItems": 1},
                    "changes": {"minItems": 1},
                    "next_batch_adjustments": {"minItems": 1},
                }},
            }]
        if stage in REVISION_STAGES:
            schema["required"] = ["stage"]
            schema["oneOf"] = [{"required": ["content"]}, {"required": ["replacements"]}]
        return schema

    def _compile_stage_writing_policy(
        self, run: WorkflowRun, writing_policy: dict[str, Any], context: dict[str, Any],
    ) -> dict[str, Any]:
        """Compile every applicable author rule into a stage execution receipt.

        Rules are never selected by arbitrary top-N truncation.  The compiler
        records why and where a rule is active, and carries design mappings
        forward into drafting/revision/review so constraints are applied rather
        than pasted into prose as a flat checklist.
        """
        stage_applications = {
                "story_foundation": {"book_design", "volume_design"},
                # Chapter design must plan both structure and later prose
                # realization. Otherwise expression rules first appear only
                # after the scene cards are already frozen.
                "chapter_design": {"chapter_design", "drafting", "dialogue"},
                "design_review": {"chapter_design", "drafting", "dialogue", "revision"},
                "draft": {"drafting", "dialogue", "revision"},
                "review_logic": {"chapter_design", "revision"},
                "review_voice": {"drafting", "dialogue", "revision"},
                "review_continuity": {"chapter_design", "revision"},
                "cold_review": {"drafting", "dialogue", "revision"},
                "canon_update": set(),
                "arc_review": {"book_design", "volume_design", "chapter_design", "drafting", "dialogue", "revision"},
        }
        relevant = stage_applications.get(run.current_stage, {"drafting", "dialogue", "revision"} if run.current_stage in REVISION_STAGES else set())
        active_rules = writing_policy.get("active_rules") if isinstance(writing_policy.get("active_rules"), list) else []
        matching_rules = [
            item for item in active_rules if isinstance(item, dict)
            and relevant.intersection({str(value) for value in item.get("applies_to", [])})
        ]
        matching_rules.sort(key=lambda item: (
            0 if item.get("source") == "book_override" else 1,
            -float(item.get("stability") or 0) if isinstance(item.get("stability"), (int, float)) else 0,
            -float(item.get("confidence") or 0) if isinstance(item.get("confidence"), (int, float)) else 0,
        ))
        design = context.get("design") if isinstance(context.get("design"), dict) else {}
        applications = design.get("constraint_application") if isinstance(design.get("constraint_application"), list) else []
        mapped: dict[str, dict[str, Any]] = {
            str(item.get("constraint_id")): item for item in applications
            if isinstance(item, dict) and item.get("constraint_id")
        }
        stage_rules = []
        unmapped: list[str] = []
        for item in matching_rules:
            rule_id = "style-" + self._canonical_hash({
                "source": item.get("source"), "category": item.get("category"),
                "rule": item.get("rule"), "axis": item.get("axis"),
            })[:12]
            avoid_value = item.get("avoid")
            requirement = str(item.get("application_requirement") or "required")
            # A method's pitfalls are not its obligation: contextual methods
            # remain contextual even when they carry an avoid clause.
            rule_class = "must" if item.get("source") == "book_override" or requirement in {
                "required", "required_unless_conflict", "required_unless_user_or_canon_conflict",
            } else "should"
            mapping = mapped.get(rule_id)
            suppressed = bool(mapping and mapping.get("conflict_status") == "suppressed_by_higher_rule")
            if suppressed:
                activation, reason = "suppressed", "设计已由上位规则压制；不执行原方法，审查仅核对压制依据及上位规则"
            elif run.current_stage == "chapter_design":
                activation, reason = "stage_applicable", "章节设计必须映射到具体场景、执行动作和验收条件"
            elif run.current_stage in REVIEW_STAGES or run.current_stage == "design_review":
                activation, reason = "review_guard", "审查必须核对规则是否自然落实且未覆盖上位约束"
            elif mapping:
                activation, reason = "scene_mapped", "沿用已通过章节设计中的场景映射"
            elif rule_class in {"must", "avoid"}:
                activation, reason = "global_guard", "硬性覆盖或禁忌未被场景映射，仍作为全文底线执行"
                unmapped.append(rule_id)
            else:
                activation, reason = "global_fallback", "设计未映射该倾向；自然考虑并在审查中公开记录遗漏"
                unmapped.append(rule_id)
            stage_rules.append({
                "rule_id": rule_id, "class": rule_class,
                "application_requirement": requirement,
                "execution_required": rule_class == "must" and not suppressed,
                "conflict_status": mapping.get("conflict_status", "active") if mapping else "active",
                "suppressed_by": mapping.get("suppressed_by") if suppressed else None,
                "conflict_reason": mapping.get("conflict_reason") if suppressed else None,
                "conflict_dimensions": mapping.get("conflict_dimensions", []) if suppressed else [],
                "source": item.get("source"), "category": item.get("category"),
                "axis": item.get("axis"), "instruction": item.get("rule"),
                "activation": activation, "activation_reason": reason,
                "scene_ids": mapping.get("scene_ids", []) if mapping else [],
                "designed_execution": mapping.get("execution") if mapping else None,
                "designed_acceptance_test": mapping.get("acceptance_test") if mapping else None,
                "trigger": item.get("trigger"),
                "implementation_steps": item.get("implementation_steps") or [],
                "allowed_variations": item.get("allowed_variations") or [],
                "acceptance_tests": item.get("acceptance_tests") or [],
                "avoid": avoid_value,
                "links": item.get("links") or [],
                "evidence_ids": item.get("evidence_ids") or [],
                "counterevidence_ids": item.get("counterevidence_ids") or [],
                "failure_modes": item.get("failure_modes") or [],
                "non_applicable_cases": item.get("non_applicable_cases") or [],
                "transfer_verdict": item.get("transfer_verdict") or "",
            })
        contract = writing_policy.get("author_book_contract") if isinstance(writing_policy.get("author_book_contract"), dict) else {}
        blueprint = contract.get("application_blueprint") if isinstance(contract.get("application_blueprint"), dict) else {}
        for blueprint_stage in sorted(relevant):
            rows = blueprint.get(blueprint_stage)
            if not isinstance(rows, list):
                continue
            for index, instruction in enumerate(rows):
                normalized = str(instruction).strip()
                if not normalized:
                    continue
                rule_id = "style-blueprint-" + self._canonical_hash({
                    "stage": blueprint_stage, "instruction": normalized,
                })[:12]
                mapping = mapped.get(rule_id)
                suppressed = bool(mapping and mapping.get("conflict_status") == "suppressed_by_higher_rule")
                stage_rules.append({
                    "rule_id": rule_id, "class": "must", "source": "author_blueprint",
                    "application_requirement": "required", "execution_required": not suppressed,
                    "conflict_status": mapping.get("conflict_status", "active") if mapping else "active",
                    "suppressed_by": mapping.get("suppressed_by") if suppressed else None,
                    "conflict_reason": mapping.get("conflict_reason") if suppressed else None,
                    "conflict_dimensions": mapping.get("conflict_dimensions", []) if suppressed else [],
                    "category": f"application_blueprint.{blueprint_stage}",
                    "axis": f"application_blueprint:{blueprint_stage}:{index + 1}",
                    "instruction": normalized,
                    "activation": "suppressed" if suppressed else "scene_mapped" if mapping else "stage_blueprint",
                    "activation_reason": "上位规则已压制，禁止执行原蓝图指令" if suppressed else "作者版本发布时冻结的阶段执行蓝图；必须落实而非只声明符合",
                    "scene_ids": mapping.get("scene_ids", []) if mapping else [],
                    "designed_execution": mapping.get("execution") if mapping else None,
                    "designed_acceptance_test": mapping.get("acceptance_test") if mapping else None,
                    "trigger": f"进入 {blueprint_stage} 阶段时",
                    "implementation_steps": [normalized], "allowed_variations": [],
                    "acceptance_tests": [f"当前产物存在可定位证据：{normalized}"], "avoid": "",
                })
                if not mapping:
                    unmapped.append(rule_id)
        binding = writing_policy.get("author_binding") if isinstance(writing_policy.get("author_binding"), dict) else {}
        is_compatibility = bool(binding.get("is_system")) or str(binding.get("author_id") or "") == "system-legacy-author"
        author_required_stages = {
            "story_foundation", "chapter_design", "design_review", "draft", "review_logic",
            "review_voice", "review_continuity", "cold_review", "arc_review",
            *REVISION_STAGES.keys(),
        }
        if run.current_stage in author_required_stages and not is_compatibility and not stage_rules:
            raise WorkflowError(
                f"{run.current_stage} 没有任何可执行作者规则；拒绝静默退化为通用写作",
                code="author_contract_missing", failure_class="contract",
                field_path="writing_policy.author_book_contract", expected="at least one stage-applicable rule",
                actual=0, retryable=False,
            )
        counts = Counter(str(item["class"]) for item in stage_rules)
        return {
            "schema_version": "stage-writing-policy-v2",
            "policy_hash": writing_policy.get("policy_hash"),
            "author_binding": writing_policy.get("author_binding"),
            "precedence": writing_policy.get("precedence"),
            "hard_rules": writing_policy.get("hard_rules"),
            "conflicts": writing_policy.get("conflicts"),
            "stage": run.current_stage,
            "stage_blueprint": {key: blueprint.get(key, []) for key in sorted(relevant) if isinstance(blueprint.get(key), list)},
            "executable_style_rules": stage_rules,
            "classification_counts": {key: counts.get(key, 0) for key in ("must", "should", "avoid")},
            "unmapped_rule_ids": unmapped,
            "executable_count": len(stage_rules),
            "withheld_for_other_stages": max(0, len(active_rules) - len(stage_rules)),
            "compilation_rule": "注入全部当前阶段适用规则；以激活原因和场景映射执行，不按数量截断",
            "application_rule": "设计阶段逐场映射；正文遵守 execution_required 与 conflict_status，禁止执行已压制方法；contextual 方法按 trigger 自然选用，avoid 仅是方法禁忌而非强制激活条件；审查输出公开落实证据",
            "statistical_targets": contract.get("statistical_targets") or [],
        }

    def _render_stage_prompt(self, run: WorkflowRun, action: dict[str, Any]) -> str:
        modules = MODULE_BY_STAGE.get(run.current_stage, ["consistency_review"])
        if run.current_stage in REVISION_STAGES:
            modules = MODULE_BY_STAGE[REVISION_STAGES[run.current_stage]]
        pack = self.skill.build_prompt_pack(
            task=action["task"], stage=run.current_stage, module_chain=modules,
            compact=True,
        )
        context = self._stage_context(run)
        writing_policy = self._writing_policy(run)
        preference_text = ""
        if writing_policy:
            compact_policy = self._compile_stage_writing_policy(run, writing_policy, context)
            stage_rules = compact_policy["executable_style_rules"]
            preference_text = (
                "\n## 冻结写作策略（按 precedence 执行；文风不得覆盖 Canon、契约与质量闸门）\n"
                + json.dumps(compact_policy, ensure_ascii=False, indent=2)
                + ("\nexecution_required=true 的文风方法必须有可核验落实；contextual 方法仅在 trigger 适用时自然采用。"
                   "conflict_status=suppressed_by_higher_rule 的原方法禁止执行，保留冲突记录供复核。允许按 allowed_variations 自然变化，"
                   "不得机械逐条复刻。若与 Canon、基础契约或人物知识边界冲突，必须服从上位约束并公开记录冲突。"
                   if stage_rules else "")
            )
        review_rule = ""
        if run.current_stage in REVIEW_STAGES:
            check_contract = "\n".join(
                f"- `{name}`：{CHECK_DESCRIPTIONS[name]}" for name in self._required_checks(run)
            )
            review_rule = (
                "\n## ReviewArtifactV2 硬约束\n"
                "- 下列检查 ID 是 StageAction 的权威契约；必须全部、仅且按顺序提交，技能材料中的近义 rubric 只能帮助判断，不得替换 ID：\n"
                + check_contract + "\n"
                "- evidence.quote 必须逐字复制当前受审正文/设计原文，禁止概括、复述或写判断句。\n"
                "- checks 与 quality_scorecard 使用 evidence_refs 引用顶层 evidence_id。\n"
                "- quality_scorecard.score 必须是 JSON 整数 1—5；passed=true 要求每项至少 3 分，否则提交 finding 和 revision_brief。\n"
                "- revision_brief 始终存在：passed=true 时为 []；passed=false 时按完整字段填写。\n"
            )
        elif run.current_stage == "canon_update":
            review_rule = (
                "\n## Canon 提取硬约束\n"
                "- 只记录当前最终正文能逐字举证的新事实或状态；evidence 必须逐字引用正文。\n"
                "- 没有变化的 facts、character_states、relationships、open_threads、foreshadowing 必须写 []。\n"
                "- 禁止为了让类别非空而推测、补全或编造 Canon。\n"
                + fact_contract_prompt() + "\n"
            )
        if run.current_stage in {"draft", "review_voice", *REVISION_STAGES}:
            review_rule += (
                "\n## 作者方法逐条落实验收\n"
                "author_realization 必须覆盖全部当前正文作者规则 ID，不得遗漏或重复。realized 必须给出正文逐字 quote、location 和具体实现 reason；"
                "not_used 仅允许未在设计映射的可选方法，必须说明 trigger 不适用原因；suppressed 必须沿用设计核准的 suppressed_by。"
                "写作/返工提交的是自检；review_voice 必须独立重读当前正文确认，不得直接相信或复制自检结论。"
                "若方法没有落实，审查必须 passed=false 并给出 finding 和 revision_brief，不得用总体风格评价替代逐条验收。\n"
            )
        envelope = {
            "schema_version": action.get("schema_version"), "action_id": action.get("action_id"),
            "inputs_hash": action.get("inputs_hash"), "input_hashes": action.get("input_hashes"),
            "note": "以上字段由 Tomota 封装；业务 JSON 禁止自行填写",
        }
        support_receipt = {
            "mode": "tomota_neutral_writing_logic",
            "modules": modules,
            "raw_external_skill_text_injected": False,
            "suppressed_content_authorities": [
                "external_story_skill_prose", "platform_or_market_templates",
                "fixed_structure_or_language_formulas", "generic_skill_corpus_examples",
            ],
            "authority": "logic_support_below_user_canon_foundation_chapter_and_author_contract",
        }
        return (
            "## StageActionV2 交接封装（只读，不得写入业务 payload）\n"
            + json.dumps(envelope, ensure_ascii=False, indent=2)
            + "\n## 权威约束与冻结作者策略\n"
            + (preference_text.strip() if preference_text else "本阶段没有可执行作者策略；只有兼容作者才允许此状态。")
            + "\n## 当前输入（最小上下文）\n"
            + json.dumps(context, ensure_ascii=False, indent=2)
            + "\n## 通用质量辅助隔离回执\n"
            + json.dumps(support_receipt, ensure_ascii=False, indent=2)
            + "\n"
            + pack.render()
            + review_rule
            + "\n## 唯一输出 JSON Schema\n"
            + json.dumps(action["output_schema"], ensure_ascii=False, indent=2)
            + "\n"
        )

    def _legacy_author_preferences(self, book_id: str) -> list[dict[str, Any]]:
        path = self.store.book_dir(book_id) / "canon" / "author-preferences.json"
        if not path.is_file():
            return []
        value = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(value, list):
            return []
        return [
            item for item in value
            if isinstance(item, dict)
            and item.get("enabled") is not False
            and item.get("rule")
        ]

    def _freeze_writing_policy(self, run: WorkflowRun) -> dict[str, Any]:
        legacy = self._legacy_author_preferences(run.book_id)
        if legacy:
            self.authors.import_legacy_overrides(run.book_id, legacy)
        policy = self.authors.compile_policy(run.book_id)
        target = self.store.book_dir(run.book_id) / "workflow" / run.run_id / "writing-policy.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        self.store.write_json(target, policy)
        return policy

    def _writing_policy(self, run: WorkflowRun) -> dict[str, Any]:
        path = self.store.book_dir(run.book_id) / "workflow" / run.run_id / "writing-policy.json"
        if path.is_file():
            value = self._read_json(path)
            if not isinstance(value, dict):
                raise WorkflowError(
                    "冻结写作策略不是 JSON 对象", code="author_contract_invalid",
                    failure_class="contract", field_path="writing-policy.json", retryable=False,
                )
            expected_policy_hash = str(value.get("policy_hash") or "")
            actual_policy_hash = self._canonical_hash({
                key: item for key, item in value.items() if key not in {"compiled_at", "policy_hash"}
            })
            if not expected_policy_hash or expected_policy_hash != actual_policy_hash:
                raise WorkflowError(
                    "冻结写作策略哈希不一致；拒绝使用被篡改、截断或旧格式的作者约束",
                    code="author_contract_invalid", failure_class="lineage",
                    field_path="writing_policy.policy_hash", expected=expected_policy_hash or "valid hash",
                    actual=actual_policy_hash, retryable=False,
                )
            contract = value.get("author_book_contract")
            if not isinstance(contract, dict):
                # Runs frozen before the author-layer migration carry a v1 policy
                # without author_book_contract. Re-freeze on first resume instead
                # of failing so legacy runs remain resumable (idempotent: the
                # rewritten file then flows through the v2 validation above).
                return self._freeze_writing_policy(run)
            expected_contract_hash = str(contract.get("contract_hash") or "")
            actual_contract_hash = self._canonical_hash({key: item for key, item in contract.items() if key != "contract_hash"})
            if not expected_contract_hash or expected_contract_hash != actual_contract_hash:
                raise WorkflowError(
                    "作者—作品契约哈希不一致", code="author_contract_invalid",
                    failure_class="lineage", field_path="author_book_contract.contract_hash",
                    expected=expected_contract_hash or "valid hash", actual=actual_contract_hash, retryable=False,
                )
            return value
        # Runs created before the author-layer migration are frozen on first resume.
        return self._freeze_writing_policy(run)

    def _approved_prior_chapters(self, run: WorkflowRun) -> list[tuple[int, str]]:
        current = int(run.current_chapter or 0)
        accepted = {"approved", "reviewed_pending_approval", "scheduled", "submitted", "published"}
        values: list[tuple[int, str]] = []
        for item in self.store.list_chapters(run.book_id):
            number = int(item.get("chapter_number") or 0)
            if not number or number >= current or str(item.get("status")) not in accepted:
                continue
            content = self.store.read_content(run.book_id, number)
            if content.strip():
                values.append((number, content))
        return sorted(values)

    def _latest_chapter_artifact(self, book_id: str, chapter_number: int, name: str) -> Any:
        workflow_root = self.store.book_dir(book_id) / "workflow"
        if not workflow_root.is_dir():
            return {}
        candidates = [
            path for path in workflow_root.glob(f"*/chapter-{chapter_number:04d}/{name}.json")
            if path.is_file()
        ]
        if not candidates:
            return {}
        return self._read_json(max(candidates, key=lambda path: path.stat().st_mtime_ns))

    def _previous_chapter_handoff(self, run: WorkflowRun) -> dict[str, Any]:
        current = int(run.current_chapter or 0)
        if current <= 1:
            return {
                "schema_version": "chapter-handoff-v1", "previous_chapter": None,
                "rule": "首章没有上一章尾巴；必须直接兑现全书钩子与首章契约，禁止伪造前情。",
            }
        previous_number = current - 1
        previous = self.store.get_chapter(run.book_id, previous_number)
        if not previous:
            return {
                "schema_version": "chapter-handoff-v1", "previous_chapter": previous_number,
                "missing_previous_chapter": True,
                "rule": "章节链存在缺口；不得编造上一章发生过的承接事实，设计中必须公开记录缺口。",
            }
        body = self.store.read_content(run.book_id, previous_number)
        contract = previous.get("contract") if isinstance(previous.get("contract"), dict) else {}
        design = self._latest_chapter_artifact(run.book_id, previous_number, "chapter_design")
        canon_delta = self._latest_chapter_artifact(run.book_id, previous_number, "canon_update")
        planned_ending = design.get("chapter_ending") if isinstance(design, dict) else {}
        return {
            "schema_version": "chapter-handoff-v1",
            "previous_chapter": previous_number,
            "previous_title": contract.get("title") or previous.get("title"),
            "previous_status": previous.get("status"),
            "actual_final_tail": body.rstrip()[-1400:],
            "planned_exit": {
                "contract_change": contract.get("change"),
                "chapter_hook": contract.get("chapter_hook"),
                "next_first_beat": contract.get("next_first_beat"),
                "accepted_design_ending": planned_ending,
            },
            "accepted_canon_delta": {
                key: canon_delta.get(key, []) for key in [
                    "facts", "character_states", "relationships", "open_threads", "foreshadowing",
                ]
            } if isinstance(canon_delta, dict) else {},
            "actual_vs_plan_rule": (
                "先以真实最终尾段和已接受 Canon 为准，再核对原计划；若两者偏离，"
                "必须在 continuity_handoff.actual_vs_plan_check 中说明本章如何吸收偏差。"
            ),
        }

    def _prose_fingerprint(self, run: WorkflowRun, current_text: str | None = None) -> dict[str, Any]:
        prior = self._approved_prior_chapters(run)
        return compare_current_to_corpus(current_text, prior) if current_text is not None else build_corpus_prose_guard(prior)

    def _revision_learning(self, book_id: str) -> list[dict[str, Any]]:
        value = self._read_json(self.store.book_dir(book_id) / "canon" / "author-revision-learning.json")
        return value if isinstance(value, list) else []

    def _record_confirmed_revision_learning(self, run: WorkflowRun, final_text: str) -> None:
        stage_dir = self._stage_dir(run)
        source_path = stage_dir / "rework-source.md"
        request_path = stage_dir / "rework-request.json"
        if not source_path.is_file() or not request_path.is_file():
            return
        source = source_path.read_text(encoding="utf-8")
        request = self._read_json(request_path)
        summary = summarize_confirmed_revision(source, final_text)
        record = {
            "schema_version": "confirmed-revision-pair-v1",
            "chapter_number": int(run.current_chapter),
            "feedback": str(request.get("feedback") or "")[:4000] if isinstance(request, dict) else "",
            "scope_type": request.get("scope_type") if isinstance(request, dict) else "chapter",
            "before_hash": hashlib.sha256(source.encode("utf-8")).hexdigest(),
            "after_hash": hashlib.sha256(final_text.encode("utf-8")).hexdigest(),
            "summary": summary,
            "confirmed_at": utc_now(),
        }
        existing = self._revision_learning(run.book_id)
        existing.append(record)
        self.store.write_json(
            self.store.book_dir(run.book_id) / "canon" / "author-revision-learning.json",
            existing[-20:],
        )

    def _compact_revision_learning(self, book_id: str) -> list[dict[str, Any]]:
        return [
            {
                "chapter_number": item.get("chapter_number"),
                "feedback": item.get("feedback"),
                "summary": item.get("summary"),
            }
            for item in self._revision_learning(book_id)[-5:]
            if isinstance(item, dict)
        ]

    def _stage_context(self, run: WorkflowRun) -> dict[str, Any]:
        stage = run.current_stage
        chapter_scope = int(run.current_chapter) if run.current_chapter is not None and stage != "story_foundation" else None
        foundation_contract = self.store.effective_foundation_contract(run.book_id, chapter_number=chapter_scope)
        if stage == "story_foundation":
            book = self.store.get_book(run.book_id) or {}
            book_dir = self.store.book_dir(run.book_id)
            raw_chapters = self._read_json(book_dir / "outlines" / "chapters.json") or []
            compact_fields = {
                "chapter_number", "volume_id", "title", "objective", "obstacle", "change", "new_information",
                "chapter_hook", "previous_force", "next_first_beat", "current_character_goal", "relationship_state",
                "body_information_state", "unresolved_foreshadowing", "ending_type", "causality_check", "boundary_check",
                "consequence_check",
            }
            selected_window = {
                number + offset for number in run.chapter_numbers for offset in range(-2, 3)
                if number + offset > 0
            }
            if len(raw_chapters) > 80:
                first_numbers = {int(item.get("chapter_number") or 0) for item in raw_chapters[:5] if isinstance(item, dict)}
                last_numbers = {int(item.get("chapter_number") or 0) for item in raw_chapters[-5:] if isinstance(item, dict)}
                included_numbers = selected_window | first_numbers | last_numbers
                scoped_chapters = [item for item in raw_chapters if isinstance(item, dict) and int(item.get("chapter_number") or 0) in included_numbers]
            else:
                scoped_chapters = [item for item in raw_chapters if isinstance(item, dict)]
            chapter_digest = [{key: item[key] for key in compact_fields if key in item} for item in scoped_chapters]
            planning_application = foundation_contract.get("author_application") if isinstance(foundation_contract.get("author_application"), dict) else {}
            return {
                "book": {"title": book.get("title"), "metadata": book.get("metadata")}, "foundation_contract": foundation_contract,
                "master_outline": self.store.load_master_outline(run.book_id),
                "chapter_outline_digest": chapter_digest,
                "chapter_outline_receipt": {
                    "policy": "selected_window_plus_edges_v1" if len(raw_chapters) > 80 else "all_compact_v1",
                    "total": len(raw_chapters), "included": len(chapter_digest), "selected_run_chapters": run.chapter_numbers,
                },
                "existing_story_bible": self._read_json(book_dir / "canon" / "story-bible.json"),
                "existing_quality_foundation": self._read_json(book_dir / "canon" / "quality-foundation.json"),
                "foundation_version": self._read_json(book_dir / "canon" / "foundation-version.json"),
                "canon": self.store.load_canon(run.book_id),
                "planning_author_application": planning_application,
                "planning_author_application_rule": (
                    "这是规划阶段已决策的作者规则落地映射（adopted 转译方式 + deferred 暂缓原因）。"
                    "rule_id 沿用规划时的作者规则编号，可能与当前冻结策略的 style-* 编号不同；"
                    "按 axis/category/instruction 语义对应延续，不得因编号差异重复推倒已决策的转译。"
                ),
                "note": "正式总纲、章纲、既有故事圣经、Canon 与规划契约都是权威输入；本阶段只能版本化补强，不得无证据推翻、遗漏或改名。冲突必须显式记录并按 Canon/硬规则优先级解决",
            }
        if stage == "chapter_design":
            contract = self._contract(run.book_id, int(run.current_chapter)).to_dict()
            master = self.store.load_master_outline(run.book_id)
            volume = next((item for item in master.get("volumes", []) if item.get("volume_id") == contract.get("volume_id")), {})
            canon = self.store.load_canon(run.book_id)
            rework_request = self._read_json(self._stage_dir(run) / "rework-request.json")
            if rework_request and int(run.current_chapter) == min(run.chapter_numbers):
                baseline = self._read_json(self.store.book_dir(run.book_id) / "workflow" / run.run_id / "rework-baseline-canon.json")
                if isinstance(baseline, dict):
                    canon = baseline
            context = {
                "contract": contract, "foundation_contract": foundation_contract,
                "master_outline": master, "volume_outline": volume,
                "story_bible": self._read_json(self.store.book_dir(run.book_id) / "canon" / "story-bible.json"),
                "canon": canon,
                "previous_chapter_handoff": self._previous_chapter_handoff(run),
                "bookwide_prose_guard": self._prose_fingerprint(run),
                "confirmed_author_revision_learning": self._compact_revision_learning(run.book_id),
                "planning_author_application": foundation_contract.get("author_application") if isinstance(foundation_contract.get("author_application"), dict) else {},
                "design_application_rule": (
                    "不要平铺复述全部约束。先编译本章 reader_experience_contract，"
                    "再把实际生效约束映射到具体 scene_ids 和 acceptance_test；被上位规则压制的规则也要显式记录；"
                    "planning_author_application 是规划阶段已决策的作者规则落地映射，按 axis/category 语义延续其转译，不因编号差异重复推倒。"
                ),
            }
            if rework_request:
                context["author_rework_request"] = rework_request
                context["approved_text_to_rework"] = (self._stage_dir(run) / "rework-source.md").read_text(encoding="utf-8")
                context["rework_rule"] = "必须落实作者返工要求，同时保留未被要求改变的有效事实；本轮仍须通过全部质量闸门"
            return context
        if stage == "design_review":
            return {
                "design": self._read_json(self._stage_dir(run) / "chapter_design.json"),
                "contract": self._contract(run.book_id, int(run.current_chapter)).to_dict(),
                "foundation_contract": foundation_contract,
                "previous_chapter_handoff": self._previous_chapter_handoff(run),
            }
        if stage == "draft":
            contract = self._contract(run.book_id, int(run.current_chapter)).to_dict()
            master = self.store.load_master_outline(run.book_id)
            volume = next((item for item in master.get("volumes", []) if item.get("volume_id") == contract.get("volume_id")), {})
            return {
                "design": self._read_json(self._stage_dir(run) / "chapter_design.json"),
                "foundation_contract": foundation_contract, "master_outline": master,
                "volume_outline": volume, "canon": self.store.load_canon(run.book_id),
                "previous_chapter_handoff": self._previous_chapter_handoff(run),
                "bookwide_prose_guard": self._prose_fingerprint(run),
                "confirmed_author_revision_learning": self._compact_revision_learning(run.book_id),
                "execution_order": [
                    "先锁定 reader_experience_contract 的交付与 continuity_handoff 的入口/出口",
                    "逐场执行 constraint_application，而不是在正文中逐条复述约束",
                    "完成后全文检查 bookwide_prose_guard，只改无功能重复，不破坏 Canon 与必要术语",
                ],
            }
        if stage in REVIEW_STAGES or stage in REVISION_STAGES or stage == "canon_update":
            context: dict[str, Any] = {"final_or_current_text": self._current_draft(run), "foundation_contract": foundation_contract}
            if stage == "cold_review":
                canon = self.store.load_canon(run.book_id)
                context["reader_previously_known"] = {key: canon.get(key, []) for key in ["facts", "relationships", "open_threads"]}
            elif stage in REVISION_STAGES:
                latest = run.stage_history[-1] if run.stage_history else {}
                if latest.get("stage") == "canon_update":
                    context["failed_review"] = self._read_json(self._stage_dir(run) / "final_validation.json")
                    context["repair_source"] = "final_validation"
                else:
                    context["failed_review"] = self._read_json(self._stage_dir(run) / f"{REVISION_STAGES[stage]}.json")
                    context["repair_source"] = REVISION_STAGES[stage]
                context["design"] = self._read_json(self._stage_dir(run) / "chapter_design.json")
                context["previous_chapter_handoff"] = self._previous_chapter_handoff(run)
                context["bookwide_prose_fingerprint"] = self._prose_fingerprint(run, context["final_or_current_text"])
                if stage == "revise_voice":
                    deslop_findings = run_deslop_lint(
                        context["final_or_current_text"], skill_root=self.skill.root,
                    )
                    context["deslop_scan"] = {
                        "rule_set": "tomota-deterministic-deslop-v1",
                        "authority": "diagnostic_only_below_user_canon_and_frozen_author_contract",
                        "blocking_count": sum(item.severity == "blocking" for item in deslop_findings),
                        "warning_count": sum(item.severity in {"warning", "advisory"} for item in deslop_findings),
                        "findings": [item.to_dict() for item in deslop_findings],
                        "review_rule": "修订必须消除 blocking 去 AI 味项，之后仍须重新通过 review_voice。",
                    }
            else:
                context["design"] = self._read_json(self._stage_dir(run) / "chapter_design.json")
                if stage in {"review_voice", "review_continuity"}:
                    context["previous_chapter_handoff"] = self._previous_chapter_handoff(run)
                if stage == "review_voice":
                    context["bookwide_prose_fingerprint"] = self._prose_fingerprint(run, context["final_or_current_text"])
                    deslop_findings = run_deslop_lint(
                        context["final_or_current_text"], skill_root=self.skill.root,
                    )
                    context["deslop_scan"] = {
                        "rule_set": "tomota-deterministic-deslop-v1",
                        "authority": "diagnostic_only_below_user_canon_and_frozen_author_contract",
                        "blocking_count": sum(item.severity == "blocking" for item in deslop_findings),
                        "warning_count": sum(item.severity in {"warning", "advisory"} for item in deslop_findings),
                        "findings": [item.to_dict() for item in deslop_findings],
                        "review_rule": (
                            "blocking 项必须形成 review_voice finding 并进入 revise_voice；"
                            "warning/advisory 需结合人物、Canon 与作者契约判断，不得机械改写。"
                        ),
                    }
                    statistical_targets: list[Any] = []
                    policy = self._writing_policy(run)
                    if isinstance(policy, dict):
                        policy_contract = policy.get("author_book_contract") if isinstance(policy.get("author_book_contract"), dict) else {}
                        statistical_targets = policy_contract.get("statistical_targets") if isinstance(policy_contract.get("statistical_targets"), list) else []
                    if statistical_targets:
                        context["statistical_style_check"] = evaluate_statistical_targets(
                            context["final_or_current_text"], statistical_targets,
                        )
            return context
        if stage == "arc_review":
            workflow_dir = self.store.book_dir(run.book_id) / "workflow" / run.run_id
            arc_lineage = self._read_json(workflow_dir / "automatic-arc-repair.json")
            numbers = (
                [int(item) for item in arc_lineage.get("review_chapters", [])]
                if isinstance(arc_lineage, dict) and not arc_lineage.get("resolved") and arc_lineage.get("review_chapters")
                else run.completed_chapters[-3:]
            )
            chapters = []
            for number in numbers:
                chapters.append({
                    "chapter_number": number,
                    "contract": self._contract(run.book_id, number).to_dict(),
                    "body": self.store.read_content(run.book_id, number),
                    "canon_delta": self._read_json(
                        self._stage_dir_for_chapter(run, number) / "canon_update.json"
                    ),
                })
            return {
                "completed_chapters": numbers,
                "chapters": chapters,
                "quality_foundation": self._read_json(self.store.book_dir(run.book_id) / "canon" / "quality-foundation.json"),
                "canon": self.store.load_canon(run.book_id),
                "traceability": self._read_json(workflow_dir / "traceability.json"),
                "review_rule": "必须完整阅读本批三章正文；失败时给出受影响章节、保留项、修改项与下一批可执行调整",
            }
        return {"completed_chapters": run.completed_chapters}

    def _action_summary(self, run: WorkflowRun) -> dict[str, Any]:
        stage = run.current_stage
        tasks = {
            "story_foundation": "重建故事圣经、人物档案、知识边界与伏笔账本",
            "chapter_design": f"为第 {run.current_chapter} 章生成逐场场景卡",
            "design_review": "审查逻辑、人物知识与伏笔设计；不通过不得写正文",
            "draft": f"按已通过的场景卡撰写第 {run.current_chapter} 章正文",
            "review_logic": "冷读剧情逻辑、时间线、计数、名词、动机与后果",
            "review_voice": "审查人物一致性、知识越界、对白功能与密度、换声、情绪落地与去 AI 味",
            "review_continuity": "审查伏笔、Canon、节奏曲线、转场、章末拉力与下一章承接",
            "cold_review": "只依据正文和读者已知事实回答六问：谁、做什么、为什么、指什么、局面变化、为何继续",
            "canon_update": "仅从最终正文提取 Canon 与伏笔变化并附原文证据",
            "arc_review": "每三章复查故事引擎、节奏、人物变化、伏笔密度与套路重复",
        }
        if stage in REVISION_STAGES:
            latest = run.stage_history[-1] if run.stage_history else {}
            tasks[stage] = (
                "针对最终确定性校验的明确失败生成完整修订稿；必须实际修复字数、重复或结尾问题"
                if latest.get("stage") == "canon_update"
                else f"仅针对 {REVISION_STAGES[stage]} 的开放问题生成完整修订稿"
            )
        schema: dict[str, Any]
        if stage in REVIEW_STAGES:
            schema = {
                "schema_version": "review-artifact-v2",
                "stage": stage,
                "gate": stage,
                "passed": False,
                "summary": "公开审查结论；只写可核验判断，不写隐藏思维",
                "evidence": [{"evidence_id": "E1", "location": "第1段/字段路径", "quote": "逐字复制当前受审原文"}],
                "checks": [{"name": name, "passed": False, "evidence_refs": ["E1"]} for name in self._required_checks(run, stage)],
                "findings": [{"finding_id": "id", "severity": "blocker|warning", "category": "分类", "location": "段落/行", "quote": "原文", "diagnosis": "诊断", "violated_rule": "违反规则", "repair_requirement": "修复要求", "status": "open"}],
            }
            schema["quality_scorecard"] = {name: {"score": 3, "evidence_refs": ["E1"]} for name in QUALITY_SCORE_FIELDS}
            schema["revision_brief"] = [{name: "失败时填写；通过时整个数组必须为空" for name in REVISION_BRIEF_FIELDS}]
            if stage == "cold_review":
                schema["reader_answers"] = {name: "" for name in REQUIRED_CHECKS["cold_review"]}
        elif stage == "draft" or stage in REVISION_STAGES:
            schema = {"stage": stage, "content": "完整正文"}
            if stage in REVISION_STAGES:
                schema["replacements"] = [{"before": "当前稿中唯一原文", "after": "修订后原文"}]
        elif stage == "story_foundation":
            schema = {
                "stage": stage,
                "world_rules": ["可执行且无冲突的世界规则"],
                "terminology": {"统一术语": "唯一定义"},
                "timeline": ["带时间锚点的事件"],
                "characters": [{
                    "name": "人物全称", "goal": "当前与长期目标", "fear": "核心恐惧",
                    "boundary": "不会跨越的底线", "behavior_pattern": "可观察的行为模式",
                    "speech_rhythm": "句长、称呼与停顿习惯", "avoidance": "回避信息或冲突的方式",
                    "pressure_method": "向他人施压的惯用方式",
                }],
                "market_position": "题材定位与目标读者",
                "reader_promise": "这本书持续卖给读者的核心体验",
                "hook": "一句话钩子",
                "story_engine": "能推动10—20章且持续产生新阻碍的循环冲突引擎",
                "differentiation": "与同题材常见套路的差异点，不能只写泛题材",
                "trope_risks": ["容易套路化、AI化或空泛的风险"],
                "volume_objectives": [{"volume_id": "volume-1", "objective": "本卷目标", "change": "人物或局面变化", "payoff": "兑现点", "next_volume_entry": "下一卷入口"}],
                "relationship_matrix": [{"characters": ["人物A", "人物B"], "relation": "关系及张力"}],
                "knowledge_boundaries": [{"character": "人物全称", "knows": ["已知事实"], "does_not_know": ["未知事实"]}],
                "foreshadowing": [{"id": "FB-01", "reader_knows": "读者已知", "hidden": "隐藏事实", "advance_or_payoff": "推进或兑现节点"}],
                "constraint_application": [{
                    "constraint_id": "基础契约或冻结作者策略中的真实稳定 ID",
                    "source": "hard_rule|canon|foundation|book_override|author_profile|distilled_dimension|author_blueprint",
                    "target_fields": ["story_engine", "characters"],
                    "execution": "如何改变本书的因果、人物、关系、揭示或结构；不得只复述规则",
                    "acceptance_test": "后续设计和审查可核验的具体条件",
                    "conflict_status": "active|suppressed_by_higher_rule",
                    "suppressed_by": "当 conflict_status=suppressed_by_higher_rule 时填写压制本条规则的上位规则真实 ID；active 时留空字符串",
                    "conflict_reason": "当 conflict_status=suppressed_by_higher_rule 时填写冲突字段与压制依据；active 时留空字符串",
                    "conflict_dimensions": [{"dimension": "冲突维度（如世界观机制/人物知识边界/节奏）", "suppressed_evidence": "被压制规则在本方案中的证据路径", "suppressor_evidence": "压制规则在本方案中的证据路径"}],
                }],
            }
        elif stage == "chapter_design":
            schema = {
                "stage": stage,
                "scenes": [{
                    "scene_id": "S1", "setting": "地点与时段", "objective": "本场目标",
                    "obstacle": "阻碍", "motivation": "人物为何此刻行动", "trigger": "触发事件",
                    "choice": "关键选择", "consequence": "可见后果", "next_scene_entry": "下一场入口",
                    "reader_question": "这一场让读者关心的问题", "value_change": "局面价值变化，例如安全→危险",
                    "pressure_level": "压力强度与递进方式", "information_delta": "新增、误导或兑现的信息",
                    "emotion_shift": "情绪从什么变成什么", "scene_function": "删改、推进、揭示、施压或承接中的具体功能",
                    "cut_or_merge_reason": "低价值场景为何保留；默认删并",
                }],
                "chapter_questions": {"protagonist_want": "主角想做什么", "who_or_what_blocks": "谁或什么阻止", "situation_change": "局面变成什么", "why_continue": "读者为什么继续"},
                "chapter_ending": {"ending_change": "章末收在哪个局面变化上", "hook_type": "危机|反证|选择|揭示|代价|关系变化", "next_first_beat": "下一章第一拍"},
                "dialogue_pressure_plan": [{"speaker": "人物", "goal": "对白目标", "target": "施压对象", "withheld": "不能说出的信息", "voice_rule": "语言特征", "pressure_function": "改变关系|暴露信息|施压|推动决定", "dialogue_budget": "超过两三轮的问答如何交给动作或物件"}],
                "character_knowledge": {"人物全称": {"knows": ["本章前已知"], "cannot_know": ["本章前未知"]}},
                "foreshadow_actions": [{"id": "FB-01", "action": "铺设、推进或兑现", "reader_effect": "读者获得的信息", "reader_knows": "读者已知什么", "hidden": "隐藏什么", "advance_or_payoff": "何时推进或兑现"}],
                "core_reveal_closeup": "核心揭示必须落到具体动作、物件或可见证据",
                "reader_experience_contract": {
                    "inherited_obligation": "从上一章真实结尾继承、必须立即承接的读者期待或后果",
                    "chapter_reward": "本章必须实际交付给读者的进展、情绪或关系回报",
                    "emotional_curve": "本章情绪压力的起点、递进、释放或转化",
                    "information_contract": "必须新增、澄清、误导或兑现的信息以及边界",
                    "non_negotiable_change": "删掉就等于本章没有发生的核心局面变化",
                    "exit_obligation": "章末向下一章留下的具体未完成行动、选择、反证或代价",
                    "acceptance_tests": ["可在正文中逐字或逐场核验的通过条件"],
                },
                "continuity_handoff": {
                    "entry_state": "本章开场时人物、地点、时间、物件与关系状态",
                    "entry_trigger": "上一章真实末尾如何直接触发本章第一拍",
                    "retained_consequences": ["不能在转场中消失的伤势、承诺、风险、物件或知识变化"],
                    "exit_state": "本章结束后可传给下一章的实际状态",
                    "next_chapter_first_beat": "下一章能够直接执行的第一拍",
                    "actual_vs_plan_check": "上一章真实落点与原计划若有偏差，本章如何吸收而不是假装未发生",
                },
                "constraint_application": [{
                    "constraint_id": "作者规则、基础契约、Canon 或章节契约中的稳定 ID/字段路径",
                    "source": "hard_rule|canon|foundation|chapter_contract|book_override|author_profile|distilled_dimension|author_blueprint",
                    "scene_ids": ["S1"], "execution": "在这些场景中如何执行，不得只复述规则",
                    "acceptance_test": "审查时可依据何种正文现象判定落实",
                    "conflict_status": "active|suppressed_by_higher_rule",
                    "suppressed_by": "当 conflict_status=suppressed_by_higher_rule 时填写压制本条规则的上位规则真实 ID；active 时留空字符串",
                    "conflict_reason": "当 conflict_status=suppressed_by_higher_rule 时填写冲突字段与压制依据；active 时留空字符串",
                    "conflict_dimensions": [{"dimension": "冲突维度（如世界观机制/人物知识边界/节奏）", "suppressed_evidence": "被压制规则在本方案中的证据路径", "suppressor_evidence": "压制规则在本方案中的证据路径"}],
                }],
            }
        elif stage == "canon_update":
            schema = {"stage": stage, "facts": [], "character_states": [], "relationships": [], "open_threads": [], "foreshadowing": [], "state_facts": [], "evidence": ["最终正文原文"]}
        elif stage == "arc_review":
            schema = {
                "stage": stage, "passed": True,
                "story_engine": "三章是否持续兑现核心故事引擎",
                "pacing": "信息、压力与缓冲的三章曲线",
                "character_change": "人物状态、选择与关系变化",
                "foreshadow_density": "伏笔铺设、推进、兑现与积压",
                "pattern_repetition": "场景、对白、转场、钩子和解决方式的重复",
                "conflict_escalation": "冲突是否升级并产生新代价",
                "mainline_progress": "读者承诺与本卷主线推进证据",
                "foreshadow_backlog": ["尚未推进、即将过期或互相冲突的伏笔"],
                "ending_hook_repetition": ["重复的章末机制及涉及章节"],
                "low_change_scenes": ["局面变化不足的场景及涉及章节"],
                "reader_promise_fulfillment": "核心体验兑现与偏离情况",
                "next_batch_adjustments": ["下一批章节可直接执行的调整"],
                "affected_chapters": [1],
                "preserve": ["返工时必须保留的有效事实、因果与人物状态"],
                "changes": ["需要从章节设计开始修复的结构问题"],
                "risks": ["返工可能造成的连续性、Canon 或发布风险"],
                "evidence": ["三章正文中的逐字短引文"],
            }
        else:
            schema = {"stage": stage}
        if stage in {"draft", "review_voice", *REVISION_STAGES} and self._prose_author_rules(run):
            schema["author_realization"] = [{
                "rule_id": "当前正文策略中的真实 rule_id",
                "status": "realized|not_used|suppressed",
                "quote": "realized 时逐字引用本次正文；其他状态可为空",
                "location": "realized 时填写正文位置；其他状态可为空",
                "reason": "具体落实方式或未采用/压制原因",
                "suppressed_by": "仅 suppressed 时填写设计中核准的上位规则 ID，其他状态为空",
            }]
        result = {
            "run_id": run.run_id, "status": run.status, "book_id": run.book_id,
            "chapter": run.current_chapter, "stage": stage, "revision_round": run.revision_round,
            "max_revisions": run.max_revisions, "task": tasks.get(stage, stage),
            "output_schema": self._output_json_schema(run, stage, schema),
        }
        if stage == "story_foundation" and self._is_system_compatibility_run(run):
            # Keep the one-time legacy migration path explicit in the issued
            # action. The field remains documented, but is not required for a
            # system-bound book with no user contract to map yet.
            required = result["output_schema"].get("required")
            if isinstance(required, list) and "constraint_application" in required:
                result["output_schema"]["required"] = [item for item in required if item != "constraint_application"]
        dual_candidate = stage == "story_foundation"
        if stage == "chapter_design" and run.current_chapter is not None:
            contract = self._contract(run.book_id, int(run.current_chapter))
            markers = " ".join([contract.ending_type, *contract.problem_tags])
            dual_candidate = int(run.current_chapter) <= 3 or any(
                marker in markers for marker in ("重大转折", "揭示", "高潮", "卷末", "反转")
            )
        if dual_candidate:
            result["candidate_mode"] = "dual_blind"
            result["candidate_policy"] = {
                "producer_count": 2, "reviewer_context": "artifacts_only",
                "auto_select_min_gap": 0, "pause_on_close_or_blocked": False,
                "close_score_resolution": "higher_score_then_reviewer_tiebreak",
                "blocked_resolution": "automatic_repair_candidate",
            }
        return result

    def _advance(self, run: WorkflowRun, next_stage: str, message: str) -> None:
        run.stage_history.append({"stage": run.current_stage, "result": message, "at": utc_now()})
        run.current_stage = next_stage

    def _write_artifact(self, run: WorkflowRun, stage: str, value: dict[str, Any]) -> Path:
        path = self._stage_dir(run) / f"{stage}.json"
        self.store.write_json(path, value)
        return path

    def _stage_dir(self, run: WorkflowRun) -> Path:
        if run.current_chapter is None:
            return self.store.book_dir(run.book_id) / "workflow" / run.run_id
        return self.store.book_dir(run.book_id) / "workflow" / run.run_id / f"chapter-{run.current_chapter:04d}"

    def _current_draft(self, run: WorkflowRun) -> str:
        directory = self._stage_dir(run) / "drafts"
        drafts = sorted(directory.glob("draft-v*.md")) if directory.is_dir() else []
        if not drafts:
            raise WorkflowError("当前章节还没有工作稿")
        return drafts[-1].read_text(encoding="utf-8")

    def _draft_versions(self, run: WorkflowRun) -> int:
        directory = self._stage_dir(run) / "drafts"
        values = [int(path.stem.split("v")[-1]) for path in directory.glob("draft-v*.md")] if directory.is_dir() else []
        return max(values, default=0)

    def _retain_two_working_drafts(self, run: WorkflowRun) -> None:
        directory = self._stage_dir(run) / "drafts"
        drafts = sorted(directory.glob("draft-v*.md"))
        for path in drafts[:-2]:
            trash = self.store.book_dir(run.book_id) / ".trash" / run.run_id / f"chapter-{run.current_chapter:04d}" / path.name
            trash.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(path), str(trash))

    def _compact_approved_chapter(self, run: WorkflowRun) -> None:
        stage_dir = self._stage_dir(run)
        trash = self.store.book_dir(run.book_id) / ".trash" / run.run_id / "approved" / f"chapter-{run.current_chapter:04d}"
        disposable = [*stage_dir.glob("*.prompt.md")]
        draft_dir = stage_dir / "drafts"
        if draft_dir.is_dir():
            disposable.extend(draft_dir.glob("draft-v*.md"))
        for path in disposable:
            destination = trash / path.relative_to(stage_dir)
            destination.parent.mkdir(parents=True, exist_ok=True)
            if destination.exists():
                destination = destination.with_name(destination.name + ".archived")
            shutil.move(str(path), str(destination))

    def _contract(self, book_id: str, chapter_number: int) -> ChapterContract:
        path = self.store.book_dir(book_id) / "outlines" / "chapters.json"
        if path.is_file():
            for item in json.loads(path.read_text(encoding="utf-8")):
                if int(item.get("chapter_number", 0)) == chapter_number:
                    return ChapterContract(book_id=book_id, **item)
        stored = self.store.get_chapter(book_id, chapter_number)
        if stored:
            return ChapterContract(**stored["contract"])
        raise WorkflowError(f"章纲中没有第 {chapter_number} 章")

    def _run(self, run_id: str) -> WorkflowRun:
        run = self.store.load_workflow_run(run_id)
        if not run:
            raise WorkflowError(f"workflow does not exist: {run_id}")
        return run

    @staticmethod
    def _require_nonempty(value: dict[str, Any], fields: list[str], label: str) -> None:
        if not isinstance(value, dict):
            raise WorkflowError(
                f"{label} 必须是对象", code="artifact_schema_invalid", failure_class="contract",
                field_path=label, expected="object", actual=type(value).__name__, retryable=True,
            )
        missing = [field for field in fields if field not in value or value[field] is None or value[field] == "" or value[field] == [] or value[field] == {}]
        if missing:
            raise WorkflowError(
                f"{label} 缺少非空字段：{', '.join(missing)}",
                code="artifact_schema_invalid", failure_class="contract", field_path=label,
                expected=fields, actual=sorted(value), retryable=True,
            )

    @staticmethod
    def _read_json(path: Path) -> Any:
        if not path.is_file():
            return {}
        return json.loads(path.read_text(encoding="utf-8"))
