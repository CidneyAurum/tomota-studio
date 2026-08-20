from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class SkillManifest:
    root_path: str
    skill_name: str
    skill_version_hash: str
    module_names: list[str]
    template_paths: list[str]
    corpus_stats: dict[str, Any]
    file_hashes: dict[str, str]
    checked_at: str = field(default_factory=utc_now)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class SkillLockResult:
    ok: bool
    status: str
    expected_hash: str | None = None
    current_hash: str | None = None
    changed_files: list[str] = field(default_factory=list)
    message: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class ModulePack:
    name: str
    artifacts: dict[str, str]
    source_paths: dict[str, str]


@dataclass
class Reference:
    kind: str
    ref_id: str
    title: str
    excerpt_type: str = ""
    tags: list[str] = field(default_factory=list)
    path: str = ""
    paragraph_range: str = ""
    text: str = ""
    summary: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class ReferencePack:
    query: dict[str, Any]
    positive: list[Reference]
    negative: list[Reference]
    instructions: list[str]
    created_at: str = field(default_factory=utc_now)

    def to_dict(self) -> dict[str, Any]:
        return {
            "query": self.query,
            "positive": [item.to_dict() for item in self.positive],
            "negative": [item.to_dict() for item in self.negative],
            "instructions": self.instructions,
            "created_at": self.created_at,
        }


@dataclass
class PromptPack:
    task: str
    stage: str
    module_chain: list[str]
    main_text: str
    modules: list[ModulePack]
    references: ReferencePack | None = None
    templates: dict[str, str] = field(default_factory=dict)
    project_preferences: str = ""
    created_at: str = field(default_factory=utc_now)

    def render(self) -> str:
        parts = [
            "# Tomota PromptPack",
            f"任务：{self.task}",
            f"阶段：{self.stage}",
            f"模块链：{' -> '.join(self.module_chain)}",
            "",
            "## 主 Skill",
            self.main_text,
        ]
        for module in self.modules:
            parts.extend(["", f"## 模块：{module.name}"])
            for artifact, text in module.artifacts.items():
                parts.extend([f"### {artifact}", text])
        if self.references:
            parts.extend(["", "## 结构参考包", _render_reference_pack(self.references)])
        for name, text in self.templates.items():
            parts.extend(["", f"## 模板：{name}", text])
        if self.project_preferences.strip():
            parts.extend(["", "## 本项目写作偏好（用户明确要求）", self.project_preferences.strip()])
        parts.extend([
            "",
            "## 生成边界",
            "只借鉴结构、节奏、信息投放和章末承接，不复制任何参考文本的句面或表面文风。",
        ])
        return "\n".join(parts).strip() + "\n"


def _render_reference_pack(pack: ReferencePack) -> str:
    lines = ["检索参数：" + repr(pack.query), "", "正例："]
    for item in pack.positive:
        lines.append(f"- {item.ref_id}《{item.title}》[{item.excerpt_type}] {item.summary or item.text[:240]}")
    lines.append("反例：")
    for item in pack.negative:
        lines.append(f"- {item.ref_id}《{item.title}》 {item.summary or item.text[:240]}")
    lines.append("使用要求：")
    lines.extend(f"- {instruction}" for instruction in pack.instructions)
    return "\n".join(lines)


@dataclass
class ChapterContract:
    book_id: str
    chapter_number: int
    title: str
    objective: str
    obstacle: str
    change: str
    new_information: str = ""
    chapter_hook: str = ""
    previous_force: str = ""
    next_first_beat: str = ""
    current_character_goal: str = ""
    relationship_state: str = ""
    body_information_state: str = ""
    unresolved_foreshadowing: str = ""
    ending_type: str = ""
    target_word_count: int = 2500
    problem_tags: list[str] = field(default_factory=list)
    volume_id: str = "volume-1"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class ScenePlan:
    scene_id: str
    setting: str
    objective: str
    obstacle: str
    motivation: str
    trigger: str
    choice: str
    consequence: str
    next_scene_entry: str
    characters: list[str] = field(default_factory=list)
    known_information: dict[str, list[str]] = field(default_factory=dict)
    dialogue_pressure: list[str] = field(default_factory=list)
    foreshadow_actions: list[str] = field(default_factory=list)
    key_reveal_closeup: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class CharacterState:
    name: str
    identity: str = ""
    goal: str = ""
    fear: str = ""
    boundary: str = ""
    behavior_pattern: str = ""
    speech_rhythm: str = ""
    forms_of_address: dict[str, str] = field(default_factory=dict)
    avoidance: str = ""
    pressure_method: str = ""
    known_information: list[str] = field(default_factory=list)
    relationships: dict[str, str] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class ForeshadowItem:
    item_id: str
    object_or_anomaly: str
    reader_knows: str
    hidden_truth: str
    planted_chapter: int | None = None
    planted_evidence: str = ""
    next_action_chapter: int | None = None
    payoff_window: str = ""
    status: str = "planned"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class ReviewFinding:
    finding_id: str
    gate: str
    severity: str
    category: str
    location: str
    quote: str
    violated_rule: str
    repair_requirement: str
    diagnosis: str = ""
    status: str = "open"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class ReviewGate:
    gate: str
    passed: bool
    evidence: list[str]
    findings: list[ReviewFinding] = field(default_factory=list)
    summary: str = ""
    checks: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "gate": self.gate,
            "passed": self.passed,
            "evidence": self.evidence,
            "findings": [item.to_dict() for item in self.findings],
            "summary": self.summary,
            "checks": self.checks,
        }


@dataclass
class WorkflowRun:
    run_id: str
    book_id: str
    chapter_numbers: list[int]
    status: str
    current_chapter: int | None
    current_stage: str
    max_revisions: int = 5
    revision_round: int = 0
    completed_chapters: list[int] = field(default_factory=list)
    stage_history: list[dict[str, Any]] = field(default_factory=list)
    created_at: str = field(default_factory=utc_now)
    updated_at: str = field(default_factory=utc_now)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class ReviewItem:
    category: str
    status: str
    summary: str
    evidence: list[str] = field(default_factory=list)
    route: list[str] = field(default_factory=list)
    severity: str = "info"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class ReviewReport:
    book_id: str
    chapter_number: int
    passed: bool
    items: list[ReviewItem]
    hard_failures: list[str] = field(default_factory=list)
    revision_round: int = 0
    skill_hash: str = ""
    gates: list[ReviewGate] = field(default_factory=list)
    strict_workflow: bool = False
    generated_at: str = field(default_factory=utc_now)

    def to_dict(self) -> dict[str, Any]:
        return {
            "book_id": self.book_id,
            "chapter_number": self.chapter_number,
            "passed": self.passed,
            "items": [item.to_dict() for item in self.items],
            "hard_failures": self.hard_failures,
            "revision_round": self.revision_round,
            "skill_hash": self.skill_hash,
            "gates": [gate.to_dict() for gate in self.gates],
            "strict_workflow": self.strict_workflow,
            "generated_at": self.generated_at,
        }

    def to_markdown(self) -> str:
        lines = [
            f"# 第 {self.chapter_number} 章审查报告",
            "",
            f"- 结论：{'通过' if self.passed else '阻塞'}",
            f"- 修订轮次：{self.revision_round}",
            f"- Skill 哈希：`{self.skill_hash}`",
            "",
            "| 审查项 | 状态 | 严重度 | 说明 |",
            "|---|---|---|---|",
        ]
        for item in self.items:
            evidence = "；".join(item.evidence)
            lines.append(f"| {item.category} | {item.status} | {item.severity} | {item.summary} {evidence} |")
        if self.hard_failures:
            lines.extend(["", "## 阻塞原因", *[f"- {reason}" for reason in self.hard_failures]])
        for gate in self.gates:
            lines.extend(["", f"## {gate.gate}", f"- 结论：{'通过' if gate.passed else '退回'}"])
            for finding in gate.findings:
                lines.append(
                    f"- `{finding.location}`｜{finding.category}｜原文：{finding.quote}｜"
                    f"违反：{finding.violated_rule}｜修复：{finding.repair_requirement}"
                )
        return "\n".join(lines) + "\n"


@dataclass
class GenerationArtifact:
    kind: str
    text: str
    prompt_pack: PromptPack | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class PublishBatch:
    batch_id: str
    book_id: str
    chapter_numbers: list[int]
    schedule: dict[str, str]
    status: str = "prepared"
    created_at: str = field(default_factory=utc_now)


@dataclass
class PublishResult:
    batch_id: str
    status: str
    submitted: list[int] = field(default_factory=list)
    skipped: list[int] = field(default_factory=list)
    failed: dict[int, str] = field(default_factory=dict)
    message: str = ""
