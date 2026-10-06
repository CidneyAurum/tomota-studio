from __future__ import annotations

import csv
import hashlib
import json
import os
import re
from pathlib import Path
from typing import Any, Iterable

try:
    import yaml
except ImportError:  # pragma: no cover - pyproject installs it in normal use
    yaml = None

from .models import (
    ModulePack,
    PromptPack,
    Reference,
    ReferencePack,
    SkillLockResult,
    SkillManifest,
)


MODULE_NAMES = [
    "concept_planning",
    "opening",
    "transition",
    "dialogue",
    "chapter_ending",
    "plot_logic",
    "character_consistency",
    "consistency_review",
    "volume_outline",
    "anti_ai_voice",
]
MODULE_ARTIFACTS = ["README.md", "tutorial.md", "runtime.md", "good_examples.md", "bad_examples.md", "source_index.md"]
TEMPLATE_PATHS = [
    "references/modules/volume_outline/outline_template.md",
    "references/modules/volume_outline/chapter_template.md",
]
PROJECT_PREFERENCES_PATH = Path("library/preferences/writing_preferences.md")
DEFAULT_OH_STORY_ROOT = Path.home() / ".codex" / "skills" / "oh-story-claudecode"
DEFAULT_WEBNOVEL_ROOT = Path.home() / ".codex" / "skills" / "webnovel-writing"
BUNDLED_WEBNOVEL_ROOT = Path(__file__).resolve().parents[2] / "skills" / "webnovel-writing"


# Installed story skills remain discoverable for compatibility and explicit
# inspection, but they are never a creative authority inside Tomota. Runtime
# prompts consume only this small, auditable, genre-neutral logic kernel. This
# avoids template priming and silent changes when an external skill is updated.
NEUTRAL_SUPPORT_RULES: dict[str, tuple[str, ...]] = {
    "concept_planning": (
        "用人物目标、选择、代价和后果建立可验证因果链；未被本书权威输入确认的内容偏好不得自行补入。",
        "把读者承诺落实为阶段性可见变化，同时保留用户尚未决定的开放项。",
        "每个长期机制都要说明限制、代价和变化空间，不能用万能设定代替冲突。",
    ),
    "opening": (
        "开篇应让读者看清当下人物、处境、压力或异常；强度与形式完全由本书契约决定。",
        "开篇形式只能来自本书契约和作者方法，通用逻辑不规定固定结构。",
    ),
    "plot_logic": (
        "逐场核对触发、动机、选择、代价、后果及下一场入口，避免巧合解围和信息瞬移。",
        "场景必须产生可说明的状态变化；静态场景只有承担必要观察、关系或信息功能时才保留。",
    ),
    "dialogue": (
        "对白应体现说话者知识边界、目标、回避和施压方式，并改变信息、关系、压力或决定。",
        "执行换声检查，避免所有人物共享同一语气和解释习惯。",
    ),
    "transition": (
        "转场必须交代触发、时间、路径、视角与未消失的后果，不得靠空行掩盖状态跳跃。",
    ),
    "chapter_ending": (
        "章末应落在本章真实造成的状态、选择、代价或未完成行动上；形式服从作者契约。",
        "通用逻辑只核对状态交接，不规定章末类型、转折频率、强度或句式。",
    ),
    "character_consistency": (
        "人物行为必须同时对证目标、恐惧、能力、知识、关系和当下压力；变化需要可见原因。",
    ),
    "consistency_review": (
        "只依据当前产物、Canon 和冻结契约判断；无法评估时明确阻塞，不得假装通过。",
        "检查术语、数量、时间、物件、伤势、承诺、知识和伏笔的连续性。",
    ),
    "volume_outline": (
        "分卷应有独立目标、人物或局面变化、兑现与下一卷入口；卷数和节奏由本书因果决定。",
    ),
    "anti_ai_voice": (
        "删除机械总结、抽象套话、翻译腔和无功能的排比；保留作者契约要求的节奏与陌生化。",
        "表达清理不得把独特句法统一改成通顺但无辨识度的标准腔调。",
    ),
}


def stable_hash(value: Any) -> str:
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


class SkillNotFoundError(RuntimeError):
    pass


class SkillChangedError(RuntimeError):
    pass


class SkillAdapter:
    """Compatibility inventory plus Tomota's sealed neutral logic kernel.

    Installed skills can still be inspected and locked for diagnostics. Their
    prose, examples, templates and lint scripts are not generation inputs.
    """

    def __init__(self, project_root: Path | str, skill_root: Path | str | None = None):
        self.project_root = Path(project_root).resolve()
        self.root = self._resolve_skill_root(skill_root)
        self.lock_path = self.project_root / "config" / "skill.lock.yaml"
        self.is_oh_story = self._detect_oh_story()

    def _resolve_skill_root(self, configured: Path | str | None = None) -> Path:
        candidates = [
            Path(configured).expanduser().resolve() if configured else None,
            Path(os.environ["TOMOTA_STORY_SKILL_ROOT"]).expanduser().resolve() if os.environ.get("TOMOTA_STORY_SKILL_ROOT") else None,
            Path(os.environ["TOMOTA_WEBNOVEL_SKILL_ROOT"]).expanduser().resolve() if os.environ.get("TOMOTA_WEBNOVEL_SKILL_ROOT") else None,
            DEFAULT_OH_STORY_ROOT,
            DEFAULT_WEBNOVEL_ROOT,
            BUNDLED_WEBNOVEL_ROOT,
        ]
        for candidate in candidates:
            if candidate and candidate.is_dir() and ((candidate / "skills").is_dir() or (candidate / "SKILL.md").is_file()):
                return candidate
        if DEFAULT_OH_STORY_ROOT.is_dir():
            return DEFAULT_OH_STORY_ROOT
        if DEFAULT_WEBNOVEL_ROOT.is_dir():
            return DEFAULT_WEBNOVEL_ROOT
        return BUNDLED_WEBNOVEL_ROOT

    def _detect_oh_story(self) -> bool:
        return (self.root / "skills" / "story-long-write").is_dir() or (self.root / "skills" / "story-setup").is_dir()

    def _require_root(self) -> None:
        if not self.root.is_dir():
            raise SkillNotFoundError(f"skill directory not found: {self.root}")
        if not (self.root / "SKILL.md").is_file() and not self.is_oh_story:
            raise SkillNotFoundError(f"valid skill root not found at: {self.root}")

    def _tracked_paths(self) -> list[Path]:
        self._require_root()
        # Track relevant skill files except git and bytecode caches
        return sorted(
            path for path in self.root.rglob("*")
            if path.is_file() and "__pycache__" not in path.parts and ".git" not in path.parts
        )

    def _hash_files(self, paths: Iterable[Path]) -> dict[str, str]:
        result: dict[str, str] = {}
        for path in paths:
            try:
                digest = hashlib.sha256(path.read_bytes()).hexdigest()
                result[path.relative_to(self.root).as_posix()] = digest
            except OSError:
                continue
        return result

    def inspect(self) -> SkillManifest:
        paths = self._tracked_paths()
        file_hashes = self._hash_files(paths)
        frontmatter = self._read_frontmatter(self.root / "SKILL.md") if (self.root / "SKILL.md").is_file() else {}
        stats = self._corpus_stats()
        skill_hash = stable_hash({"root": str(self.root), "files": file_hashes})
        templates = [path for path in TEMPLATE_PATHS if (self.root / path).is_file()]

        module_names = list(MODULE_NAMES)

        return SkillManifest(
            root_path=str(self.root),
            skill_name=str(frontmatter.get("name", "oh-story-claudecode" if self.is_oh_story else "webnovel-writing")),
            skill_version_hash=skill_hash,
            module_names=module_names,
            template_paths=templates,
            corpus_stats=stats,
            file_hashes=file_hashes,
        )

    def _read_frontmatter(self, path: Path) -> dict[str, str]:
        if not path.is_file():
            return {}
        text = path.read_text(encoding="utf-8")
        if not text.startswith("---"):
            return {}
        end = text.find("\n---", 3)
        if end < 0:
            return {}
        data: dict[str, str] = {}
        for line in text[4:end].splitlines():
            if ":" in line:
                key, value = line.split(":", 1)
                data[key.strip()] = value.strip().strip('"\'')
        return data

    def _corpus_stats(self) -> dict[str, Any]:
        stats: dict[str, Any] = {}
        stats_path = self.root / "analysis" / "stats.json"
        if stats_path.is_file():
            try:
                value = json.loads(stats_path.read_text(encoding="utf-8"))
                if isinstance(value, dict):
                    return value
            except json.JSONDecodeError:
                pass
        for filename, key in [("article_profiles.csv", "articles"), ("excerpts.csv", "excerpts")]:
            path = self.root / "analysis" / filename
            if path.is_file():
                with path.open(encoding="utf-8", newline="") as handle:
                    stats[key] = sum(1 for _ in csv.DictReader(handle))
        if self.is_oh_story:
            ref_dir = self.root / "skills" / "story-long-write" / "references"
            if ref_dir.is_dir():
                stats["reference_documents"] = sum(1 for p in ref_dir.glob("*.md"))
                stats["skills_count"] = sum(1 for p in (self.root / "skills").iterdir() if p.is_dir())
        return stats

    def load_main(self) -> str:
        return (
            "Tomota 中性写作逻辑核心：只处理因果、人物动机与知识边界、连续性、场景变化、"
            "对白功能、转场和可公开证据。外部 Skill 原文不进入生成。"
        )

    def load_project_preferences(self) -> str:
        """Read user corrections without mutating the read-only external skill."""
        path = self.project_root / PROJECT_PREFERENCES_PATH
        if not path.is_file():
            return ""
        return path.read_text(encoding="utf-8")

    def runtime_policy(self) -> dict[str, Any]:
        return {
            "mode": "tomota_neutral_writing_logic",
            "runtime_hash": stable_hash(NEUTRAL_SUPPORT_RULES),
            "external_skill_is_generation_authority": False,
            "external_skill_text_injected": False,
            "external_skill_examples_injected": False,
            "external_skill_lint_enabled": False,
            "legacy_global_preferences_injected": False,
            "author_rules_source": "published_author_version_via_compiled_writing_policy",
            "logic_modules": sorted(NEUTRAL_SUPPORT_RULES),
        }

    def load_module(self, name: str, artifacts: Iterable[str] | None = None) -> ModulePack:
        if name not in MODULE_NAMES:
            raise ValueError(f"unknown module: {name}")
        # Runtime module access is intentionally closed over Tomota's neutral
        # logic kernel. It is not an escape hatch for pasting an installed
        # skill's prose back into planning, drafting or reviewing.
        requested = list(artifacts or MODULE_ARTIFACTS)
        rules = NEUTRAL_SUPPORT_RULES.get(name, (
            "只提供可由当前产物与冻结契约核验的通用逻辑检查。",
        ))
        available = {
            "README.md": (
                f"# 中性写作逻辑：{name}\n\n"
                "本模块不决定题材、人物原型、剧情骨架、节奏公式或文风。"
            ),
            "runtime.md": "# 可执行检查\n\n" + "\n".join(f"- {rule}" for rule in rules),
            "tutorial.md": "# 使用边界\n\n逐项对证当前产物、Canon 与冻结契约；无法判断时不得假装通过。",
            "good_examples.md": "",
            "bad_examples.md": "",
            "source_index.md": "tomota://neutral-writing-logic",
        }
        content = {key: available[key] for key in requested if key in available}
        content.setdefault("README.md", available["README.md"])
        content.setdefault("runtime.md", available["runtime.md"])
        return ModulePack(
            name=name,
            artifacts=content,
            source_paths={key: f"tomota://neutral-writing-logic/{name}/{key}" for key in content},
        )

    def load_template(self, name: str) -> str:
        if name in {"outline", "outline_template"}:
            return (
                "# 结构字段（不规定题材或篇幅）\n"
                "- 故事承诺\n- 人物目标与代价\n- 因果阶段\n- 已确认限制\n- 开放问题\n"
            )
        if name in {"chapter", "chapter_template"}:
            return (
                "# 章节契约字段\n"
                "- 当前状态\n- 人物目标\n- 阻碍\n- 选择\n- 代价与变化\n- 下一场入口\n"
            )
        raise SkillNotFoundError(f"neutral template not found: {name}")

    def search_corpus(
        self,
        *,
        excerpt_type: str | None = None,
        tag: str | None = None,
        keyword: str | None = None,
        limit: int = 10,
    ) -> list[Reference]:
        # Retained as a compatibility API. Generic skill corpora are not a
        # legitimate author source and are never searched automatically.
        return []

    def _parse_search_output(self, output: str) -> list[Reference]:
        blocks = [block.strip() for block in re.split(r"\n\s*\n", output) if block.strip()]
        references: list[Reference] = []
        for block in blocks:
            lines = block.splitlines()
            if not lines or not lines[0].startswith("["):
                continue
            header = re.match(r"\[(?P<kind>[^]]+)\]\s+(?P<id>\S+)\s+《(?P<title>.+)》", lines[0])
            if not header:
                continue
            values: dict[str, str] = {}
            text_lines: list[str] = []
            for line in lines[1:]:
                if line.startswith("标签:"):
                    values["tags"] = line.partition(":")[2].strip()
                elif line.startswith("类型:"):
                    values["excerpt_type"] = line.partition(":")[2].strip()
                elif line.startswith("路径:"):
                    values["path"] = line.partition(":")[2].strip()
                elif line.startswith("摘要:"):
                    values["summary"] = line.partition(":")[2].strip()
                else:
                    text_lines.append(line)
            path = values.get("path", "")
            paragraph_range = ""
            if " | 段落:" in path:
                path, paragraph_range = path.split(" | 段落:", 1)
            references.append(Reference(
                kind=header.group("kind").lower(),
                ref_id=header.group("id"),
                title=header.group("title"),
                excerpt_type=values.get("excerpt_type", ""),
                tags=[item.strip() for item in values.get("tags", "").split("|") if item.strip()],
                path=path,
                paragraph_range=paragraph_range,
                text="\n".join(text_lines).strip(),
                summary=values.get("summary", ""),
            ))
        return references

    def build_reference_pack(
        self,
        module: str,
        *,
        excerpt_type: str | None = None,
        tag: str | None = None,
        keyword: str | None = None,
    ) -> ReferencePack:
        # Generic skill corpora are not an author source and cannot enter an
        # automatic generation prompt. Rights-aware author distillation and
        # explicit source analysis use separate, traceable paths.
        return ReferencePack(
            query={"module": module, "type": excerpt_type, "tag": tag, "keyword": keyword, "mode": "disabled_for_generation"},
            positive=[],
            negative=[],
            instructions=[
                "通用 Skill 语料未进入生成；作者来源仅由已确认作者版本提供抽象规则。",
            ],
        )

    def build_prompt_pack(
        self,
        *,
        task: str,
        stage: str,
        module_chain: list[str],
        references: ReferencePack | None = None,
        include_templates: bool = False,
        compact: bool = True,
    ) -> PromptPack:
        modules = [self.load_module(name, ["README.md", "runtime.md"]) for name in module_chain]
        main_text = (
            "这些内容只是低优先级写作逻辑辅助，不是创作约束源。它只核对因果、人物知识边界、"
            "状态连续性、场景变化和证据，不新增任何内容偏好；所有创作决定服从用户确认、Canon、"
            "基础契约、章节事实和冻结作者契约。判断必须引用当前产物证据。"
        )
        return PromptPack(
            task=task,
            stage=stage,
            module_chain=module_chain,
            main_text=main_text,
            modules=modules,
            references=None,
            templates={},
            # Legacy global free-form preferences mixed book-specific rules
            # across projects. Book overrides now enter only through the
            # compiled policy, where source and scope are auditable.
            project_preferences="",
        )

    def refresh_lock(self) -> SkillManifest:
        manifest = self.inspect()
        self.lock_path.parent.mkdir(parents=True, exist_ok=True)
        if yaml:
            payload = yaml.safe_dump(manifest.to_dict(), allow_unicode=True, sort_keys=False)
        else:
            payload = json.dumps(manifest.to_dict(), ensure_ascii=False, indent=2)
        self.lock_path.write_text(payload, encoding="utf-8")
        self.sync_index(manifest)
        return manifest

    def sync_index(self, manifest: SkillManifest | None = None) -> None:
        """Write a small local index; never copy source skill contents."""
        manifest = manifest or self.inspect()
        modules_dir = self.project_root / "library" / "modules"
        templates_dir = self.project_root / "library" / "templates"
        modules_dir.mkdir(parents=True, exist_ok=True)
        templates_dir.mkdir(parents=True, exist_ok=True)
        for module in manifest.module_names:
            pack = self.load_module(module, ["README.md", "tutorial.md", "runtime.md", "good_examples.md", "bad_examples.md", "source_index.md"])
            index = {
                "name": module,
                "root_path": str(self.root / "references" / "modules" / module if not self.is_oh_story else self.root),
                "artifacts": sorted(pack.artifacts),
                "source_paths": pack.source_paths,
                "file_hashes": {name: hashlib.sha256(text.encode("utf-8")).hexdigest() for name, text in pack.artifacts.items()},
                "skill_hash": manifest.skill_version_hash,
            }
            (modules_dir / f"{module}.json").write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        for alias, relative in [("outline", TEMPLATE_PATHS[0]), ("chapter", TEMPLATE_PATHS[1])]:
            path = self.root / relative
            index = {
                "name": alias,
                "source_path": str(path),
                "skill_hash": manifest.skill_version_hash,
                "file_hash": hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None,
            }
            (templates_dir / f"{alias}.json").write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    def _read_lock(self) -> dict[str, Any] | None:
        if not self.lock_path.is_file():
            return None
        raw = self.lock_path.read_text(encoding="utf-8")
        if yaml:
            value = yaml.safe_load(raw)
        else:
            value = json.loads(raw)
        return value if isinstance(value, dict) else None

    def verify_lock(self) -> SkillLockResult:
        try:
            manifest = self.inspect()
        except SkillNotFoundError as exc:
            return SkillLockResult(False, "missing_skill", message=str(exc))
        lock = self._read_lock()
        if not lock:
            return SkillLockResult(False, "missing_lock", current_hash=manifest.skill_version_hash, message="run `tomota skill refresh-lock` first")
        expected_hash = str(lock.get("skill_version_hash", ""))
        expected_files = lock.get("file_hashes", {}) or {}
        changed = sorted(set(expected_files) | set(manifest.file_hashes))
        changed = [path for path in changed if expected_files.get(path) != manifest.file_hashes.get(path)]
        if lock.get("root_path") != str(self.root):
            changed.append("<root_path>")
        if expected_hash != manifest.skill_version_hash or changed:
            return SkillLockResult(
                False,
                "changed",
                expected_hash=expected_hash,
                current_hash=manifest.skill_version_hash,
                changed_files=changed,
                message="skill files changed; refresh-lock requires explicit confirmation",
            )
        return SkillLockResult(True, "ok", expected_hash=expected_hash, current_hash=manifest.skill_version_hash, message="skill lock is current")

    def doctor(self) -> dict[str, Any]:
        checks: dict[str, Any] = {
            "root": str(self.root),
            "is_oh_story": self.is_oh_story,
            "root_exists": self.root.is_dir(),
            "main_exists": (self.root / "SKILL.md").is_file() or self.is_oh_story,
            "modules": {},
            "templates": {},
            "corpus_script": (self.root / "scripts" / "search_corpus_examples.py").is_file() or self.is_oh_story,
            "portable_examples": any((self.root / "references" / "modules").glob("*/good_examples.md")),
            "runtime_policy": self.runtime_policy(),
        }
        for module in MODULE_NAMES:
            pack = self.load_module(module)
            checks["modules"][module] = bool(pack.artifacts)
        for template in ["outline", "chapter"]:
            try:
                self.load_template(template)
                checks["templates"][template] = True
            except SkillNotFoundError:
                checks["templates"][template] = False
        checks["lock"] = self.verify_lock().to_dict()
        checks["ok"] = bool(checks["root_exists"] and checks["main_exists"] and all(checks["modules"].values()))
        return checks
