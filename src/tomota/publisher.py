from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from .browser_job import BrowserJobManager
from .models import PublishBatch, PublishResult
from .store import ProjectStore


class PublishBlocked(RuntimeError):
    pass


class BrowserDriver(Protocol):
    def is_authenticated(self) -> bool: ...

    def submit_chapter(self, *, book_id: str, chapter_number: int, title: str, content: str, scheduled_at: str | None) -> dict: ...


@dataclass
class DryRunBrowserDriver:
    authenticated: bool = True
    results: dict[int, dict] | None = None

    def is_authenticated(self) -> bool:
        return self.authenticated

    def submit_chapter(self, *, book_id: str, chapter_number: int, title: str, content: str, scheduled_at: str | None) -> dict:
        if not self.authenticated:
            raise PublishBlocked("browser session is not authenticated")
        if self.results and chapter_number in self.results:
            return self.results[chapter_number]
        fingerprint = hashlib.sha256(content.encode("utf-8")).hexdigest()[:16]
        return {"status": "dry_run", "platform_id": f"dry-{book_id}-{chapter_number}", "fingerprint": fingerprint, "scheduled_at": scheduled_at}


class FanqiePublisher:
    """Safe publisher boundary.

    A real browser driver can be attached by the desktop/browser integration.
    This class contains idempotency and confirmation logic but never handles
    passwords, cookies, OTPs, CAPTCHAs, real-name or face verification.
    """

    def __init__(self, store: ProjectStore, driver: BrowserDriver):
        self.store = store
        self.driver = driver
        self.browser_jobs = BrowserJobManager(store)

    def export_browser_job(self, batch: PublishBatch, *, confirmation: str) -> Path:
        """Export a safe local job for the Codex browser bridge."""
        return self.browser_jobs.export(batch, confirmation=confirmation)

    def reconcile_browser_job(self, batch: PublishBatch, result_path: Path | str | None = None) -> PublishResult:
        return self.browser_jobs.reconcile(batch, result_path)

    def prepare_batch(self, book_id: str, chapter_numbers: list[int], schedule: dict[str, str]) -> PublishBatch:
        import uuid
        for number in chapter_numbers:
            chapter = self.store.get_chapter(book_id, number)
            if not chapter:
                raise PublishBlocked(f"chapter {number} does not exist")
            if not self.store.is_release_ready(book_id, number):
                raise PublishBlocked(f"chapter {number} lacks strict approval evidence: {chapter['status']}")
        batch = PublishBatch(f"batch-{uuid.uuid4().hex[:12]}", book_id, chapter_numbers, schedule)
        self.store.create_batch(batch)
        preview = {
            "batch_id": batch.batch_id,
            "book_id": book_id,
            "book_title": (self.store.get_book(book_id) or {}).get("title", ""),
            "status": "preview",
            "chapters": [
                {
                    "chapter_number": number,
                    "title": self.store.get_chapter(book_id, number)["title"],
                    "word_count": self.store.get_chapter(book_id, number)["word_count"],
                    "content_fingerprint": self.store.get_chapter(book_id, number)["content_hash"],
                    "scheduled_at": schedule.get(str(number)),
                }
                for number in chapter_numbers
            ],
            "cloud_write_performed": False,
            "next_confirmation": f"PUBLISH {batch.batch_id}",
        }
        self.store.write_json(self.store.book_dir(book_id) / "publish" / f"{batch.batch_id}.preview.json", preview)
        return batch

    def submit_batch(self, batch: PublishBatch, *, confirmation: str | None = None) -> PublishResult:
        expected = f"PUBLISH {batch.batch_id}"
        if confirmation != expected:
            raise PublishBlocked(f"batch confirmation required: {expected}")
        if not self.driver.is_authenticated():
            raise PublishBlocked("番茄浏览器会话未登录；请在本机官方页面完成登录")
        submitted: list[int] = []
        skipped: list[int] = []
        failed: dict[int, str] = {}
        for number in batch.chapter_numbers:
            chapter = self.store.get_chapter(batch.book_id, number)
            if not chapter:
                failed[number] = "chapter disappeared"
                continue
            if chapter.get("platform_id"):
                skipped.append(number)
                continue
            try:
                response = self.driver.submit_chapter(
                    book_id=batch.book_id,
                    chapter_number=number,
                    title=chapter["title"],
                    content=self.store.read_content(batch.book_id, number),
                    scheduled_at=batch.schedule.get(str(number)),
                )
                status = response.get("status", "submitted")
                self.store.update_chapter_status(batch.book_id, number, "submitted" if status != "dry_run" else "dry_run", platform_id=response.get("platform_id"), scheduled_at=response.get("scheduled_at"))
                submitted.append(number)
            except (PublishBlocked, TimeoutError) as exc:
                failed[number] = str(exc)
                self.store.append_event(batch.book_id, number, "publish_failed", {"error": str(exc)})
                break
            except Exception as exc:  # fail closed and preserve the error
                failed[number] = f"unexpected publisher error: {exc}"
                self.store.append_event(batch.book_id, number, "publish_failed", {"error": str(exc)})
                break
        status = "submitted" if not failed else ("partial" if submitted else "failed")
        self.store.update_batch(batch.batch_id, status)
        return PublishResult(batch.batch_id, status, submitted, skipped, failed, "dry-run completed" if status == "submitted" and any(item.startswith("dry-") for item in [self.store.get_chapter(batch.book_id, n).get("platform_id", "") for n in submitted]) else "")
