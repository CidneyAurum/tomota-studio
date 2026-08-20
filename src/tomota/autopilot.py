from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

from .models import ChapterContract
from .pipeline import PipelineBlocked, TomotaPipeline
from .publisher import DryRunBrowserDriver, FanqiePublisher
from .scheduler import Scheduler


class AutopilotRunner:
    """Run a complete chapter queue as one resumable job.

    The important behavior here is that a missing model runtime is collected
    once as a single handoff.  The runner never stops after chapter 1 merely
    because the default PromptOnlyGenerator was selected.
    """

    def __init__(self, pipeline: TomotaPipeline):
        self.pipeline = pipeline

    def run(
        self,
        book_id: str,
        contracts: Iterable[ChapterContract],
        *,
        max_revisions: int = 3,
        prepare_release: bool = True,
        chapters_per_day: int | None = None,
        buffer_days: int | None = None,
    ) -> dict:
        self.pipeline.ensure_ready()
        if not self.pipeline.store.get_book(book_id):
            raise PipelineBlocked(f"book does not exist: {book_id}")

        queue = sorted(list(contracts), key=lambda item: item.chapter_number)
        self._validate_queue(book_id, queue)
        run_id = datetime.now(timezone.utc).strftime("autopilot-%Y%m%dT%H%M%SZ")
        self.pipeline.store.append_event(book_id, None, "autopilot_started", {
            "run_id": run_id,
            "chapters": [item.chapter_number for item in queue],
            "max_revisions": max_revisions,
        })

        result = {
            "run_id": run_id,
            "book_id": book_id,
            "status": "completed",
            "processed": [],
            "skipped": [],
            "blocked": [],
            "pending_external_generation": [],
            "release": None,
        }
        prompt_files: list[Path] = []
        release_candidates: list[int] = []

        for contract in queue:
            existing = self.pipeline.store.get_chapter(book_id, contract.chapter_number)
            if existing and existing["status"] in {"approved", "scheduled", "submitted", "published"}:
                result["skipped"].append({"chapter": contract.chapter_number, "status": existing["status"]})
                if existing["status"] == "approved":
                    release_candidates.append(contract.chapter_number)
                continue
            try:
                path, report = self.pipeline.draft(contract, max_revisions=max_revisions)
                result["processed"].append({
                    "chapter": contract.chapter_number,
                    "path": str(path),
                    "passed": report.passed,
                    "review": str(self.pipeline.store.book_dir(book_id) / "reviews" / f"chapter-{contract.chapter_number:04d}.md"),
                })
                if not report.passed:
                    result["blocked"].append({"chapter": contract.chapter_number, "reason": "consistency_review 未通过"})
                elif report.passed:
                    release_candidates.append(contract.chapter_number)
            except PipelineBlocked as exc:
                message = str(exc)
                item = {"chapter": contract.chapter_number, "reason": message}
                result["blocked"].append(item)
                prompt_path = self.pipeline.store.book_dir(book_id) / "drafts" / f"chapter-{contract.chapter_number:04d}.prompt.md"
                revision_prompt = self.pipeline.store.book_dir(book_id) / "drafts" / f"chapter-{contract.chapter_number:04d}.revision-1.prompt.md"
                if prompt_path.is_file():
                    prompt_files.append(prompt_path)
                    result["pending_external_generation"].append({"chapter": contract.chapter_number, "prompt": str(prompt_path)})
                elif revision_prompt.is_file():
                    prompt_files.append(revision_prompt)
                    result["pending_external_generation"].append({"chapter": contract.chapter_number, "prompt": str(revision_prompt)})

        if prompt_files:
            handoff = self._write_handoff(book_id, run_id, prompt_files, result)
            result["handoff"] = str(handoff)
            result["status"] = "waiting_for_model_runtime"
        elif result["blocked"]:
            result["status"] = "blocked"
        # Prompt-only and blocked runs are not release preparation.  A batch is
        # produced only when the whole requested queue completed strict gates.
        if prepare_release and release_candidates and not prompt_files and not result["blocked"]:
            result["release"] = self._prepare_release(book_id, sorted(set(release_candidates)), chapters_per_day, buffer_days)

        self.pipeline.store.append_event(book_id, None, "autopilot_finished", result)
        report_path = self.pipeline.store.book_dir(book_id) / "audit" / f"{run_id}.json"
        self.pipeline.store.write_json(report_path, result)
        result["report"] = str(report_path)
        return result

    def _validate_queue(self, book_id: str, queue: list[ChapterContract]) -> None:
        seen: set[int] = set()
        for contract in queue:
            if contract.book_id != book_id:
                raise PipelineBlocked(f"章节 {contract.chapter_number} 的 book_id 不匹配")
            if contract.chapter_number <= 0:
                raise PipelineBlocked("章节编号必须大于 0")
            if contract.chapter_number in seen:
                raise PipelineBlocked(f"章节契约重复：{contract.chapter_number}")
            seen.add(contract.chapter_number)
            missing = [
                name for name in ("title", "objective", "obstacle", "change", "next_first_beat")
                if not getattr(contract, name).strip()
            ]
            if missing:
                raise PipelineBlocked(f"第 {contract.chapter_number} 章契约缺少：{', '.join(missing)}")

    def _write_handoff(self, book_id: str, run_id: str, prompt_files: list[Path], result: dict) -> Path:
        path = self.pipeline.store.book_dir(book_id) / "audit" / f"{run_id}.handoff.md"
        lines = [
            f"# Tomota 自动驾驶交接包：{run_id}",
            "",
            "本批次已完成 skill 路由、模块加载、结构参考检索和任务排队。",
            "当前环境没有可供本地进程调用的模型运行时；请配置 TOMOTA_GENERATOR_COMMAND 或 OPENAI_API_KEY 后重新执行同一个 autopilot 命令。",
            "系统不会把这一批拆成逐章人工操作。",
            "",
        ]
        for item, prompt_path in zip(result["pending_external_generation"], prompt_files):
            lines.extend([
                f"- 第 {item['chapter']} 章：`{prompt_path}`（{prompt_path.stat().st_size} bytes）",
            ])
        lines.extend(["", "交接包只保留索引，不重复嵌入完整 PromptPack。"])
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
        return path

    def _prepare_release(self, book_id: str, chapters: list[int], chapters_per_day: int | None, buffer_days: int | None) -> dict:
        book = self.pipeline.store.get_book(book_id) or {}
        metadata = book.get("metadata", {})
        per_day = chapters_per_day or int(metadata.get("chapters_per_day", 2))
        buffer = buffer_days or int(metadata.get("buffer_days", 7))
        schedule = Scheduler(per_day, buffer).build_schedule(chapters)
        publisher = FanqiePublisher(self.pipeline.store, DryRunBrowserDriver())
        batch = publisher.prepare_batch(book_id, chapters, schedule)
        return {
            "batch_id": batch.batch_id,
            "chapters": chapters,
            "schedule": schedule,
            "confirmation": f"PUBLISH {batch.batch_id}",
            "mode": "prepared_only",
        }


def load_contracts(path: Path, book_id: str) -> list[ChapterContract]:
    if not path.is_file():
        raise PipelineBlocked(f"章节契约文件不存在：{path}")
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise PipelineBlocked(f"章节契约 JSON 无法解析：{exc}") from exc
    if not isinstance(raw, list):
        raise PipelineBlocked("章节契约文件必须是 JSON 数组")
    try:
        return [ChapterContract(book_id=book_id, **item) for item in raw]
    except (TypeError, ValueError) as exc:
        raise PipelineBlocked(f"章节契约字段错误：{exc}") from exc
