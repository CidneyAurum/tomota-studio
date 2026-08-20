from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from .deslop import normalize_punctuation, run_deslop_lint
from .generator import Generator, PromptOnlyGenerator
from .models import ChapterContract, GenerationArtifact, ReviewReport
from .review import ChapterReviewer
from .router import SkillRouter
from .skill_adapter import SkillAdapter
from .store import ProjectStore


class PipelineBlocked(RuntimeError):
    pass


class TomotaPipeline:
    def __init__(self, project_root: Path | str, *, skill_root: Path | str | None = None, generator: Generator | None = None):
        self.root = Path(project_root).resolve()
        self.store = ProjectStore(self.root)
        self.skill = SkillAdapter(self.root, skill_root)
        self.router = SkillRouter()
        self.reviewer = ChapterReviewer(self.skill, self.router)
        self.generator = generator or PromptOnlyGenerator()

    def ensure_ready(self, *, require_lock: bool = True) -> None:
        self.store.initialize()
        if require_lock:
            result = self.skill.verify_lock()
            if not result.ok:
                raise PipelineBlocked(result.message or result.status)

    def scan(self, genre: str, *, is_short: bool = False) -> GenerationArtifact:
        self.ensure_ready()
        stage = "scan"
        route = self.router.route(genre, stage)
        references = self.skill.build_reference_pack("concept_planning", keyword=genre)
        prompt_pack = self.skill.build_prompt_pack(
            task=f"针对【{genre}】赛道进行{'短篇' if is_short else '长篇'}题材扫榜、核心卖点拆解与爆款选题策划",
            stage=route.stage,
            module_chain=route.module_chain,
            references=references,
            compact=True,
        )
        scan_prompt = (
            f"# 番茄网文扫榜选材：{genre}（{'短篇' if is_short else '长篇'}）\n\n"
            f"请根据 oh-story 扫榜方法论，分析该赛道当前读者核心爽点、创新金手指切入点、前三章冲突模型与避坑指南。\n\n"
            f"{prompt_pack.render()}"
        )
        return GenerationArtifact("prompt", "scan", prompt_pack, {"genre": genre, "is_short": is_short, "prompt_text": scan_prompt})

    def analyze(self, source_path: Path | str, *, is_short: bool = False) -> GenerationArtifact:
        self.ensure_ready()
        source = Path(source_path).resolve()
        if not source.is_file():
            raise PipelineBlocked(f"对标文件不存在：{source}")
        raw = source.read_text(encoding="utf-8", errors="replace")
        route = self.router.route(source.stem, "analyze")
        prompt_pack = self.skill.build_prompt_pack(
            task=f"拆解范本文档《{source.stem}》的结构节奏、故事引擎与剧情卡",
            stage=route.stage,
            module_chain=route.module_chain,
            compact=True,
        )
        analyze_prompt = (
            f"# 爆款网文对标拆解：{source.name}\n\n"
            f"请对以下文本进行逆向工程拆解：\n"
            f"1. 核心卖点与预期管理\n"
            f"2. 节奏曲线与情节点分布（钩子、危机、转折、高潮、即时反馈）\n"
            f"3. 人设立体度与金手指驱动机制\n"
            f"4. 可复用的结构模板（Chapter Contract 序列）\n\n"
            f"## 参考文本\n{raw[:6000]}\n\n"
            f"{prompt_pack.render()}"
        )
        return GenerationArtifact("prompt", "analyze", prompt_pack, {"source": str(source), "is_short": is_short, "prompt_text": analyze_prompt})

    def cover(self, book_id: str, *, focus_chapter: int = 1) -> GenerationArtifact:
        self.ensure_ready()
        book = self.store.get_book(book_id)
        if not book:
            raise PipelineBlocked(f"book does not exist: {book_id}")
        title = book.get("title", book_id)
        synopsis = book.get("synopsis", "")
        chapter_content = self.store.read_content(book_id, focus_chapter)
        prompt_pack = self.skill.build_prompt_pack(
            task=f"为作品《{title}》设计番茄小说封面视觉概念与文生图 Prompt",
            stage="cover",
            module_chain=["cover"],
            compact=True,
        )
        cover_prompt = (
            f"# 番茄小说封面设计方案：《{title}》\n\n"
            f"**作品题材**：{book.get('genre', '网文')}\n"
            f"**作品简介**：{synopsis}\n\n"
            f"**核心高光场景**：\n{chapter_content[:1500] if chapter_content else '暂无正文'}\n\n"
            f"请生成：\n"
            f"1. 封面视觉焦点与人物构图设计\n"
            f"2. 核心大字书名排版建议（契合番茄爆款视觉）\n"
            f"3. 适用于 Midjourney / Stable Diffusion / Imagen 的中英文高质量生图 Prompt\n\n"
            f"{prompt_pack.render()}"
        )
        return GenerationArtifact("prompt", "cover", prompt_pack, {"book_id": book_id, "title": title, "prompt_text": cover_prompt})

    def deslop_chapter(self, book_id: str, chapter_number: int, *, apply: bool = False, quote_mode: str = "keep") -> dict[str, Any]:
        self.ensure_ready()
        chapter = self.store.get_chapter(book_id, chapter_number)
        if not chapter:
            raise PipelineBlocked(f"chapter does not exist: {chapter_number}")
        content = self.store.read_content(book_id, chapter_number)
        contract = ChapterContract(**chapter["contract"])

        findings = run_deslop_lint(content, skill_root=self.skill.root)
        normalized = normalize_punctuation(content, quote_mode=quote_mode)

        changed = (normalized != content)
        if apply and changed:
            self.store.save_chapter(contract, status=chapter.get("status", "draft"), content=normalized)
            self.store.append_event(book_id, chapter_number, "chapter_deslopped", {"applied": True, "findings_count": len(findings)})

        return {
            "book_id": book_id,
            "chapter_number": chapter_number,
            "findings": [f.to_dict() for f in findings],
            "punctuation_normalized": changed,
            "applied": apply,
            "content_preview": normalized[:300],
        }

    def plan(self, book_id: str, synopsis: str) -> GenerationArtifact:
        self.ensure_ready()
        if not self.store.get_book(book_id):
            raise PipelineBlocked(f"book does not exist: {book_id}")
        route = self.router.route(synopsis, "planning")
        references = self.skill.build_reference_pack("concept_planning", keyword=self._keyword_from_synopsis(synopsis))
        prompt_pack = self.skill.build_prompt_pack(task="根据小说简介完成前置规划", stage=route.stage, module_chain=route.module_chain, references=references, include_templates=True)
        artifact = self.generator.generate_outline(prompt_pack, synopsis)
        path = self.store.book_dir(book_id) / "outlines" / "planning.prompt.md"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(artifact.text, encoding="utf-8")
        self._record_prompt(book_id, None, route.stage, prompt_pack, references)
        self.store.append_event(book_id, None, "outline_prompt_created", {"path": str(path), "route": route.module_chain})
        return GenerationArtifact(artifact.kind, str(path), artifact.prompt_pack, {**artifact.metadata, "path": str(path)})

    def draft(self, contract: ChapterContract, *, max_revisions: int = 3) -> tuple[Path, ReviewReport]:
        self.ensure_ready()
        if not self.store.get_book(contract.book_id):
            raise PipelineBlocked(f"book does not exist: {contract.book_id}")
        route = self.router.route(contract.title, "chapter", contract.problem_tags)
        primary_module = self.router.issue_modules(contract.problem_tags)[0] if self.router.issue_modules(contract.problem_tags) else "chapter_ending"
        references = self.skill.build_reference_pack(primary_module, excerpt_type=self._reference_type(primary_module), keyword=None)
        prompt_pack = self.skill.build_prompt_pack(task=f"生成第{contract.chapter_number}章《{contract.title}》", stage="chapter", module_chain=route.module_chain, references=references)
        canon = self.store.load_canon(contract.book_id)
        artifact = self.generator.generate_chapter(prompt_pack, contract, canon)
        if artifact.kind == "prompt":
            path = self.store.book_dir(contract.book_id) / "drafts" / f"chapter-{contract.chapter_number:04d}.prompt.md"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(artifact.text, encoding="utf-8")
            self.store.update_or_create_prompt_chapter(contract)
            self._record_prompt(contract.book_id, contract.chapter_number, "chapter", prompt_pack, references)
            raise PipelineBlocked(f"prompt created, external Codex generation required: {path}")

        content = artifact.text
        report = self.reviewer.review(contract, content, 0)
        for revision_round in range(1, max_revisions + 1):
            if report.passed:
                break
            feedback = report.to_markdown()
            revised = self.generator.revise_chapter(prompt_pack, contract, canon, content, feedback)
            if revised.kind == "prompt":
                path = self.store.book_dir(contract.book_id) / "drafts" / f"chapter-{contract.chapter_number:04d}.revision-{revision_round}.prompt.md"
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(revised.text, encoding="utf-8")
                raise PipelineBlocked(f"revision prompt created: {path}")
            content = revised.text
            report = self.reviewer.review(contract, content, revision_round)
        path = self.store.save_chapter(contract, status="approved" if report.passed else "blocked", content=content)
        self.store.save_review(report)
        if report.passed:
            self.store.save_canon(contract.book_id, contract.chapter_number, self._canon_delta(contract, content))
        self._record_prompt(contract.book_id, contract.chapter_number, "chapter", prompt_pack, references)
        return path, report

    def review(self, book_id: str, chapter_number: int) -> ReviewReport:
        self.ensure_ready()
        chapter = self.store.get_chapter(book_id, chapter_number)
        if not chapter:
            raise PipelineBlocked(f"chapter does not exist: {chapter_number}")
        contract = ChapterContract(**chapter["contract"])
        report = self.reviewer.review(contract, self.store.read_content(book_id, chapter_number))
        self.store.save_review(report)
        return report

    def ingest_chapter(self, book_id: str, chapter_number: int, source_path: Path | str, *, contract: ChapterContract | None = None) -> tuple[Path, ReviewReport]:
        self.ensure_ready()
        source = Path(source_path).resolve()
        if not source.is_file():
            raise PipelineBlocked(f"正文文件不存在：{source}")
        content = source.read_text(encoding="utf-8")
        if not content.strip():
            raise PipelineBlocked("正文文件为空")

        stored = self.store.get_chapter(book_id, chapter_number)
        if stored:
            imported_contract = ChapterContract(**stored["contract"])
            if contract and contract.to_dict() != imported_contract.to_dict():
                raise PipelineBlocked("导入契约与本地章节契约不一致；请先统一章纲，再导入正文")
            contract = imported_contract
        if contract is None:
            raise PipelineBlocked("本地没有该章节契约；首次导入请同时提供完整章节契约")
        if contract.book_id != book_id or contract.chapter_number != chapter_number:
            raise PipelineBlocked("导入章节的 book_id/chapter_number 与命令参数不一致")

        path = self.store.save_chapter(contract, status="imported", content=content)
        report = self.reviewer.review(contract, content, 0)
        self.store.save_review(report)
        if report.passed:
            self.store.save_canon(book_id, chapter_number, self._canon_delta(contract, content))
        self.store.append_event(book_id, chapter_number, "chapter_ingested", {"source": str(source), "path": str(path), "passed": report.passed})
        return path, report

    def ingest_outline(self, book_id: str, source_path: Path | str, *, output_name: str | None = None) -> Path:
        self.ensure_ready()
        if not self.store.get_book(book_id):
            raise PipelineBlocked(f"book does not exist: {book_id}")
        source = Path(source_path).resolve()
        if not source.is_file():
            raise PipelineBlocked(f"规划文件不存在：{source}")
        raw = source.read_text(encoding="utf-8")
        if not raw.strip():
            raise PipelineBlocked("规划文件为空")
        output_dir = self.store.book_dir(book_id) / "outlines"
        output_dir.mkdir(parents=True, exist_ok=True)
        if source.suffix.lower() == ".json":
            try:
                value = json.loads(raw)
            except json.JSONDecodeError as exc:
                raise PipelineBlocked(f"规划 JSON 无法解析：{exc}") from exc
            if not isinstance(value, list):
                raise PipelineBlocked("章节契约 JSON 必须是数组")
            output = output_dir / "chapters.json"
            output.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        else:
            safe_name = output_name or f"imported-{source.stem}.md"
            if Path(safe_name).name != safe_name or not safe_name.lower().endswith((".md", ".txt")):
                raise PipelineBlocked("规划输出名必须是当前目录下的 .md 或 .txt 文件名")
            output = output_dir / safe_name
            output.write_text(raw.rstrip() + "\n", encoding="utf-8")
        self.store.append_event(book_id, None, "outline_ingested", {"source": str(source), "path": str(output)})
        return output

    def _record_prompt(self, book_id: str | None, chapter_number: int | None, stage: str, prompt_pack, references) -> None:
        self.store.record_skill_run(book_id, chapter_number, stage, prompt_pack.module_chain, self.skill.inspect().skill_version_hash, hashlib.sha256(prompt_pack.render().encode("utf-8")).hexdigest(), references.to_dict() if references else None)

    def _keyword_from_synopsis(self, synopsis: str) -> str | None:
        for keyword in ["弹幕", "系统", "重生", "穿书", "末世", "修仙", "豪门", "校园", "悬疑", "离婚"]:
            if keyword in synopsis:
                return keyword
        return None

    def _reference_type(self, module: str) -> str | None:
        return {
            "plot_logic": "开头钩子",
            "character_consistency": "主角亮相",
            "transition": "结尾余韵",
            "dialogue": "高张力对白",
            "chapter_ending": "结尾余韵",
            "anti_ai_voice": "高张力对白",
        }.get(module)

    def _canon_delta(self, contract: ChapterContract, content: str) -> dict:
        return {
            "chapter_number": contract.chapter_number,
            "last_change": contract.change,
            "current_goal": contract.current_character_goal or contract.objective,
            "relationship_state": contract.relationship_state,
            "body_information_state": contract.body_information_state,
            "open_threads": [contract.unresolved_foreshadowing] if contract.unresolved_foreshadowing else [],
            "last_ending": contract.chapter_hook or contract.next_first_beat,
            "content_fingerprint": hashlib.sha256(content.encode("utf-8")).hexdigest(),
        }
