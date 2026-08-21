from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any

from .models import PublishBatch, PublishResult, utc_now
from .store import ProjectStore


def publication_content(value: str) -> str:
    """Return the exact body sent to the platform editor.

    Local Markdown keeps a leading H1 for comfortable editing, while Fanqie
    stores the chapter title separately.  Removing only that first heading
    avoids publishing a duplicate ``# 第X章`` line in the body.
    """
    lines = value.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    first = next((index for index, line in enumerate(lines) if line.strip()), None)
    if first is not None and re.match(r"^\s*(?:#{1,6}\s*)?第\s*[一二三四五六七八九十百零〇两\d]+\s*章(?:\s+.*)?$", lines[first]):
        lines.pop(first)
    cleaned: list[str] = []
    for line in lines:
        line = re.sub(r"^\s*#{1,6}\s*", "", line)
        line = re.sub(r"\*\*(.+?)\*\*", r"\1", line)
        line = re.sub(r"__(.+?)__", r"\1", line)
        cleaned.append(line.rstrip())
    return "\n".join(cleaned).strip() + "\n"


class BrowserJobError(RuntimeError):
    """A browser job is invalid or its result cannot be reconciled safely."""


class BrowserJobManager:
    """Create and reconcile a file-based bridge job for the in-app browser.

    The Python process never receives a browser handle, password, cookie, OTP or
    verification code.  It only prepares immutable chapter payloads and consumes
    a result file written by the browser-side bridge.
    """

    def __init__(self, store: ProjectStore):
        self.store = store

    def job_path(self, batch: PublishBatch) -> Path:
        return self.store.book_dir(batch.book_id) / "publish" / "jobs" / f"{batch.batch_id}.json"

    def result_path(self, batch: PublishBatch) -> Path:
        return self.store.book_dir(batch.book_id) / "publish" / "jobs" / f"{batch.batch_id}.result.json"

    def export(self, batch: PublishBatch, *, confirmation: str) -> Path:
        expected = f"PUBLISH {batch.batch_id}"
        if confirmation != expected:
            raise BrowserJobError(f"batch confirmation required: {expected}")

        book = self.store.get_book(batch.book_id)
        if not book:
            raise BrowserJobError(f"book does not exist: {batch.book_id}")

        chapters: list[dict[str, Any]] = []
        for number in batch.chapter_numbers:
            chapter = self.store.get_chapter(batch.book_id, number)
            if not chapter:
                raise BrowserJobError(f"chapter {number} does not exist")
            if not self.store.is_release_ready(batch.book_id, number):
                raise BrowserJobError(f"chapter {number} lacks strict approval evidence: {chapter['status']}")
            source_content = self.store.read_content(batch.book_id, number)
            content = publication_content(source_content)
            if not content.strip():
                raise BrowserJobError(f"chapter {number} has no content")
            chapters.append(
                {
                    "chapter_number": number,
                    "title": chapter["title"],
                    "content": content,
                    # save_chapter records the fingerprint before adding its
                    # storage newline; reuse that canonical local value so a
                    # browser round-trip cannot look like a content change.
                    "content_fingerprint": hashlib.sha256(content.encode("utf-8")).hexdigest(),
                    "source_fingerprint": chapter.get("content_hash") or hashlib.sha256(source_content.encode("utf-8")).hexdigest(),
                    "scheduled_at": batch.schedule.get(str(number)),
                    "local_platform_id": chapter.get("platform_id"),
                }
            )

        path = self.job_path(batch)
        job = {
            "schema_version": 2,
            "kind": "fanqie.publish",
            "created_at": utc_now(),
            "batch_id": batch.batch_id,
            "book_id": batch.book_id,
            "book_title": book["title"],
            "writer_url": "https://fanqienovel.com/main/writer/book-manage",
            "confirmation_required": expected,
            "action_time_confirmation_required": True,
            "account_scope": "works_and_chapter_operations_only",
            "chapters": chapters,
            "result_path": str(self.result_path(batch)),
            "safety": {
                "official_host_only": "fanqienovel.com",
                "never_handle_credentials": True,
                "stop_on_human_verification": True,
                "stop_on_ui_mismatch": True,
                "idempotency": "local_platform_id_or_exact_visible_chapter_match",
                "allowed_operations": ["view_dashboard", "view_works", "create_or_update_target_work", "edit_chapter_draft", "schedule_chapter", "submit_chapter", "publish_chapter", "inspect_review_and_metrics"],
                "forbidden_operations": ["real_name_or_face_verification", "contracts_or_copyright", "earnings_bank_tax_withdrawal", "password_phone_devices_security", "delete_work_or_published_chapter"],
                "confirm_before_each_cloud_write": True,
                "never_delete_cloud_content_automatically": True,
            },
        }
        self.store.write_json(path, job)
        self.store.append_event(batch.book_id, None, "browser_job_exported", {"batch_id": batch.batch_id, "path": str(path), "chapter_count": len(chapters)})
        return path

    def reconcile(self, batch: PublishBatch, result_path: Path | str | None = None) -> PublishResult:
        path = Path(result_path) if result_path else self.result_path(batch)
        if not path.is_file():
            raise BrowserJobError(f"browser result does not exist: {path}")
        try:
            result = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise BrowserJobError(f"invalid browser result: {path}: {exc}") from exc

        if result.get("batch_id") != batch.batch_id:
            raise BrowserJobError("browser result batch_id does not match the requested batch")

        allowed = set(batch.chapter_numbers)
        seen: set[int] = set()
        submitted: list[int] = []
        skipped: list[int] = []
        failed: dict[int, str] = {}
        for item in result.get("chapters", []):
            try:
                number = int(item["chapter_number"])
            except (KeyError, TypeError, ValueError) as exc:
                raise BrowserJobError("browser result contains an invalid chapter number") from exc
            if number not in allowed:
                raise BrowserJobError(f"browser result contains chapter outside batch: {number}")
            if number in seen:
                raise BrowserJobError(f"browser result contains duplicate chapter: {number}")
            seen.add(number)

            local = self.store.get_chapter(batch.book_id, number)
            if not local:
                raise BrowserJobError(f"local chapter disappeared: {number}")
            remote_fingerprint = item.get("source_fingerprint") or item.get("content_fingerprint")
            if remote_fingerprint and remote_fingerprint != local.get("content_hash"):
                raise BrowserJobError(f"content changed after browser job export: chapter {number}")

            item_status = str(item.get("status", "failed"))
            message = str(item.get("message", item.get("reason", "")))
            if item_status in {"submitted", "updated", "scheduled", "dry_run"}:
                self.store.update_chapter_status(
                    batch.book_id,
                    number,
                    "submitted" if item_status != "dry_run" else "dry_run",
                    platform_id=item.get("platform_id"),
                    scheduled_at=item.get("scheduled_at"),
                )
                submitted.append(number)
            elif item_status in {"already_exists", "skipped"}:
                if item.get("platform_id"):
                    self.store.update_chapter_status(batch.book_id, number, "submitted", platform_id=item["platform_id"], scheduled_at=item.get("scheduled_at"))
                skipped.append(number)
            else:
                failed[number] = message or item_status
                self.store.append_event(batch.book_id, number, "publish_failed", {"source": "browser", "status": item_status, "message": message})

        overall = str(result.get("status", "failed"))
        if overall not in {"submitted", "partial", "failed", "blocked", "uncertain", "preview", "auth_required", "ui_mismatch", "human_action_required", "time_window_blocked"}:
            raise BrowserJobError(f"unknown browser result status: {overall}")
        if overall == "submitted" and seen != allowed:
            missing = ", ".join(str(number) for number in sorted(allowed - seen))
            raise BrowserJobError(f"browser result claims submitted but is missing chapters: {missing}")
        if overall in {"preview", "auth_required", "ui_mismatch", "human_action_required", "time_window_blocked", "blocked", "uncertain"}:
            batch_status = "failed" if not submitted else "partial"
        else:
            batch_status = "submitted" if overall == "submitted" and not failed else ("partial" if submitted or skipped else "failed")
        self.store.update_batch(batch.batch_id, batch_status)
        self.store.append_event(batch.book_id, None, "browser_job_reconciled", {"batch_id": batch.batch_id, "path": str(path), "status": overall, "submitted": submitted, "skipped": skipped, "failed": failed})
        return PublishResult(batch.batch_id, batch_status, submitted, skipped, failed, str(result.get("message", "")))
