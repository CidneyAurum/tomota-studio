from __future__ import annotations

import csv
import hashlib
import json
import os
import re
import subprocess
import sys
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
    "reversal_toolkit",
    "style_combat_face",
    "female_audience",
    "emotion_system",
    "scan",
    "analyze",
    "cover",
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


def stable_hash(value: Any) -> str:
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


class SkillNotFoundError(RuntimeError):
    pass


class SkillChangedError(RuntimeError):
    pass


class SkillAdapter:
    """Read-only adapter supporting both oh-story-claudecode and webnovel-writing skills.

    The adapter deliberately does not copy the skill corpus. It creates a lock
    containing hashes and reads source files on demand so a changed skill cannot
    silently alter a running book.
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
            BUNDLED_WEBNOVEL_ROOT,
            DEFAULT_OH_STORY_ROOT,
            DEFAULT_WEBNOVEL_ROOT,
        ]
        for candidate in candidates:
            if candidate and candidate.is_dir() and ((candidate / "skills").is_dir() or (candidate / "SKILL.md").is_file()):
                return candidate
        if BUNDLED_WEBNOVEL_ROOT.is_dir():
            return BUNDLED_WEBNOVEL_ROOT
        return DEFAULT_OH_STORY_ROOT if DEFAULT_OH_STORY_ROOT.is_dir() else DEFAULT_WEBNOVEL_ROOT

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

        module_names: list[str] = []
        for name in MODULE_NAMES:
            if (self.root / "references" / "modules" / name).is_dir() or self.is_oh_story:
                module_names.append(name)

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
        self._require_root()
        main_skill = self.root / "SKILL.md"
        if main_skill.is_file():
            return main_skill.read_text(encoding="utf-8")
        long_skill = self.root / "skills" / "story-long-write" / "SKILL.md"
        if long_skill.is_file():
            return long_skill.read_text(encoding="utf-8")
        return "oh-story-claudecode writing engine"

    def load_project_preferences(self) -> str:
        """Read user corrections without mutating the read-only external skill."""
        path = self.project_root / PROJECT_PREFERENCES_PATH
        if not path.is_file():
            return ""
        return path.read_text(encoding="utf-8")

    def _oh_story_module_map(self) -> dict[str, list[str]]:
        """Maps standard module names to oh-story-claudecode reference files."""
        return {
            "anti_ai_voice": [
                "skills/story-deslop/references/anti-ai-writing.md",
                "skills/story-deslop/references/banned-words.md",
            ],
            "concept_planning": [
                "skills/story-long-write/references/commercial-core-methods.md",
                "skills/story-long-write/references/genre-core-mechanics.md",
            ],
            "opening": [
                "skills/story-long-write/references/opening-design.md",
                "skills/story-long-write/references/hooks-chapter.md",
            ],
            "plot_logic": [
                "skills/story-long-write/references/plot-core-methods.md",
                "skills/story-long-write/references/outline-conflict.md",
            ],
            "dialogue": [
                "skills/story-long-write/references/dialogue-mastery.md",
            ],
            "transition": [
                "skills/story-long-write/references/format-and-structure.md",
            ],
            "chapter_ending": [
                "skills/story-long-write/references/hooks-chapter.md",
                "skills/story-long-write/references/hooks-suspense.md",
            ],
            "character_consistency": [
                "skills/story-long-write/references/character-basics.md",
                "skills/story-long-write/references/character-design-methods.md",
            ],
            "consistency_review": [
                "skills/story-long-write/references/quality-checklist.md",
                "skills/story-long-write/references/state-tracking.md",
            ],
            "volume_outline": [
                "skills/story-long-write/references/outline-structure-theory.md",
                "skills/story-long-write/references/outline-rhythm.md",
            ],
            "reversal_toolkit": [
                "skills/story-long-write/references/reversal-toolkit.md",
            ],
            "style_combat_face": [
                "skills/story-long-write/references/style-combat-face.md",
            ],
            "female_audience": [
                "skills/story-long-write/references/female-audience-writing.md",
            ],
            "emotion_system": [
                "skills/story-long-write/references/plot-emotion-system.md",
            ],
            "scan": [
                "skills/story-long-scan/SKILL.md",
                "skills/story-long-write/references/genre-catalog.md",
            ],
            "analyze": [
                "skills/story-long-analyze/SKILL.md",
                "skills/story-long-write/references/plot-frameworks.md",
            ],
            "cover": [
                "skills/story-cover/SKILL.md",
            ],
        }

    def load_module(self, name: str, artifacts: Iterable[str] | None = None) -> ModulePack:
        if name not in MODULE_NAMES:
            raise ValueError(f"unknown module: {name}")

        content: dict[str, str] = {}
        sources: dict[str, str] = {}

        # 1. Check classic modules directory first
        classic_dir = self.root / "references" / "modules" / name
        if classic_dir.is_dir():
            requested = list(artifacts or MODULE_ARTIFACTS)
            if name == "volume_outline":
                requested += ["outline_template.md", "chapter_template.md"]
            for artifact in dict.fromkeys(requested):
                path = classic_dir / artifact
                if path.is_file():
                    content[artifact] = path.read_text(encoding="utf-8")
                    sources[artifact] = str(path)
            if "README.md" in content and "runtime.md" in content:
                return ModulePack(name=name, artifacts=content, source_paths=sources)

        # 2. Oh-story mapping fallback
        mapping = self._oh_story_module_map().get(name, [])
        ref_texts: list[str] = []
        for rel in mapping:
            ref_path = self.root / rel
            if ref_path.is_file():
                text = ref_path.read_text(encoding="utf-8")
                ref_texts.append(text)
                sources[ref_path.name] = str(ref_path)

        if ref_texts:
            merged = "\n\n---\n\n".join(ref_texts)
            content["README.md"] = f"# 模块规则：{name}\n\n" + merged[:4000]
            content["runtime.md"] = f"# 运行规则：{name}\n\n" + (merged[4000:8000] if len(merged) > 4000 else merged)
            content["tutorial.md"] = merged
            content["good_examples.md"] = "参考 oh-story 样例规范与结构。"
            content["bad_examples.md"] = "杜绝空洞总结与抽象套话。"
            return ModulePack(name=name, artifacts=content, source_paths=sources)

        # 3. Fallback dummy pack to prevent hard crash if optional module
        content["README.md"] = f"# 模块：{name}"
        content["runtime.md"] = f"# 运行规则：{name}"
        return ModulePack(name=name, artifacts=content, source_paths={"README.md": str(self.root)})

    def load_template(self, name: str) -> str:
        aliases = {
            "outline": "references/modules/volume_outline/outline_template.md",
            "chapter": "references/modules/volume_outline/chapter_template.md",
            "outline_template": "references/modules/volume_outline/outline_template.md",
            "chapter_template": "references/modules/volume_outline/chapter_template.md",
        }
        relative = aliases.get(name, name)
        path = self.root / relative
        if path.is_file():
            return path.read_text(encoding="utf-8")

        # In oh-story, check references/workflow-setup.md or workflow-chapter.md
        if name in ("outline", "outline_template"):
            setup_path = self.root / "skills" / "story-long-write" / "references" / "workflow-setup.md"
            if setup_path.is_file():
                return setup_path.read_text(encoding="utf-8")
        elif name in ("chapter", "chapter_template"):
            chap_path = self.root / "skills" / "story-long-write" / "references" / "workflow-chapter.md"
            if chap_path.is_file():
                return chap_path.read_text(encoding="utf-8")

        local_template = self.project_root / "library" / "templates" / f"{name}.json"
        if local_template.is_file():
            return local_template.read_text(encoding="utf-8")

        raise SkillNotFoundError(f"skill template not found: {name}")

    def search_corpus(
        self,
        *,
        excerpt_type: str | None = None,
        tag: str | None = None,
        keyword: str | None = None,
        limit: int = 10,
    ) -> list[Reference]:
        script = self.root / "scripts" / "search_corpus_examples.py"
        if script.is_file():
            command = [sys.executable, str(script), "--limit", str(max(1, limit))]
            if excerpt_type:
                command += ["--type", excerpt_type]
            if tag:
                command += ["--tag", tag]
            if keyword:
                command += ["--keyword", keyword]
            environment = dict(os.environ)
            environment["PYTHONIOENCODING"] = "utf-8"
            command.insert(1, "-X")
            command.insert(2, "utf8")
            completed = subprocess.run(command, cwd=self.root, capture_output=True, env=environment, timeout=20)
            if completed.returncode == 0:
                return self._parse_search_output(completed.stdout.decode("utf-8", errors="replace"))

        # In oh-story, search references markdown files directly
        references: list[Reference] = []
        ref_dir = self.root / "skills" / "story-long-write" / "references"
        if ref_dir.is_dir():
            for ref_file in sorted(ref_dir.glob("*.md")):
                text = ref_file.read_text(encoding="utf-8", errors="replace")
                if keyword and keyword.lower() not in text.lower():
                    continue
                if tag and tag.lower() not in text.lower():
                    continue
                references.append(Reference(
                    kind="guideline",
                    ref_id=ref_file.stem,
                    title=ref_file.stem.replace("-", " ").title(),
                    excerpt_type=excerpt_type or "methodology",
                    tags=[tag] if tag else ["methodology"],
                    path=str(ref_file),
                    text=text[:1200],
                    summary=f"来自 oh-story 参考库：{ref_file.name}",
                ))
                if len(references) >= limit:
                    break

        # The portable Skill intentionally omits downloaded source corpora. Its
        # curated module examples still provide useful, redistributable local
        # references, so a clean installation never has to fabricate examples.
        if not references:
            modules_dir = self.root / "references" / "modules"
            if modules_dir.is_dir():
                for example_file in sorted(modules_dir.glob("*/good_examples.md")):
                    text = example_file.read_text(encoding="utf-8", errors="replace")
                    haystack = f"{example_file.parent.name}\n{text}".lower()
                    if keyword and keyword.lower() not in haystack:
                        continue
                    if tag and tag.lower() not in haystack:
                        continue
                    module_name = example_file.parent.name
                    references.append(Reference(
                        kind="module_example",
                        ref_id=f"{module_name}:good_examples",
                        title=f"{module_name} 正例库",
                        excerpt_type=excerpt_type or "module_example",
                        tags=[tag] if tag else [module_name],
                        path=str(example_file),
                        text=text[:1200],
                        summary=f"来自内置写作 Skill 的 {module_name} 正例。",
                    ))
                    if len(references) >= limit:
                        break
        return references

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
        references = self.search_corpus(excerpt_type=excerpt_type, tag=tag, keyword=keyword, limit=8)
        positive = references[:4]
        module_pack = self.load_module(module, ["README.md", "runtime.md", "good_examples.md", "bad_examples.md"])
        negative_text = module_pack.artifacts.get("bad_examples.md", "")
        negative = [Reference(
            kind="module_bad_example",
            ref_id=f"{module}:bad_examples",
            title=f"{module} 反例库",
            path=module_pack.source_paths.get("bad_examples.md", ""),
            text=negative_text[:1800],
            summary="专项模块反例：只用于识别失效结构，不用于复制。",
        )]
        return ReferencePack(
            query={"module": module, "type": excerpt_type, "tag": tag, "keyword": keyword, "limit": 8},
            positive=positive,
            negative=negative,
            instructions=[
                "只总结冲突、节奏、信息投放和章末结构。",
                "不复制参考文本的句子、人物、专名或表面文风。",
                "如果正例不足，保留实际数量并在日志中标记，不伪造参考。",
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
        modules = [
            self.load_module(name, ["README.md", "runtime.md"] if compact else None)
            for name in module_chain
        ]
        templates: dict[str, str] = {}
        if include_templates:
            try:
                templates["outline"] = self.load_template("outline")
            except SkillNotFoundError:
                pass
            try:
                templates["chapter"] = self.load_template("chapter")
            except SkillNotFoundError:
                pass
        main_text = self.load_main() if not compact else (
            "执行已锁定网文写作体系的当前阶段。只使用本 PromptPack 中的专项运行规则；"
            "所有判断引用正文证据，发现问题即返工，不以章纲意图替代成文效果。"
        )
        return PromptPack(
            task=task,
            stage=stage,
            module_chain=module_chain,
            main_text=main_text,
            modules=modules,
            references=references,
            templates=templates,
            project_preferences=self.load_project_preferences(),
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
