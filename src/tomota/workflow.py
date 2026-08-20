from __future__ import annotations

import hashlib
import json
import shutil
import uuid
from pathlib import Path
from typing import Any

from .models import ChapterContract, ReviewFinding, ReviewGate, WorkflowRun, utc_now
from .review import ChapterReviewer, STRICT_GATES
from .router import SkillRouter
from .skill_adapter import SkillAdapter
from .store import ProjectStore


REVIEW_STAGES = {"design_review", "review_logic", "review_voice", "review_continuity", "cold_review"}
REQUIRED_CHECKS = {
    "design_review": {"outline_contract", "canon_consistency", "knowledge_boundaries", "foreshadow_object_clarity"},
    "review_logic": {"text_design_alignment", "timeline", "counts_and_terms", "motivation", "consequence"},
    "review_voice": {"character_consistency", "knowledge_boundaries", "dialogue_function", "voice_swap", "anti_ai"},
    "review_continuity": {"foreshadow_object", "canon_consistency", "transitions", "ending", "next_chapter"},
    "cold_review": {"who", "does_what", "why", "referents"},
}
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
    pass


class WorkflowEngine:
    """Persistent, fail-closed state machine driven by Codex task turns."""

    def __init__(self, project_root: Path | str, *, skill_root: Path | str | None = None):
        self.root = Path(project_root).resolve()
        self.store = ProjectStore(self.root)
        self.skill = SkillAdapter(self.root, skill_root)
        self.reviewer = ChapterReviewer(self.skill, SkillRouter())

    def start(self, book_id: str, chapter_numbers: list[int], *, max_revisions: int = 5) -> WorkflowRun:
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
        run = WorkflowRun(
            run_id=f"workflow-{uuid.uuid4().hex[:12]}", book_id=book_id, chapter_numbers=numbers,
            status="running", current_chapter=numbers[0], current_stage="story_foundation",
            max_revisions=max_revisions,
        )
        self.store.save_workflow_run(run)
        self.store.append_event(book_id, None, "workflow_started", {"run_id": run.run_id, "chapters": numbers, "max_revisions": max_revisions})
        self.next_action(run.run_id)
        return run

    def status(self, run_id: str) -> dict[str, Any]:
        run = self._run(run_id)
        return {
            **run.to_dict(),
            "next": None if run.status != "running" else self._action_summary(run),
            "progress": {"approved": len(run.completed_chapters), "total": len(run.chapter_numbers)},
        }

    def next_action(self, run_id: str) -> dict[str, Any]:
        run = self._run(run_id)
        if run.status != "running":
            return {"run_id": run_id, "status": run.status, "stage": run.current_stage, "message": "工作流当前不可领取新任务"}
        action = self._action_summary(run)
        prompt = self._render_stage_prompt(run, action)
        stage_dir = self._stage_dir(run)
        stage_dir.mkdir(parents=True, exist_ok=True)
        prompt_path = stage_dir / f"{run.current_stage}.prompt.md"
        prompt_path.write_text(prompt, encoding="utf-8")
        action["prompt_path"] = str(prompt_path)
        action["prompt_bytes"] = prompt_path.stat().st_size
        return action

    def submit(self, run_id: str, artifact: dict[str, Any]) -> dict[str, Any]:
        run = self._run(run_id)
        if run.status != "running":
            raise WorkflowError(f"workflow is not running: {run.status}")
        if artifact.get("stage") != run.current_stage:
            raise WorkflowError(f"提交阶段不匹配：需要 {run.current_stage}，收到 {artifact.get('stage')}")
        stage = run.current_stage
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
            self._submit_arc_review(run, artifact)
        else:
            raise WorkflowError(f"未知工作流阶段：{stage}")
        self.store.save_workflow_run(run)
        return self.status(run_id)

    def submit_file(self, run_id: str, path: Path | str) -> dict[str, Any]:
        source = Path(path).resolve()
        if not source.is_file():
            raise WorkflowError(f"artifact does not exist: {source}")
        try:
            value = json.loads(source.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise WorkflowError(f"artifact 必须是 UTF-8 JSON：{exc}") from exc
        if not isinstance(value, dict):
            raise WorkflowError("artifact 顶层必须是对象")
        return self.submit(run_id, value)

    def _submit_foundation(self, run: WorkflowRun, value: dict[str, Any]) -> None:
        required = ["world_rules", "terminology", "timeline", "characters", "relationship_matrix", "knowledge_boundaries", "foreshadowing"]
        self._require_nonempty(value, required, "故事圣经")
        for character in value["characters"]:
            self._require_nonempty(character, ["name", "goal", "fear", "boundary", "behavior_pattern", "speech_rhythm", "avoidance", "pressure_method"], "人物档案")
        canon_dir = self.store.book_dir(run.book_id) / "canon"
        self.store.write_json(canon_dir / "story-bible.json", {key: value[key] for key in required})
        self._write_artifact(run, "story_foundation", value)

    def _submit_design(self, run: WorkflowRun, value: dict[str, Any]) -> None:
        self._require_nonempty(value, ["scenes", "dialogue_pressure_plan", "character_knowledge", "foreshadow_actions", "core_reveal_closeup"], "章节设计")
        scene_fields = ["scene_id", "setting", "objective", "obstacle", "motivation", "trigger", "choice", "consequence", "next_scene_entry"]
        for scene in value["scenes"]:
            self._require_nonempty(scene, scene_fields, "场景卡")
        self._write_artifact(run, "chapter_design", value)

    def _submit_review(self, run: WorkflowRun, value: dict[str, Any]) -> None:
        gate = self._gate_from_value(run.current_stage, value)
        if gate.passed:
            self._validate_required_checks(run.current_stage, value.get("checks"))
        if run.current_stage != "design_review":
            content = self._current_draft(run)
            lint_findings = self.reviewer.lint(content, gate=run.current_stage)
            if lint_findings:
                gate.passed = False
                gate.findings.extend(lint_findings)
        if run.current_stage == "cold_review":
            answers = value.get("reader_answers")
            self._require_nonempty(answers or {}, ["who", "does_what", "why", "referents"], "无提示冷审读者回答")
        self._write_artifact(run, run.current_stage, gate.to_dict())
        if gate.passed and not gate.findings:
            following = {
                "design_review": "draft", "review_logic": "review_voice", "review_voice": "review_continuity",
                "review_continuity": "cold_review", "cold_review": "canon_update",
            }[run.current_stage]
            self._advance(run, following, f"{gate.gate} 通过，证据 {len(gate.evidence)} 条")
            return
        if not gate.findings:
            raise WorkflowError("未通过的审查门必须至少包含一条完整 finding")
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

    def _submit_draft(self, run: WorkflowRun, value: dict[str, Any]) -> None:
        content = str(value.get("content", "")).strip()
        if not content and run.current_stage in REVISION_STAGES and isinstance(value.get("replacements"), list):
            content = self._current_draft(run).strip()
            for item in value["replacements"]:
                before = str(item.get("before", ""))
                after = str(item.get("after", ""))
                if not before or content.count(before) != 1:
                    raise WorkflowError(f"定点修订的 before 必须在当前稿中恰好出现一次：{before[:80]}")
                content = content.replace(before, after, 1)
        if not content:
            raise WorkflowError("正文/修订稿 content 为空")
        if run.current_stage in REVISION_STAGES and content == self._current_draft(run).strip():
            raise WorkflowError("修订稿与上一稿完全相同")
        version = self._draft_versions(run) + 1
        path = self._stage_dir(run) / "drafts" / f"draft-v{version:02d}.md"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content + "\n", encoding="utf-8")
        self._retain_two_working_drafts(run)
        following = "review_logic" if run.current_stage == "draft" else REVISION_STAGES[run.current_stage]
        self._advance(run, following, f"工作稿 v{version:02d} 已保存")

    def _submit_canon(self, run: WorkflowRun, value: dict[str, Any]) -> None:
        self._require_nonempty(value, ["facts", "character_states", "relationships", "open_threads", "foreshadowing", "evidence"], "Canon 更新")
        content = self._current_draft(run)
        evidence = [str(item).strip() for item in value["evidence"]]
        if not all(item in content for item in evidence):
            raise WorkflowError("Canon evidence 必须逐条原样出现在最终正文中")
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
        self.store.save_chapter(contract, status="reviewed_pending_approval", content=content)
        self.store.save_review(report)
        prior = self.store.load_canon(run.book_id)
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
        snapshot["evidence"] = evidence
        snapshot["evidence_history"] = [
            *prior.get("evidence_history", ([{"chapter": prior.get("chapter_number"), "quotes": prior.get("evidence", [])}] if prior.get("chapter_number") else [])),
            {"chapter": int(run.current_chapter), "quotes": evidence},
        ]
        snapshot["content_fingerprint"] = hashlib.sha256(content.encode("utf-8")).hexdigest()
        self.store.save_canon(run.book_id, int(run.current_chapter), snapshot)
        self._write_artifact(run, "canon_update", snapshot)
        self._compact_approved_chapter(run)
        run.completed_chapters.append(int(run.current_chapter))
        self._finish_or_next(run)

    def _submit_arc_review(self, run: WorkflowRun, value: dict[str, Any]) -> None:
        self._require_nonempty(value, ["story_engine", "pacing", "character_change", "foreshadow_density", "pattern_repetition", "evidence", "passed"], "三章阶段审查")
        if not value["passed"]:
            run.status = "blocked"
            run.stage_history.append({"stage": "arc_review", "result": "blocked", "at": utc_now()})
            return
        self._write_artifact(run, "arc_review", value)
        remaining = [item for item in run.chapter_numbers if item not in run.completed_chapters]
        if remaining:
            run.current_chapter = remaining[0]
            run.revision_round = 0
            self._advance(run, "chapter_design", "三章阶段审查通过")
        else:
            run.status = "completed"
            run.current_stage = "completed"

    def _finish_or_next(self, run: WorkflowRun) -> None:
        remaining = [item for item in run.chapter_numbers if item not in run.completed_chapters]
        if len(run.completed_chapters) % 3 == 0:
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
            raise WorkflowError(f"review gate 必须是 {stage}")
        evidence = value.get("evidence")
        if not isinstance(evidence, list) or not evidence or not all(str(item).strip() for item in evidence):
            raise WorkflowError("每个审查门都必须提供非空 evidence")
        findings: list[ReviewFinding] = []
        for raw in value.get("findings", []):
            required = ["finding_id", "severity", "category", "location", "quote", "violated_rule", "repair_requirement"]
            self._require_nonempty(raw, required, "ReviewFinding")
            findings.append(ReviewFinding(gate=stage, diagnosis=str(raw.get("diagnosis", "")), status=str(raw.get("status", "open")), **{key: raw[key] for key in required}))
        passed = bool(value.get("passed"))
        if passed and any(item.status == "open" for item in findings):
            raise WorkflowError("passed=true 时不能保留 open finding")
        return ReviewGate(
            gate=stage, passed=passed, evidence=[str(item) for item in evidence], findings=findings,
            summary=str(value.get("summary", "")), checks=list(value.get("checks") or []),
        )

    def _validate_required_checks(self, stage: str, checks: Any) -> None:
        if not isinstance(checks, list):
            raise WorkflowError(f"{stage} 通过前必须提交结构化 checks")
        by_name = {item.get("name"): item for item in checks if isinstance(item, dict)}
        missing = REQUIRED_CHECKS[stage] - set(by_name)
        if missing:
            raise WorkflowError(f"{stage} 缺少检查项：{', '.join(sorted(missing))}")
        for name in REQUIRED_CHECKS[stage]:
            item = by_name[name]
            if item.get("passed") is not True or not str(item.get("evidence", "")).strip():
                raise WorkflowError(f"{stage} 检查项未通过或证据为空：{name}")

    def _load_gate(self, run: WorkflowRun, stage: str) -> ReviewGate:
        path = self._stage_dir(run) / f"{stage}.json"
        if not path.is_file():
            raise WorkflowError(f"缺少审查产物：{stage}")
        value = json.loads(path.read_text(encoding="utf-8"))
        return self._gate_from_value(stage, value)

    def _render_stage_prompt(self, run: WorkflowRun, action: dict[str, Any]) -> str:
        modules = MODULE_BY_STAGE.get(run.current_stage, ["consistency_review"])
        if run.current_stage in REVISION_STAGES:
            modules = MODULE_BY_STAGE[REVISION_STAGES[run.current_stage]]
        pack = self.skill.build_prompt_pack(task=action["task"], stage=run.current_stage, module_chain=modules, compact=True)
        context = self._stage_context(run)
        return pack.render() + "\n## 当前输入（最小上下文）\n" + json.dumps(context, ensure_ascii=False, indent=2) + "\n\n## 输出约束\n" + json.dumps(action["output_schema"], ensure_ascii=False, indent=2) + "\n"

    def _stage_context(self, run: WorkflowRun) -> dict[str, Any]:
        stage = run.current_stage
        if stage == "story_foundation":
            book = self.store.get_book(run.book_id) or {}
            return {"book": {"title": book.get("title"), "metadata": book.get("metadata")}, "existing_outline": str(self.store.book_dir(run.book_id) / "outlines" / "chapters.json"), "note": "旧章纲仅作素材，冲突必须显式解决"}
        if stage == "chapter_design":
            contract = self._contract(run.book_id, int(run.current_chapter)).to_dict()
            master = self.store.load_master_outline(run.book_id)
            volume = next((item for item in master.get("volumes", []) if item.get("volume_id") == contract.get("volume_id")), {})
            return {"contract": contract, "master_outline": master, "volume_outline": volume, "story_bible": self._read_json(self.store.book_dir(run.book_id) / "canon" / "story-bible.json"), "canon": self.store.load_canon(run.book_id)}
        if stage == "design_review":
            return {"design": self._read_json(self._stage_dir(run) / "chapter_design.json"), "contract": self._contract(run.book_id, int(run.current_chapter)).to_dict()}
        if stage == "draft":
            contract = self._contract(run.book_id, int(run.current_chapter)).to_dict()
            master = self.store.load_master_outline(run.book_id)
            volume = next((item for item in master.get("volumes", []) if item.get("volume_id") == contract.get("volume_id")), {})
            return {"design": self._read_json(self._stage_dir(run) / "chapter_design.json"), "master_outline": master, "volume_outline": volume, "canon": self.store.load_canon(run.book_id)}
        if stage in REVIEW_STAGES or stage in REVISION_STAGES or stage == "canon_update":
            context: dict[str, Any] = {"final_or_current_text": self._current_draft(run)}
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
            else:
                context["design"] = self._read_json(self._stage_dir(run) / "chapter_design.json")
            return context
        return {"completed_chapters": run.completed_chapters}

    def _action_summary(self, run: WorkflowRun) -> dict[str, Any]:
        stage = run.current_stage
        tasks = {
            "story_foundation": "重建故事圣经、人物档案、知识边界与伏笔账本",
            "chapter_design": f"为第 {run.current_chapter} 章生成逐场场景卡",
            "design_review": "审查逻辑、人物知识与伏笔设计；不通过不得写正文",
            "draft": f"按已通过的场景卡撰写第 {run.current_chapter} 章正文",
            "review_logic": "冷读剧情逻辑、时间线、计数、名词、动机与后果",
            "review_voice": "审查人物一致性、知识越界、对白功能、换声与去 AI 味",
            "review_continuity": "审查伏笔、Canon、转场、章末与下一章承接",
            "cold_review": "只依据正文和读者已知事实回答谁、做什么、为什么、指什么",
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
            schema = {"stage": stage, "gate": stage, "passed": False, "evidence": ["非空审查证据"], "checks": [{"name": name, "passed": False, "evidence": "具体证据"} for name in sorted(REQUIRED_CHECKS[stage])], "findings": [{"finding_id": "id", "severity": "blocker|warning", "category": "分类", "location": "段落/行", "quote": "原文", "diagnosis": "诊断", "violated_rule": "违反规则", "repair_requirement": "修复要求", "status": "open"}]}
            if stage == "cold_review":
                schema["reader_answers"] = {"who": "", "does_what": "", "why": "", "referents": ""}
        elif stage == "draft" or stage in REVISION_STAGES:
            schema = {"stage": stage, "content": "完整正文"}
            if stage in REVISION_STAGES:
                schema["alternative_for_small_fixes"] = {"replacements": [{"before": "当前稿中唯一原文", "after": "修订后原文"}]}
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
                "relationship_matrix": [{"characters": ["人物A", "人物B"], "relation": "关系及张力"}],
                "knowledge_boundaries": [{"character": "人物全称", "knows": ["已知事实"], "does_not_know": ["未知事实"]}],
                "foreshadowing": [{"id": "FB-01", "reader_knows": "读者已知", "hidden": "隐藏事实", "advance_or_payoff": "推进或兑现节点"}],
            }
        elif stage == "chapter_design":
            schema = {
                "stage": stage,
                "scenes": [{
                    "scene_id": "S1", "setting": "地点与时段", "objective": "本场目标",
                    "obstacle": "阻碍", "motivation": "人物为何此刻行动", "trigger": "触发事件",
                    "choice": "关键选择", "consequence": "可见后果", "next_scene_entry": "下一场入口",
                }],
                "dialogue_pressure_plan": [{"speaker": "人物", "goal": "对白目标", "target": "施压对象", "withheld": "不能说出的信息", "voice_rule": "语言特征"}],
                "character_knowledge": {"人物全称": {"knows": ["本章前已知"], "cannot_know": ["本章前未知"]}},
                "foreshadow_actions": [{"id": "FB-01", "action": "铺设、推进或兑现", "reader_effect": "读者获得的信息"}],
                "core_reveal_closeup": "核心揭示必须落到具体动作、物件或可见证据",
            }
        elif stage == "canon_update":
            schema = {"stage": stage, "facts": [], "character_states": [], "relationships": [], "open_threads": [], "foreshadowing": [], "evidence": ["最终正文原文"]}
        else:
            schema = {"stage": stage, "passed": True, "story_engine": "", "pacing": "", "character_change": "", "foreshadow_density": "", "pattern_repetition": "", "evidence": []}
        return {"run_id": run.run_id, "status": run.status, "book_id": run.book_id, "chapter": run.current_chapter, "stage": stage, "revision_round": run.revision_round, "max_revisions": run.max_revisions, "task": tasks.get(stage, stage), "output_schema": schema}

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
            raise WorkflowError(f"{label} 必须是对象")
        missing = [field for field in fields if field not in value or value[field] is None or value[field] == "" or value[field] == [] or value[field] == {}]
        if missing:
            raise WorkflowError(f"{label} 缺少非空字段：{', '.join(missing)}")

    @staticmethod
    def _read_json(path: Path) -> Any:
        if not path.is_file():
            return {}
        return json.loads(path.read_text(encoding="utf-8"))
