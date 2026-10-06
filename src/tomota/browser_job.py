from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any

from .models import PublishBatch, PublishResult, utc_now
from .store import ProjectStore
from .book_lock import book_operation


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

    def validated_source(self, batch: PublishBatch, number: int) -> tuple[dict[str, Any], str]:
        """Read once; only this verified body may cross the publication boundary."""
        stored_batch = self.store.get_batch(batch.batch_id)
        if not stored_batch or stored_batch.status == "superseded":
            raise BrowserJobError("publish batch is missing or superseded")
        chapter = self.store.get_chapter(batch.book_id, number)
        if not chapter:
            raise BrowserJobError(f"chapter {number} does not exist")
        content = self.store.read_content(batch.book_id, number)
        source = self.store.approved_review_source(chapter, content=content)
        if source is None:
            raise BrowserJobError(f"chapter {number} lacks current strict approval evidence")
        try:
            path = self.store.book_dir(batch.book_id) / "publish" / f"{batch.batch_id}.preview.json"
            preview = json.loads(path.read_text(encoding="utf-8"))
            planned = next(item for item in preview["chapters"] if item["chapter_number"] == number)
            matches = (preview["batch_id"] == batch.batch_id and preview["book_id"] == batch.book_id
                       and planned.get("review_source") == source
                       and planned["content_fingerprint"] == hashlib.sha256(publication_content(content).encode("utf-8")).hexdigest())
        except (OSError, ValueError, KeyError, TypeError, StopIteration) as exc:
            raise BrowserJobError("publish preview is missing or invalid; prepare a new batch") from exc
        if not matches:
            raise BrowserJobError(f"chapter {number} changed since preview; prepare a new batch")
        return chapter, content

    @book_operation
    def check(self, batch: PublishBatch) -> list[dict[str, Any]]:
        return [{"chapter_number": number, "content_fingerprint": hashlib.sha256(publication_content(self.validated_source(batch, number)[1]).encode("utf-8")).hexdigest()}
                for number in batch.chapter_numbers]

    @book_operation
    def export(self, batch: PublishBatch, *, confirmation: str) -> Path:
        expected = f"PUBLISH {batch.batch_id}"
        if confirmation != expected:
            raise BrowserJobError(f"batch confirmation required: {expected}")

        book = self.store.get_book(batch.book_id)
        if not book:
            raise BrowserJobError(f"book does not exist: {batch.book_id}")

        chapters: list[dict[str, Any]] = []
        for number in batch.chapter_numbers:
            chapter, source_content = self.validated_source(batch, number)
            content = publication_content(source_content)
            if not content.strip():
                raise BrowserJobError(f"chapter {number} has no content")
            chapters.append(
                {
                    "chapter_number": number,
                    "title": chapter["title"],
                    "content": content,
                    "content_fingerprint": hashlib.sha256(content.encode("utf-8")).hexdigest(),
                    "source_fingerprint": hashlib.sha256(source_content.encode("utf-8")).hexdigest(),
                    "scheduled_at": batch.schedule.get(str(number)),
                    "local_platform_id": chapter.get("platform_id"),
                }
            )

        path = self.job_path(batch)
        if path.exists():
            try:
                existing = json.loads(path.read_text(encoding="utf-8"))
                immutable_keys = ("chapter_number", "title", "content", "content_fingerprint", "source_fingerprint")
                previous = [{key: item.get(key) for key in immutable_keys} for item in existing["chapters"]]
                current = [{key: item.get(key) for key in immutable_keys} for item in chapters]
                if existing["batch_id"] != batch.batch_id or existing["book_id"] != batch.book_id or previous != current:
                    raise ValueError("snapshot differs")
            except (OSError, ValueError, KeyError, TypeError) as exc:
                raise BrowserJobError("immutable browser snapshot differs or is invalid; prepare a new batch") from exc
            return path
        if self.result_path(batch).exists() or path.with_suffix(".started.json").exists():
            raise BrowserJobError("original browser snapshot missing after attempt; refusing to recreate")
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

    @book_operation
    def reconcile(self, batch: PublishBatch, result_path: Path | str | None = None) -> PublishResult:
        path = Path(result_path) if result_path else self.result_path(batch)
        if not path.is_file():
            raise BrowserJobError(f"browser result does not exist: {path}")
        try:
            result = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise BrowserJobError(f"invalid browser result: {path}: {exc}") from exc

        if not isinstance(result, dict):
            raise BrowserJobError("browser result must be an object")
        if result.get("batch_id") != batch.batch_id:
            raise BrowserJobError("browser result batch_id does not match the requested batch")
        if type(result.get("schema_version", 2)) is not int or result.get("schema_version", 2) not in {2, 3}:
            raise BrowserJobError("invalid browser result schema")

        stored_batch = self.store.get_batch(batch.batch_id)
        if not stored_batch or stored_batch.status == "superseded" or stored_batch.book_id != batch.book_id:
            raise BrowserJobError("publish batch is missing or superseded")

        allowed = set(batch.chapter_numbers)
        exported: dict[int, dict[str, Any]] | None = None
        seen: set[int] = set()
        validated: list[tuple[int, dict[str, Any], str, str]] = []
        submitted: list[int] = []
        skipped: list[int] = []
        failed: dict[int, str] = {}
        raw_items = result.get("chapters", [])
        if not isinstance(raw_items, list):
            raise BrowserJobError("browser result chapters must be an array")
        for item in raw_items:
            if not isinstance(item, dict):
                raise BrowserJobError("browser result contains a non-object chapter")
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
            item_status = str(item.get("status", "failed"))
            advances = item_status in {"submitted", "updated", "scheduled", "dry_run", "already_exists", "skipped"}
            fingerprints = {key: item[key] for key in ("source_fingerprint", "content_fingerprint") if key in item}
            if advances and not fingerprints:
                raise BrowserJobError(f"browser result is missing a chapter fingerprint: {number}")
            if fingerprints:
                if any(not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value) for value in fingerprints.values()):
                    raise BrowserJobError(f"browser result contains an invalid fingerprint: {number}")
                if exported is None:
                    try:
                        job = json.loads(self.job_path(batch).read_text(encoding="utf-8"))
                        if job["batch_id"] != batch.batch_id or job["book_id"] != batch.book_id:
                            raise ValueError("job identity mismatch")
                        exported = {chapter["chapter_number"]: chapter for chapter in job["chapters"]}
                        if set(exported) != allowed or len(exported) != len(job["chapters"]):
                            raise ValueError("job chapter coverage mismatch")
                    except (OSError, ValueError, KeyError, TypeError) as exc:
                        raise BrowserJobError("exported browser job is missing or invalid") from exc
                planned = exported[number]
                if any(value != planned.get(key) for key, value in fingerprints.items()):
                    raise BrowserJobError(f"browser result fingerprint differs from exported job: chapter {number}")
                # Source Markdown and platform text have different fingerprints.
                # A content-only receipt is valid only when bound to the exported
                # job, whose source fingerprint still matches the current draft.
                content = self.store.read_content(batch.book_id, number)
                source_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
                platform_hash = hashlib.sha256(publication_content(content).encode("utf-8")).hexdigest()
                if (planned.get("source_fingerprint") != local.get("content_hash")
                        or planned.get("source_fingerprint") != source_hash
                        or planned.get("content_fingerprint") != platform_hash):
                    raise BrowserJobError(f"content changed after browser job export: chapter {number}")
            if advances and (result.get("schema_version", 2) >= 3 or job.get("schema_version", 2) >= 3):
                proof = item.get("platform_verification") or {}
                if not isinstance(proof, dict):
                    raise BrowserJobError("invalid browser verification proof")
                planned = (exported or {}).get(number, {})
                remote_id = str(item.get("platform_id", ""))
                clean_content = re.sub(r"[\u200B-\u200D\uFEFF]", "", str(planned.get("content", ""))).replace("\r\n", "\n").replace("\r", "\n")
                normalized = "\n".join(part.strip() for part in re.split(r"\n+", clean_content) if part.strip())
                if planned.get("operation") == "update":
                    ack = item.get("submission_ack") or {}
                    if (not isinstance(ack, dict) or ack != proof.get("submission_ack")
                            or ack.get("kind") != "platform_submit_feedback"
                            or ack.get("platform_work_id") != job.get("platform_work_id")
                            or ack.get("platform_chapter_id") != remote_id
                            or ack.get("chapter_number") != number
                            or ack.get("content_fingerprint") != planned.get("content_fingerprint")
                            or not re.search(r"发布成功|提交成功|修改成功|修改已提交|已提交审核", str(ack.get("evidence", "")))):
                        raise BrowserJobError("replacement receipt lacks final submission acknowledgement")
                if (result.get("book_id") != batch.book_id
                        or item.get("submission_started") is not True
                        or not re.fullmatch(r"\d{10,}", str(job.get("platform_work_id", "")))
                        or not re.fullmatch(r"\d{10,}", remote_id)
                        or proof.get("kind") != "chapter_content"
                        or proof.get("platform_work_id") != job.get("platform_work_id")
                        or proof.get("platform_chapter_id") != remote_id
                        or proof.get("chapter_number") != number
                        or proof.get("title") != planned.get("title")
                        or proof.get("status") not in {"已发布", "审核中", "待审核"}
                        or proof.get("content_fingerprint") != planned.get("content_fingerprint")
                        or proof.get("normalized_content_hash") != hashlib.sha256(normalized.encode("utf-8")).hexdigest()
                        or (planned.get("operation") != "update" and (not isinstance(item.get("preexisting_platform_ids"), list) or remote_id in item["preexisting_platform_ids"]))
                        or (planned.get("operation") == "update" and remote_id != planned.get("platform_chapter_id"))):
                    raise BrowserJobError(f"browser result lacks bound full-content verification: chapter {number}")
            message = str(item.get("message", item.get("reason", "")))
            validated.append((number, item, item_status, message))

        overall = str(result.get("status", "failed"))
        if overall not in {"submitted", "partial", "failed", "blocked", "uncertain", "preview", "auth_required", "ui_mismatch", "human_action_required", "time_window_blocked"}:
            raise BrowserJobError(f"unknown browser result status: {overall}")
        if overall == "submitted" and seen != allowed:
            missing = ", ".join(str(number) for number in sorted(allowed - seen))
            raise BrowserJobError(f"browser result claims submitted but is missing chapters: {missing}")

        # One receipt consumption commits all chapter states, batch state and
        # authoritative DB audit events together. A retry cannot duplicate them.
        for number, item, item_status, message in validated:
            if item_status in {"submitted", "updated", "scheduled", "dry_run"}:
                submitted.append(number)
            elif item_status in {"already_exists", "skipped"}:
                skipped.append(number)
            else:
                failed[number] = message or item_status
        if overall in {"preview", "auth_required", "ui_mismatch", "human_action_required", "time_window_blocked", "blocked", "uncertain"}:
            batch_status = "failed" if not submitted else "partial"
        else:
            batch_status = "submitted" if overall == "submitted" and not failed else ("partial" if submitted or skipped else "failed")
        if stored_batch.status == "submitted" and batch_status != "submitted":
            raise BrowserJobError("stale receipt cannot downgrade a completed batch")
        outcome = PublishResult(batch.batch_id, batch_status, submitted, skipped, failed, str(result.get("message", "")))
        receipt_hash = hashlib.sha256(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
        now = utc_now()
        with self.store.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute("""CREATE TABLE IF NOT EXISTS browser_receipt_consumptions (
                batch_id TEXT NOT NULL, receipt_hash TEXT NOT NULL, result_json TEXT NOT NULL,
                created_at TEXT NOT NULL, PRIMARY KEY(batch_id, receipt_hash),
                FOREIGN KEY(batch_id) REFERENCES publish_batches(id) ON DELETE CASCADE)""")
            prior = connection.execute("SELECT result_json FROM browser_receipt_consumptions WHERE batch_id=? AND receipt_hash=?", (batch.batch_id, receipt_hash)).fetchone()
            if prior:
                saved = json.loads(prior[0])
                saved["failed"] = {int(key): value for key, value in saved["failed"].items()}
                return PublishResult(**saved)
            for number, item, item_status, message in validated:
                if number in submitted or (number in skipped and item.get("platform_id")):
                    connection.execute("UPDATE chapters SET status=?,platform_id=?,scheduled_at=?,updated_at=? WHERE book_id=? AND chapter_number=?",
                        ("dry_run" if item_status == "dry_run" else "submitted", item.get("platform_id"), item.get("scheduled_at"), now, batch.book_id, number))
                event = {"source": "browser", "batch_id": batch.batch_id, "receipt_hash": receipt_hash,
                         "status": item_status, "message": message, "platform_id": item.get("platform_id")}
                connection.execute("INSERT INTO events(book_id,chapter_number,event_type,payload_json,created_at) VALUES(?,?,?,?,?)",
                    (batch.book_id, number, "chapter_status" if number in submitted or number in skipped else "publish_failed", json.dumps(event, ensure_ascii=False), now))
            connection.execute("UPDATE publish_batches SET status=?,updated_at=?,submitted_at=? WHERE id=?",
                (batch_status, now, now if batch_status == "submitted" else None, batch.batch_id))
            connection.execute("INSERT INTO events(book_id,chapter_number,event_type,payload_json,created_at) VALUES(?,?,?,?,?)",
                (batch.book_id, None, "browser_job_reconciled", json.dumps({**outcome.__dict__, "receipt_hash": receipt_hash, "path": str(path)}, ensure_ascii=False), now))
            connection.execute("INSERT INTO browser_receipt_consumptions(batch_id,receipt_hash,result_json,created_at) VALUES(?,?,?,?)",
                (batch.batch_id, receipt_hash, json.dumps(outcome.__dict__, ensure_ascii=False), now))
        return outcome
