from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from pathlib import Path
from typing import Any, Iterable

try:
    import yaml
except ImportError:  # pragma: no cover
    yaml = None

from .models import ChapterContract, PublishBatch, ReviewReport, WorkflowRun, utc_now


class ClosingConnection(sqlite3.Connection):
    """Make `with store.connect()` close the handle on Windows as expected."""

    def __exit__(self, exc_type, exc_value, traceback):
        try:
            return super().__exit__(exc_type, exc_value, traceback)
        finally:
            self.close()


class ProjectStore:
    def __init__(self, project_root: Path | str):
        self.root = Path(project_root).resolve()
        self.db_path = self.root / "tomota.db"

    def initialize(self) -> None:
        for directory in ["config", "library/modules", "library/templates", "library/references", "library/platform", "books", "audit", "tests"]:
            (self.root / directory).mkdir(parents=True, exist_ok=True)
        with self.connect() as connection:
            connection.executescript(
                """
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS books (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    metadata_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS chapters (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    book_id TEXT NOT NULL,
                    chapter_number INTEGER NOT NULL,
                    title TEXT NOT NULL,
                    status TEXT NOT NULL,
                    path TEXT,
                    contract_json TEXT NOT NULL,
                    content_hash TEXT,
                    word_count INTEGER NOT NULL DEFAULT 0,
                    review_path TEXT,
                    platform_id TEXT,
                    scheduled_at TEXT,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(book_id, chapter_number),
                    FOREIGN KEY(book_id) REFERENCES books(id)
                );
                CREATE TABLE IF NOT EXISTS canon_snapshots (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    book_id TEXT NOT NULL,
                    chapter_number INTEGER NOT NULL,
                    snapshot_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(book_id) REFERENCES books(id)
                );
                CREATE TABLE IF NOT EXISTS publish_batches (
                    id TEXT PRIMARY KEY,
                    book_id TEXT NOT NULL,
                    chapter_numbers_json TEXT NOT NULL,
                    schedule_json TEXT NOT NULL,
                    status TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    submitted_at TEXT,
                    FOREIGN KEY(book_id) REFERENCES books(id)
                );
                CREATE TABLE IF NOT EXISTS events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    book_id TEXT,
                    chapter_number INTEGER,
                    event_type TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS skill_runs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    book_id TEXT,
                    chapter_number INTEGER,
                    stage TEXT NOT NULL,
                    module_chain_json TEXT NOT NULL,
                    skill_hash TEXT NOT NULL,
                    prompt_hash TEXT,
                    references_json TEXT,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS workflow_runs (
                    id TEXT PRIMARY KEY,
                    book_id TEXT NOT NULL,
                    state_json TEXT NOT NULL,
                    status TEXT NOT NULL,
                    current_chapter INTEGER,
                    current_stage TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY(book_id) REFERENCES books(id)
                );
                """
            )

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path, factory=ClosingConnection)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        return connection

    def create_book(self, book_id: str, title: str, metadata: dict[str, Any]) -> Path:
        self.initialize()
        now = utc_now()
        metadata = {
            "author": "",
            "synopsis": "",
            "genre": "",
            "target_platform": "番茄小说",
            "chapters_per_day": 2,
            "buffer_days": 7,
            "completion_mode": "open_ended",
            "target_chapters": None,
            **metadata,
        }
        with self.connect() as connection:
            connection.execute(
                "INSERT INTO books(id,title,metadata_json,created_at,updated_at) VALUES(?,?,?,?,?)",
                (book_id, title, json.dumps(metadata, ensure_ascii=False), now, now),
            )
        directory = self.book_dir(book_id)
        for child in ["canon", "outlines", "drafts", "reviews", "publish", "audit", "workflow", ".trash"]:
            (directory / child).mkdir(parents=True, exist_ok=True)
        manifest = {"book_id": book_id, "title": title, **metadata, "created_at": now}
        self.write_structured(directory / "book.yaml", manifest)
        self.write_json(directory / "canon" / "current.json", {"chapter_number": 0, "characters": [], "facts": [], "relationships": [], "open_threads": [], "inventory": [], "locations": [], "timeline": []})
        self.write_json(directory / "outlines" / "master.json", {
            "version": 1,
            "completion_mode": metadata.get("completion_mode", "open_ended"),
            "target_chapters": metadata.get("target_chapters"),
            "premise": metadata.get("synopsis", ""),
            "core_conflict": "",
            "ending_direction": "未锁定",
            "major_beats": [],
            "volumes": [],
            "rolling_plan": {"window_size": 5, "planned_through": 0},
            "updated_at": now,
        })
        self.write_json(directory / "outlines" / "chapters.json", [])
        self.append_event(book_id, None, "book_created", manifest)
        return directory

    def index_existing_books(self) -> dict[str, Any]:
        """Register filesystem projects without moving or rewriting their assets.

        Studio calls this only after creating its database backup and inventory
        manifest. Existing database rows always win; missing legacy chapters are
        indexed as unreviewed so they cannot accidentally enter a release batch.
        """
        self.initialize()
        added_books: list[str] = []
        updated_books: list[str] = []
        added_chapters: dict[str, list[int]] = {}
        updated_chapters: dict[str, list[int]] = {}
        invalidated_chapters: dict[str, list[int]] = {}
        books_root = self.root / "books"
        for directory in sorted(books_root.iterdir() if books_root.is_dir() else []):
            if not directory.is_dir() or directory.is_symlink():
                continue
            book_id = directory.name
            if not re.fullmatch(r"[A-Za-z0-9_-]+", book_id):
                continue
            manifest_path = directory / "book.yaml"
            manifest: dict[str, Any] = {}
            if manifest_path.is_file():
                try:
                    raw = manifest_path.read_text(encoding="utf-8")
                    manifest = yaml.safe_load(raw) if yaml else json.loads(raw)
                    if not isinstance(manifest, dict):
                        manifest = {}
                except (OSError, ValueError, json.JSONDecodeError):
                    manifest = {}
            title = str(manifest.get("title") or book_id).strip()
            now = utc_now()
            metadata = {key: value for key, value in manifest.items() if key not in {"book_id", "title", "created_at"}}
            existing_book = self.get_book(book_id)
            if not existing_book:
                with self.connect() as connection:
                    connection.execute(
                        "INSERT INTO books(id,title,metadata_json,created_at,updated_at) VALUES(?,?,?,?,?)",
                        (book_id, title, json.dumps(metadata, ensure_ascii=False), str(manifest.get("created_at") or now), now),
                    )
                added_books.append(book_id)
            elif title != existing_book["title"] or metadata != existing_book["metadata"]:
                with self.connect() as connection:
                    connection.execute(
                        "UPDATE books SET title=?,metadata_json=?,updated_at=? WHERE id=?",
                        (title, json.dumps(metadata, ensure_ascii=False), now, book_id),
                    )
                updated_books.append(book_id)
            outline_path = directory / "outlines" / "chapters.json"
            if not outline_path.is_file():
                continue
            try:
                outline = json.loads(outline_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if not isinstance(outline, list):
                continue
            for item in outline:
                if not isinstance(item, dict):
                    continue
                try:
                    number = int(item.get("chapter_number", 0))
                except (TypeError, ValueError):
                    continue
                if number <= 0:
                    continue
                contract = {"book_id": book_id, **item}
                chapter_title = str(item.get("title") or f"第 {number} 章")
                draft_path = directory / "drafts" / f"chapter-{number:04d}.md"
                content = draft_path.read_text(encoding="utf-8") if draft_path.is_file() else ""
                content_hash = hashlib.sha256(content.encode("utf-8")).hexdigest() if content else None
                word_count = sum(1 for char in content if not char.isspace())
                existing_chapter = self.get_chapter(book_id, number)
                if existing_chapter:
                    contract_changed = existing_chapter["contract"] != contract or existing_chapter["title"] != chapter_title
                    content_changed = bool(content) and existing_chapter.get("content_hash") != content_hash
                    current_status = str(existing_chapter["status"])
                    status_needs_normalization = bool(content) and current_status in {"planned", "prompt_ready", "legacy_unreviewed"} and current_status != "draft_unreviewed"
                    if contract_changed or content_changed or status_needs_normalization:
                        status = current_status
                        review_path = existing_chapter.get("review_path")
                        if content_changed and status in {"approved", "reviewed_pending_approval"}:
                            status = "modified_after_review"
                            review_path = None
                            invalidated_chapters.setdefault(book_id, []).append(number)
                        elif content and status in {"planned", "prompt_ready", "legacy_unreviewed"}:
                            status = "draft_unreviewed"
                        with self.connect() as connection:
                            connection.execute(
                                """
                                UPDATE chapters SET title=?,contract_json=?,status=?,path=?,content_hash=?,word_count=?,review_path=?,updated_at=?
                                WHERE book_id=? AND chapter_number=?
                                """,
                                (chapter_title, json.dumps(contract, ensure_ascii=False), status, str(draft_path) if content else existing_chapter.get("path") or "", content_hash if content else existing_chapter.get("content_hash"), word_count if content else existing_chapter.get("word_count", 0), review_path, now, book_id, number),
                            )
                        updated_chapters.setdefault(book_id, []).append(number)
                    continue
                with self.connect() as connection:
                    connection.execute(
                        """
                        INSERT INTO chapters(book_id,chapter_number,title,status,path,contract_json,content_hash,word_count,created_at,updated_at)
                        VALUES(?,?,?,?,?,?,?,?,?,?)
                        """,
                        (book_id, number, chapter_title, "draft_unreviewed" if content else "prompt_ready", str(draft_path) if content else "", json.dumps(contract, ensure_ascii=False), content_hash, word_count, now, now),
                    )
                added_chapters.setdefault(book_id, []).append(number)
        if added_books or updated_books or added_chapters or updated_chapters:
            self.append_event(None, None, "studio_filesystem_sync", {
                "added_books": added_books, "updated_books": updated_books,
                "added_chapters": added_chapters, "updated_chapters": updated_chapters,
                "invalidated_chapters": invalidated_chapters, "files_rewritten": False,
            })
        return {
            "added_books": added_books, "updated_books": updated_books,
            "added_chapters": added_chapters, "updated_chapters": updated_chapters,
            "invalidated_chapters": invalidated_chapters, "files_rewritten": False,
        }

    def book_dir(self, book_id: str) -> Path:
        return self.root / "books" / book_id

    def get_book(self, book_id: str) -> dict[str, Any] | None:
        if not self.db_path.is_file():
            return None
        with self.connect() as connection:
            row = connection.execute("SELECT * FROM books WHERE id=?", (book_id,)).fetchone()
        if not row:
            return None
        result = dict(row)
        result["metadata"] = json.loads(result.pop("metadata_json"))
        return result

    def update_book_title(self, book_id: str, title: str) -> None:
        """Rename a local work and keep its manifest and audit trail aligned."""
        clean_title = title.strip()
        if not clean_title:
            raise ValueError("book title cannot be empty")
        with self.connect() as connection:
            cursor = connection.execute(
                "UPDATE books SET title=?,updated_at=? WHERE id=?",
                (clean_title, utc_now(), book_id),
            )
        if cursor.rowcount != 1:
            raise ValueError(f"book does not exist: {book_id}")
        manifest_path = self.book_dir(book_id) / "book.yaml"
        if manifest_path.is_file():
            raw = manifest_path.read_text(encoding="utf-8")
            if yaml:
                manifest = yaml.safe_load(raw)
                if isinstance(manifest, dict):
                    manifest["title"] = clean_title
                    self.write_structured(manifest_path, manifest)
            else:
                updated = re.sub(r"(?m)^title:\s*.*$", f"title: {clean_title}", raw, count=1)
                if updated == raw:
                    raise ValueError("book manifest is missing title")
                manifest_path.write_text(updated, encoding="utf-8")
        self.append_event(book_id, None, "book_title_updated", {"title": clean_title})

    def update_book(self, book_id: str, *, title: str, metadata: dict[str, Any]) -> dict[str, Any]:
        clean_title = title.strip()
        if not clean_title:
            raise ValueError("book title cannot be empty")
        existing = self.get_book(book_id)
        if not existing:
            raise ValueError(f"book does not exist: {book_id}")
        clean_metadata = {**existing["metadata"], **metadata}
        mode = str(clean_metadata.get("completion_mode") or "open_ended")
        if mode not in {"open_ended", "fixed"}:
            raise ValueError("completion_mode must be open_ended or fixed")
        clean_metadata["completion_mode"] = mode
        if mode == "open_ended":
            clean_metadata["target_chapters"] = None
            clean_metadata.pop("total_chapters", None)
        else:
            target = int(clean_metadata.get("target_chapters") or 0)
            if target <= 0:
                raise ValueError("fixed completion mode requires target_chapters")
            clean_metadata["target_chapters"] = target
            clean_metadata.pop("total_chapters", None)
        now = utc_now()
        with self.connect() as connection:
            connection.execute(
                "UPDATE books SET title=?,metadata_json=?,updated_at=? WHERE id=?",
                (clean_title, json.dumps(clean_metadata, ensure_ascii=False), now, book_id),
            )
        manifest_path = self.book_dir(book_id) / "book.yaml"
        manifest = {
            "book_id": book_id, "title": clean_title, **clean_metadata,
            "created_at": existing.get("created_at") or now,
        }
        self.write_structured(manifest_path, manifest)
        self.append_event(book_id, None, "book_metadata_updated", {"title": clean_title, "fields": sorted(metadata)})
        return self.get_book(book_id) or {}

    def load_master_outline(self, book_id: str) -> dict[str, Any]:
        path = self.book_dir(book_id) / "outlines" / "master.json"
        if path.is_file():
            try:
                value = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(value, dict):
                    if not value.get("volumes") and self.list_chapters(book_id):
                        value["volumes"] = [{
                            "volume_id": "volume-1", "title": "第一卷", "objective": "",
                            "main_conflict": "", "character_change": "", "foreshadowing": "", "ending": "",
                        }]
                    return value
            except (OSError, json.JSONDecodeError):
                pass
        book = self.get_book(book_id) or {"metadata": {}}
        metadata = book.get("metadata", {})
        chapters = self.list_chapters(book_id)
        return {
            "version": 1,
            "completion_mode": metadata.get("completion_mode", "open_ended"),
            "target_chapters": metadata.get("target_chapters"),
            "premise": metadata.get("synopsis", ""),
            "core_conflict": "",
            "ending_direction": "未锁定",
            "major_beats": [],
            "volumes": ([{
                "volume_id": "volume-1", "title": "第一卷", "objective": "",
                "main_conflict": "", "character_change": "", "foreshadowing": "", "ending": "",
            }] if chapters else []),
            "rolling_plan": {"window_size": 5, "planned_through": max((int(item["chapter_number"]) for item in chapters), default=0)},
        }

    def save_master_outline(self, book_id: str, value: dict[str, Any]) -> dict[str, Any]:
        if not self.get_book(book_id):
            raise ValueError(f"book does not exist: {book_id}")
        if not isinstance(value, dict):
            raise ValueError("master outline must be an object")
        mode = str(value.get("completion_mode") or "open_ended")
        if mode not in {"open_ended", "fixed"}:
            raise ValueError("completion_mode must be open_ended or fixed")
        rolling = value.get("rolling_plan") if isinstance(value.get("rolling_plan"), dict) else {}
        window_size = int(rolling.get("window_size") or 5)
        if not 1 <= window_size <= 20:
            raise ValueError("rolling plan window_size must be between 1 and 20")
        saved = {
            "version": 1,
            "completion_mode": mode,
            "target_chapters": int(value.get("target_chapters")) if mode == "fixed" and value.get("target_chapters") else None,
            "premise": str(value.get("premise") or "").strip(),
            "core_conflict": str(value.get("core_conflict") or "").strip(),
            "ending_direction": str(value.get("ending_direction") or "未锁定").strip(),
            "major_beats": [str(item).strip() for item in value.get("major_beats", []) if str(item).strip()],
            "volumes": [
                {
                    "volume_id": str(item.get("volume_id") or f"volume-{index + 1}").strip(),
                    "title": str(item.get("title") or f"第 {index + 1} 卷").strip(),
                    "objective": str(item.get("objective") or "").strip(),
                    "main_conflict": str(item.get("main_conflict") or "").strip(),
                    "character_change": str(item.get("character_change") or "").strip(),
                    "foreshadowing": str(item.get("foreshadowing") or "").strip(),
                    "ending": str(item.get("ending") or "").strip(),
                }
                for index, item in enumerate(value.get("volumes", [])) if isinstance(item, dict)
            ],
            "rolling_plan": {**rolling, "window_size": window_size},
            "updated_at": utc_now(),
        }
        if mode == "fixed" and not saved["target_chapters"]:
            raise ValueError("fixed completion mode requires target_chapters")
        self.write_json(self.book_dir(book_id) / "outlines" / "master.json", saved)
        book = self.get_book(book_id) or {"title": book_id, "metadata": {}}
        self.update_book(book_id, title=str(book["title"]), metadata={
            "completion_mode": mode,
            "target_chapters": saved["target_chapters"],
        })
        self.append_event(book_id, None, "master_outline_updated", {"completion_mode": mode, "rolling_window": window_size})
        return saved

    def save_outline_chapters(self, book_id: str, values: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if not self.get_book(book_id):
            raise ValueError(f"book does not exist: {book_id}")
        if not isinstance(values, list):
            raise ValueError("chapters must be a list")
        contracts: list[ChapterContract] = []
        seen: set[int] = set()
        for raw in values:
            if not isinstance(raw, dict):
                raise ValueError("each chapter outline must be an object")
            number = int(raw.get("chapter_number") or 0)
            if number <= 0 or number in seen:
                raise ValueError("chapter_number must be a unique positive integer")
            seen.add(number)
            contracts.append(ChapterContract(
                book_id=book_id,
                chapter_number=number,
                title=str(raw.get("title") or f"第 {number} 章").strip(),
                objective=str(raw.get("objective") or "待规划").strip(),
                obstacle=str(raw.get("obstacle") or "待规划").strip(),
                change=str(raw.get("change") or "待规划").strip(),
                volume_id=str(raw.get("volume_id") or "volume-1").strip(),
                new_information=str(raw.get("new_information") or "").strip(),
                chapter_hook=str(raw.get("chapter_hook") or "").strip(),
                previous_force=str(raw.get("previous_force") or "").strip(),
                next_first_beat=str(raw.get("next_first_beat") or "待规划").strip(),
                current_character_goal=str(raw.get("current_character_goal") or "").strip(),
                relationship_state=str(raw.get("relationship_state") or "").strip(),
                body_information_state=str(raw.get("body_information_state") or "").strip(),
                unresolved_foreshadowing=str(raw.get("unresolved_foreshadowing") or "").strip(),
                ending_type=str(raw.get("ending_type") or "").strip(),
                target_word_count=max(500, min(10_000, int(raw.get("target_word_count") or 2500))),
                problem_tags=[str(item).strip() for item in raw.get("problem_tags", []) if str(item).strip()],
            ))
        payload = []
        for contract in sorted(contracts, key=lambda item: item.chapter_number):
            row = contract.to_dict()
            row.pop("book_id", None)
            payload.append(row)
            if self.get_chapter(book_id, contract.chapter_number):
                self.update_chapter_contract(contract)
            else:
                self.update_or_create_prompt_chapter(contract)
        self.write_json(self.book_dir(book_id) / "outlines" / "chapters.json", payload)
        self.append_event(book_id, None, "chapter_outline_updated", {"chapters": [item.chapter_number for item in contracts]})
        return payload

    def save_chapter(self, contract: ChapterContract, *, status: str = "drafted", content: str = "") -> Path:
        self.initialize()
        directory = self.book_dir(contract.book_id)
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / "drafts" / f"chapter-{contract.chapter_number:04d}.md"
        normalized_content = content.rstrip() + "\n" if content else ""
        if content:
            path.write_text(normalized_content, encoding="utf-8")
        content_hash = hashlib.sha256(normalized_content.encode("utf-8")).hexdigest() if content else None
        word_count = len([part for part in content.split() if part]) if content else 0
        # Chinese characters are the useful unit for web-novel length.
        word_count = sum(1 for char in content if not char.isspace()) if content else word_count
        now = utc_now()
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO chapters(book_id,chapter_number,title,status,path,contract_json,content_hash,word_count,created_at,updated_at)
                VALUES(?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(book_id,chapter_number) DO UPDATE SET
                    title=excluded.title,status=excluded.status,path=excluded.path,contract_json=excluded.contract_json,
                    content_hash=excluded.content_hash,word_count=excluded.word_count,updated_at=excluded.updated_at
                """,
                (contract.book_id, contract.chapter_number, contract.title, status, str(path), json.dumps(contract.to_dict(), ensure_ascii=False), content_hash, word_count, now, now),
            )
        self.append_event(contract.book_id, contract.chapter_number, "chapter_saved", {"status": status, "path": str(path), "word_count": word_count})
        return path

    def update_or_create_prompt_chapter(self, contract: ChapterContract) -> None:
        self.initialize()
        now = utc_now()
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO chapters(book_id,chapter_number,title,status,path,contract_json,created_at,updated_at)
                VALUES(?,?,?,?,?,?,?,?)
                ON CONFLICT(book_id,chapter_number) DO UPDATE SET
                    title=excluded.title,status=excluded.status,contract_json=excluded.contract_json,updated_at=excluded.updated_at
                """,
                (contract.book_id, contract.chapter_number, contract.title, "prompt_ready", "", json.dumps(contract.to_dict(), ensure_ascii=False), now, now),
            )
        self.append_event(contract.book_id, contract.chapter_number, "prompt_chapter_ready", {"status": "prompt_ready"})

    def get_chapter(self, book_id: str, chapter_number: int) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute("SELECT * FROM chapters WHERE book_id=? AND chapter_number=?", (book_id, chapter_number)).fetchone()
        if not row:
            return None
        result = dict(row)
        result["contract"] = json.loads(result.pop("contract_json"))
        return result

    def list_chapters(self, book_id: str) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute("SELECT * FROM chapters WHERE book_id=? ORDER BY chapter_number", (book_id,)).fetchall()
        result = []
        for row in rows:
            item = dict(row)
            item["contract"] = json.loads(item.pop("contract_json"))
            result.append(item)
        return result

    def update_chapter_status(self, book_id: str, chapter_number: int, status: str, **fields: Any) -> None:
        allowed = {"review_path", "platform_id", "scheduled_at", "attempts"}
        fields = {key: value for key, value in fields.items() if key in allowed}
        assignments = ["status=?", "updated_at=?"]
        values: list[Any] = [status, utc_now()]
        for key, value in fields.items():
            assignments.append(f"{key}=?")
            values.append(value)
        values.extend([book_id, chapter_number])
        with self.connect() as connection:
            connection.execute(f"UPDATE chapters SET {', '.join(assignments)} WHERE book_id=? AND chapter_number=?", values)
        self.append_event(book_id, chapter_number, "chapter_status", {"status": status, **fields})

    def update_chapter_contract(self, contract: ChapterContract) -> None:
        with self.connect() as connection:
            connection.execute(
                "UPDATE chapters SET title=?,contract_json=?,updated_at=? WHERE book_id=? AND chapter_number=?",
                (contract.title, json.dumps(contract.to_dict(), ensure_ascii=False), utc_now(), contract.book_id, contract.chapter_number),
            )
        self.append_event(contract.book_id, contract.chapter_number, "chapter_contract_updated", {"title": contract.title})

    def read_content(self, book_id: str, chapter_number: int) -> str:
        chapter = self.get_chapter(book_id, chapter_number)
        if not chapter or not chapter.get("path"):
            return ""
        path = Path(chapter["path"])
        return path.read_text(encoding="utf-8") if path.is_file() else ""

    def is_release_ready(self, book_id: str, chapter_number: int) -> bool:
        chapter = self.get_chapter(book_id, chapter_number)
        if not chapter or chapter.get("status") not in {"approved", "scheduled", "submitted", "published"} or not chapter.get("review_path"):
            return False
        review_path = Path(chapter["review_path"])
        if not review_path.is_file():
            return False
        try:
            value = json.loads(review_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return False
        gates = value.get("gates", [])
        required = {"design_review", "review_logic", "review_voice", "review_continuity", "cold_review"}
        names = {item.get("gate") for item in gates if isinstance(item, dict)}
        return bool(
            value.get("passed") and value.get("strict_workflow") and names == required
            and all(item.get("passed") and item.get("evidence") and not any(finding.get("status", "open") == "open" for finding in item.get("findings", [])) for item in gates)
        )

    def save_review(self, report: ReviewReport) -> Path:
        directory = self.book_dir(report.book_id) / "reviews"
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / f"chapter-{report.chapter_number:04d}.json"
        self.write_json(path, report.to_dict())
        path_md = directory / f"chapter-{report.chapter_number:04d}.md"
        path_md.write_text(report.to_markdown(), encoding="utf-8")
        # A legacy one-shot review is diagnostic only.  Approval requires all
        # strict workflow gates with evidence; this makes empty checklists
        # fail closed instead of silently preparing a release.
        strict_pass = report.strict_workflow and report.passed and report.gates and all(
            gate.passed and gate.evidence and not any(item.status == "open" for item in gate.findings)
            for gate in report.gates
        )
        self.update_chapter_status(report.book_id, report.chapter_number, "approved" if strict_pass else "blocked", review_path=str(path))
        return path

    def save_canon(self, book_id: str, chapter_number: int, snapshot: dict[str, Any]) -> Path:
        evidence = snapshot.get("evidence")
        if chapter_number > 0 and (not isinstance(evidence, list) or not evidence or not all(str(item).strip() for item in evidence)):
            raise ValueError("Canon 更新必须包含从最终正文提取的非空 evidence")
        path = self.book_dir(book_id) / "canon" / "current.json"
        self.write_json(path, {"chapter_number": chapter_number, **snapshot})
        with self.connect() as connection:
            connection.execute("INSERT INTO canon_snapshots(book_id,chapter_number,snapshot_json,created_at) VALUES(?,?,?,?)", (book_id, chapter_number, json.dumps(snapshot, ensure_ascii=False), utc_now()))
        self.append_event(book_id, chapter_number, "canon_updated", snapshot)
        return path

    def load_canon(self, book_id: str) -> dict[str, Any]:
        path = self.book_dir(book_id) / "canon" / "current.json"
        if not path.is_file():
            return {}
        return json.loads(path.read_text(encoding="utf-8"))

    def create_batch(self, batch: PublishBatch) -> None:
        with self.connect() as connection:
            connection.execute(
                "INSERT OR REPLACE INTO publish_batches(id,book_id,chapter_numbers_json,schedule_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
                (batch.batch_id, batch.book_id, json.dumps(batch.chapter_numbers), json.dumps(batch.schedule, ensure_ascii=False), batch.status, batch.created_at, utc_now()),
            )
        self.write_json(self.book_dir(batch.book_id) / "publish" / f"{batch.batch_id}.json", {"batch_id": batch.batch_id, "book_id": batch.book_id, "chapter_numbers": batch.chapter_numbers, "schedule": batch.schedule, "status": batch.status, "created_at": batch.created_at})
        self.append_event(batch.book_id, None, "publish_batch_created", {"batch_id": batch.batch_id, "chapter_numbers": batch.chapter_numbers})

    def get_batch(self, batch_id: str) -> PublishBatch | None:
        with self.connect() as connection:
            row = connection.execute("SELECT * FROM publish_batches WHERE id=?", (batch_id,)).fetchone()
        if not row:
            return None
        return PublishBatch(batch_id=row["id"], book_id=row["book_id"], chapter_numbers=json.loads(row["chapter_numbers_json"]), schedule=json.loads(row["schedule_json"]), status=row["status"], created_at=row["created_at"])

    def update_batch(self, batch_id: str, status: str) -> None:
        with self.connect() as connection:
            connection.execute("UPDATE publish_batches SET status=?,updated_at=?,submitted_at=? WHERE id=?", (status, utc_now(), utc_now() if status == "submitted" else None, batch_id))

    def save_workflow_run(self, run: WorkflowRun) -> Path:
        self.initialize()
        run.updated_at = utc_now()
        payload = run.to_dict()
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO workflow_runs(id,book_id,state_json,status,current_chapter,current_stage,created_at,updated_at)
                VALUES(?,?,?,?,?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET state_json=excluded.state_json,status=excluded.status,
                    current_chapter=excluded.current_chapter,current_stage=excluded.current_stage,updated_at=excluded.updated_at
                """,
                (run.run_id, run.book_id, json.dumps(payload, ensure_ascii=False), run.status, run.current_chapter,
                 run.current_stage, run.created_at, run.updated_at),
            )
        path = self.book_dir(run.book_id) / "workflow" / run.run_id / "state.json"
        self.write_json(path, payload)
        return path

    def load_workflow_run(self, run_id: str) -> WorkflowRun | None:
        self.initialize()
        with self.connect() as connection:
            row = connection.execute("SELECT state_json FROM workflow_runs WHERE id=?", (run_id,)).fetchone()
        if not row:
            return None
        value = json.loads(row["state_json"])
        return WorkflowRun(**value)

    def list_workflow_runs(self, book_id: str) -> list[dict[str, Any]]:
        self.initialize()
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT id,status,current_chapter,current_stage,created_at,updated_at FROM workflow_runs WHERE book_id=? ORDER BY updated_at DESC",
                (book_id,),
            ).fetchall()
        return [dict(row) for row in rows]

    def invalidate_chapters(self, book_id: str, chapter_numbers: Iterable[int], *, reason: str) -> dict[str, Any]:
        numbers = sorted(set(int(item) for item in chapter_numbers))
        if not numbers:
            return {"chapters": [], "batches": []}
        placeholders = ",".join("?" for _ in numbers)
        affected_batches: list[str] = []
        now = utc_now()
        with self.connect() as connection:
            connection.execute(
                f"UPDATE chapters SET status='invalidated',review_path=NULL,updated_at=? WHERE book_id=? AND chapter_number IN ({placeholders})",
                [now, book_id, *numbers],
            )
            rows = connection.execute(
                "SELECT id,chapter_numbers_json FROM publish_batches WHERE book_id=? AND status IN ('prepared','preview','failed')",
                (book_id,),
            ).fetchall()
            for row in rows:
                batch_numbers = set(json.loads(row["chapter_numbers_json"]))
                if batch_numbers.intersection(numbers):
                    connection.execute("UPDATE publish_batches SET status='superseded',updated_at=? WHERE id=?", (now, row["id"]))
                    affected_batches.append(row["id"])
        for batch_id in affected_batches:
            batch_path = self.book_dir(book_id) / "publish" / f"{batch_id}.json"
            if batch_path.is_file():
                value = json.loads(batch_path.read_text(encoding="utf-8"))
                value["status"] = "superseded"
                value["superseded_reason"] = reason
                self.write_json(batch_path, value)
        self.append_event(book_id, None, "chapters_invalidated", {"chapters": numbers, "reason": reason, "batches": affected_batches})
        return {"chapters": numbers, "batches": affected_batches}

    def reset_canon(self, book_id: str, *, reason: str) -> Path:
        snapshot = {
            "chapter_number": 0,
            "characters": [], "facts": [], "relationships": [], "open_threads": [],
            "inventory": [], "locations": [], "timeline": [], "foreshadowing": [],
            "reset_reason": reason,
        }
        path = self.book_dir(book_id) / "canon" / "current.json"
        self.write_json(path, snapshot)
        self.append_event(book_id, None, "canon_reset", {"reason": reason})
        return path

    def append_event(self, book_id: str | None, chapter_number: int | None, event_type: str, payload: dict[str, Any]) -> None:
        event = {"book_id": book_id, "chapter_number": chapter_number, "event_type": event_type, "payload": payload, "created_at": utc_now()}
        (self.root / "audit").mkdir(parents=True, exist_ok=True)
        with (self.root / "audit" / "events.jsonl").open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(event, ensure_ascii=False) + "\n")
        if self.db_path.is_file():
            with self.connect() as connection:
                connection.execute("INSERT INTO events(book_id,chapter_number,event_type,payload_json,created_at) VALUES(?,?,?,?,?)", (book_id, chapter_number, event_type, json.dumps(payload, ensure_ascii=False), event["created_at"]))

    def record_skill_run(self, book_id: str | None, chapter_number: int | None, stage: str, module_chain: list[str], skill_hash: str, prompt_hash: str | None, references: dict[str, Any] | None) -> None:
        if not self.db_path.is_file():
            self.initialize()
        with self.connect() as connection:
            connection.execute("INSERT INTO skill_runs(book_id,chapter_number,stage,module_chain_json,skill_hash,prompt_hash,references_json,created_at) VALUES(?,?,?,?,?,?,?,?)", (book_id, chapter_number, stage, json.dumps(module_chain), skill_hash, prompt_hash, json.dumps(references or {}, ensure_ascii=False), utc_now()))

    def write_json(self, path: Path, value: Any) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    def write_structured(self, path: Path, value: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        if yaml:
            path.write_text(yaml.safe_dump(value, allow_unicode=True, sort_keys=False), encoding="utf-8")
        else:
            path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
