from __future__ import annotations

import hashlib
import json
import re
import shutil
import sqlite3
import uuid
import threading
import warnings
from contextlib import contextmanager, ExitStack
from pathlib import Path
from typing import Any, Iterable

try:
    import yaml
except ImportError:  # pragma: no cover
    yaml = None

from .models import ChapterContract, PublishBatch, ReviewReport, WorkflowRun, utc_now
from .book_lock import audit_operation, book_lock, book_operation, delegated, lock_key

_book_changes = threading.local()


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
        for directory in ["config", "library/modules", "library/templates", "library/references", "library/platform", "books", "authors", "audit", "tests"]:
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
                    invalidated_at TEXT,
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
                CREATE TABLE IF NOT EXISTS author_profiles (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    description TEXT NOT NULL DEFAULT '',
                    persona_json TEXT NOT NULL DEFAULT '{}',
                    status TEXT NOT NULL DEFAULT 'active',
                    is_system INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS author_profile_versions (
                    id TEXT PRIMARY KEY,
                    author_id TEXT NOT NULL,
                    version_number INTEGER NOT NULL,
                    status TEXT NOT NULL DEFAULT 'draft',
                    profile_json TEXT NOT NULL,
                    source_manifest_json TEXT NOT NULL DEFAULT '[]',
                    profile_hash TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    published_at TEXT,
                    UNIQUE(author_id, version_number),
                    FOREIGN KEY(author_id) REFERENCES author_profiles(id)
                );
                CREATE TABLE IF NOT EXISTS author_sources (
                    id TEXT PRIMARY KEY,
                    author_id TEXT NOT NULL,
                    original_name TEXT NOT NULL,
                    stored_path TEXT NOT NULL,
                    media_type TEXT NOT NULL,
                    size_bytes INTEGER NOT NULL,
                    sha256 TEXT NOT NULL,
                    text_path TEXT NOT NULL,
                    text_hash TEXT NOT NULL,
                    metrics_json TEXT NOT NULL DEFAULT '{}',
                    status TEXT NOT NULL DEFAULT 'ready',
                    rights_confirmed INTEGER NOT NULL DEFAULT 0,
                    sort_order INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    deleted_at TEXT,
                    UNIQUE(author_id, sha256),
                    FOREIGN KEY(author_id) REFERENCES author_profiles(id)
                );
                CREATE TABLE IF NOT EXISTS book_author_bindings (
                    book_id TEXT PRIMARY KEY,
                    author_id TEXT NOT NULL,
                    version_id TEXT NOT NULL,
                    profile_hash TEXT NOT NULL,
                    bound_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY(book_id) REFERENCES books(id),
                    FOREIGN KEY(author_id) REFERENCES author_profiles(id),
                    FOREIGN KEY(version_id) REFERENCES author_profile_versions(id)
                );
                CREATE TABLE IF NOT EXISTS book_style_overrides (
                    id TEXT PRIMARY KEY,
                    book_id TEXT NOT NULL,
                    category TEXT NOT NULL,
                    rule TEXT NOT NULL,
                    evidence TEXT NOT NULL DEFAULT '',
                    enabled INTEGER NOT NULL DEFAULT 1,
                    source_id TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY(book_id) REFERENCES books(id)
                );
                CREATE INDEX IF NOT EXISTS idx_author_versions_author_status
                    ON author_profile_versions(author_id, status, version_number);
                CREATE INDEX IF NOT EXISTS idx_author_sources_author_status
                    ON author_sources(author_id, status, created_at);
                CREATE INDEX IF NOT EXISTS idx_style_overrides_book_enabled
                    ON book_style_overrides(book_id, enabled, created_at);
                """
            )

            # Serialize additive migration across CLI processes. Old history is
            # retained, but only history consistent with its active pointer can
            # be used as an ancestor after upgrading.
            connection.execute("BEGIN IMMEDIATE")
            canon_columns = {row["name"] for row in connection.execute("PRAGMA table_info(canon_snapshots)")}
            if "invalidated_at" not in canon_columns:
                connection.execute("ALTER TABLE canon_snapshots ADD COLUMN invalidated_at TEXT")
                for book in connection.execute("SELECT DISTINCT book_id FROM canon_snapshots").fetchall():
                    book_id = book["book_id"]
                    try:
                        current = self.load_canon(book_id)
                    except (OSError, ValueError):
                        current = {}
                    rows = connection.execute("SELECT * FROM canon_snapshots WHERE book_id=? ORDER BY id DESC", (book_id,)).fetchall()
                    head = next((row for row in rows if {"chapter_number": row["chapter_number"], **json.loads(row["snapshot_json"])} == current), None)
                    connection.execute(
                        """UPDATE canon_snapshots SET invalidated_at=? WHERE book_id=? AND
                        (id>? OR chapter_number>? OR chapter_number IN
                          (SELECT chapter_number FROM chapters WHERE book_id=? AND status IN ('invalidated','modified_after_review')))
                        """, (utc_now(), book_id, head["id"] if head else 0, head["chapter_number"] if head else -1, book_id),
                    )

            # Author sources predate explicit distillation ordering.  Keep the
            # migration additive so existing source/version evidence remains
            # valid, then seed a deterministic upload order once.
            source_columns = {str(row["name"]) for row in connection.execute("PRAGMA table_info(author_sources)").fetchall()}
            added_source_order = "sort_order" not in source_columns
            if added_source_order:
                connection.execute("ALTER TABLE author_sources ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0")
                author_rows = connection.execute("SELECT DISTINCT author_id FROM author_sources").fetchall()
                for author_row in author_rows:
                    source_rows = connection.execute(
                        "SELECT id FROM author_sources WHERE author_id=? ORDER BY created_at,id",
                        (author_row["author_id"],),
                    ).fetchall()
                    for sort_order, source_row in enumerate(source_rows):
                        connection.execute("UPDATE author_sources SET sort_order=? WHERE id=?", (sort_order, source_row["id"]))
            connection.execute(
                "CREATE INDEX IF NOT EXISTS idx_author_sources_author_order ON author_sources(author_id,deleted_at,sort_order)"
            )

            # Public author persona is mutable and deliberately independent
            # from immutable fiction-style versions.
            profile_columns = {str(row["name"]) for row in connection.execute("PRAGMA table_info(author_profiles)").fetchall()}
            if "persona_json" not in profile_columns:
                connection.execute("ALTER TABLE author_profiles ADD COLUMN persona_json TEXT NOT NULL DEFAULT '{}'")

            # A hidden immutable compatibility version protects existing works
            # without exposing a fake preset author to new-book creation.
            now = utc_now()
            legacy_profile = {
                "profile_name": "旧流程兼容快照",
                "description": "仅用于迁移旧书；保持升级前的通用写作行为",
                "rules": [],
                "forbidden_patterns": [],
                "platform_constraints": [],
                "provenance": {"kind": "system_migration"},
            }
            legacy_json = json.dumps(legacy_profile, ensure_ascii=False, sort_keys=True)
            legacy_hash = hashlib.sha256(legacy_json.encode("utf-8")).hexdigest()
            connection.execute(
                "INSERT OR IGNORE INTO author_profiles(id,name,description,status,is_system,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
                ("system-legacy-author", "旧流程兼容快照", "隐藏迁移档案", "active", 1, now, now),
            )
            connection.execute(
                "INSERT OR IGNORE INTO author_profile_versions(id,author_id,version_number,status,profile_json,source_manifest_json,profile_hash,created_at,published_at) VALUES(?,?,?,?,?,?,?,?,?)",
                ("system-legacy-author-v1", "system-legacy-author", 1, "published", legacy_json, "[]", legacy_hash, now, now),
            )
            connection.execute(
                """
                INSERT OR IGNORE INTO book_author_bindings(book_id,author_id,version_id,profile_hash,bound_at,updated_at)
                SELECT id,'system-legacy-author','system-legacy-author-v1',?,?,? FROM books
                """,
                (legacy_hash, now, now),
            )

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path, factory=ClosingConnection)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        return connection

    @book_operation
    def create_book(
        self,
        book_id: str,
        title: str,
        metadata: dict[str, Any],
        *,
        author_profile_version_id: str | None = None,
    ) -> Path:
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
            version_id = author_profile_version_id or "system-legacy-author-v1"
            version = connection.execute(
                "SELECT v.author_id,v.profile_hash,v.status,p.is_system FROM author_profile_versions v JOIN author_profiles p ON p.id=v.author_id WHERE v.id=?",
                (version_id,),
            ).fetchone()
            if not version or version["status"] != "published":
                raise ValueError("author profile version must exist and be published")
            if author_profile_version_id and version["is_system"]:
                raise ValueError("new books must bind a user-created author profile version")
            connection.execute(
                "INSERT INTO books(id,title,metadata_json,created_at,updated_at) VALUES(?,?,?,?,?)",
                (book_id, title, json.dumps(metadata, ensure_ascii=False), now, now),
            )
            connection.execute(
                "INSERT INTO book_author_bindings(book_id,author_id,version_id,profile_hash,bound_at,updated_at) VALUES(?,?,?,?,?,?)",
                (book_id, version["author_id"], version_id, version["profile_hash"], now, now),
            )
        directory = self.book_dir(book_id)
        for child in ["assets", "canon", "outlines", "drafts", "reviews", "publish", "audit", "workflow", ".trash"]:
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

    @book_operation
    def save_foundation_contract(self, book_id: str, value: dict[str, Any]) -> dict[str, Any]:
        """Persist the user-approved new-book contract as an authoritative input.

        This is deliberately separate from style and Canon: it describes the
        story promises and workflow acceptance rules that every later stage
        must reconcile against.  A hash is embedded so the UI and workflow can
        prove which exact contract was applied.
        """
        if not self.get_book(book_id):
            raise ValueError(f"book does not exist: {book_id}")
        if not isinstance(value, dict):
            raise ValueError("planning_contract must be an object")
        constraints = value.get("constraints")
        if not isinstance(constraints, dict):
            raise ValueError("planning_contract.constraints must be an object")
        required = [
            "reader_promise", "protagonist_goal", "stakes_and_cost", "causal_chain",
            "character_constraints", "knowledge_boundaries", "world_rules",
            "relationship_arc", "foreshadowing_plan", "pacing_rules",
            "voice_and_platform_rules", "forbidden_shortcuts", "workflow_acceptance",
        ]
        missing = [key for key in required if not constraints.get(key)]
        if missing:
            raise ValueError(f"planning_contract missing constraints: {', '.join(missing)}")
        applied_at = utc_now()
        active_constraints = self._legacy_constraint_items(
            book_id,
            constraints,
            source_job_id=str(value.get("source_job_id") or ""),
            source_scope="new_book",
            timestamp=applied_at,
        )
        base = {
            "schema_version": "foundation-contract-v2",
            "revision": 1,
            "parent_contract_hash": "",
            "source_job_id": str(value.get("source_job_id") or ""),
            "source_job_ids": [str(value.get("source_job_id"))] if value.get("source_job_id") else [],
            "source_draft_path": str(value.get("source_draft_path") or ""),
            "source_draft_hash": str(value.get("source_draft_hash") or ""),
            "generated_at": str(value.get("generated_at") or utc_now()),
            "applied_at": applied_at,
            "active_constraints": active_constraints,
            "rationale": [str(item) for item in value.get("rationale", [])],
            "warnings": [str(item) for item in value.get("warnings", [])],
            "applied_fields": [str(item) for item in value.get("applied_fields", [])],
            "author_contract_snapshot": value.get("author_contract_snapshot") if isinstance(value.get("author_contract_snapshot"), dict) else {},
            "author_application": value.get("author_application") if isinstance(value.get("author_application"), dict) else {},
            "reader_world_contract": value.get("reader_world_contract") if isinstance(value.get("reader_world_contract"), dict) else {},
            "source_artifact_hashes": value.get("source_artifact_hashes") if isinstance(value.get("source_artifact_hashes"), dict) else {},
            "last_change_summary": {
                "added": [item["constraint_id"] for item in active_constraints],
                "updated": [],
                "removed": [],
                "unchanged": 0,
            },
        }
        saved = self._save_foundation_snapshot(book_id, base)
        path = self.book_dir(book_id) / "outlines" / "foundation-contract.json"
        self.append_event(book_id, None, "foundation_contract_applied", {"path": str(path), "contract_hash": saved["contract_hash"], "source_job_id": saved["source_job_id"]})
        return saved

    @staticmethod
    def _constraint_priority(category: str) -> str:
        return "avoid" if category in {"forbidden_shortcuts", "unresolved_decisions"} else "must"

    def _legacy_constraint_items(
        self,
        book_id: str,
        constraints: dict[str, Any],
        *,
        source_job_id: str,
        source_scope: str,
        timestamp: str,
    ) -> list[dict[str, Any]]:
        """Compile the old grouped contract into stable, independently editable rules."""
        result: list[dict[str, Any]] = []
        for category, raw in constraints.items():
            if category in {"contract_version"} or raw is None or raw == "":
                continue
            values = raw if isinstance(raw, list) else [raw]
            for index, entry in enumerate(values):
                rule = str(entry).strip()
                if not rule:
                    continue
                seed = f"{book_id}|book|book|{category}|{index}|{rule}"
                result.append({
                    "constraint_id": f"constraint-{hashlib.sha256(seed.encode('utf-8')).hexdigest()[:16]}",
                    "scope_type": "book",
                    "scope_id": "book",
                    "category": str(category),
                    "rule": rule,
                    "priority": self._constraint_priority(str(category)),
                    "source_job_id": source_job_id,
                    "source_scope": source_scope,
                    "reason": "由已确认的新书规划契约编译",
                    "created_at": timestamp,
                    "updated_at": timestamp,
                })
        return result

    @staticmethod
    def _foundation_hash(value: dict[str, Any]) -> str:
        payload = {key: item for key, item in value.items() if key != "contract_hash"}
        canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

    def _save_foundation_snapshot(self, book_id: str, value: dict[str, Any]) -> dict[str, Any]:
        saved = {**value, "contract_hash": self._foundation_hash(value)}
        path = self.book_dir(book_id) / "outlines" / "foundation-contract.json"
        self.write_json(path, saved)
        self.write_json(self.book_dir(book_id) / "audit" / f"planning-contract-{saved['contract_hash'][:16]}.json", saved)
        return saved

    def load_foundation_contract(self, book_id: str) -> dict[str, Any]:
        path = self.book_dir(book_id) / "outlines" / "foundation-contract.json"
        if not path.is_file():
            return {}
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
            return value if isinstance(value, dict) else {}
        except (OSError, json.JSONDecodeError):
            return {}

    def _active_constraint_items(self, book_id: str, contract: dict[str, Any]) -> list[dict[str, Any]]:
        current = contract.get("active_constraints")
        if isinstance(current, list):
            return [dict(item) for item in current if isinstance(item, dict)]
        legacy = contract.get("constraints")
        if isinstance(legacy, dict):
            timestamp = str(contract.get("applied_at") or contract.get("generated_at") or utc_now())
            return self._legacy_constraint_items(
                book_id,
                legacy,
                source_job_id=str(contract.get("source_job_id") or ""),
                source_scope="legacy_contract_migration",
                timestamp=timestamp,
            )
        return []

    def effective_foundation_contract(
        self,
        book_id: str,
        *,
        chapter_number: int | None = None,
        volume_id: str | None = None,
    ) -> dict[str, Any]:
        """Return only active rules relevant to the current generation scope."""
        contract = self.load_foundation_contract(book_id)
        if not contract:
            return {}
        items = self._active_constraint_items(book_id, contract)
        if chapter_number is not None and not volume_id:
            row = self.get_chapter(book_id, int(chapter_number))
            if row:
                volume_id = str((row.get("contract") or {}).get("volume_id") or "")
        if chapter_number is None:
            # Story-foundation needs the whole-book and volume architecture, not
            # every chapter-local instruction. Chapter rules are injected only
            # when that chapter is actually designed/reviewed.
            effective = [item for item in items if item.get("scope_type") in {"book", "volume"}]
            scope = {"scope_type": "book", "scope_id": "book", "includes_descendants": "volume"}
        else:
            effective = [
                item for item in items
                if item.get("scope_type") == "book"
                or item.get("scope_type") == "volume" and str(item.get("scope_id")) == str(volume_id or "")
                or item.get("scope_type") == "chapter" and str(item.get("scope_id")) == str(int(chapter_number))
            ]
            scope = {"scope_type": "chapter", "scope_id": str(int(chapter_number)), "volume_id": volume_id or ""}
        return {
            key: item for key, item in contract.items()
            if key not in {"constraints", "active_constraints", "last_change_summary"}
        } | {
            "schema_version": "foundation-contract-effective-v2",
            "active_constraints": effective,
            "effective_scope": scope,
            "effective_constraint_count": len(effective),
        }

    def _compile_foundation_contract_delta(self, book_id: str, update: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
        if not isinstance(update, dict):
            raise ValueError("planning_contract_update must be an object")
        current = self.load_foundation_contract(book_id)
        current_hash = str(current.get("contract_hash") or (self._foundation_hash(current) if current else ""))
        base_hash = str(update.get("base_contract_hash") or "")
        if base_hash != current_hash:
            raise ValueError(f"stale foundation contract: expected {current_hash or '<empty>'}, got {base_hash or '<empty>'}")
        raw_changes = update.get("changes")
        if not isinstance(raw_changes, list) or len(raw_changes) > 200:
            raise ValueError("planning contract changes must be an array of at most 200 items")
        now = utc_now()
        items = self._active_constraint_items(book_id, current)
        by_id = {str(item.get("constraint_id")): item for item in items if item.get("constraint_id")}
        added: list[str] = []
        updated: list[str] = []
        removed: list[str] = []
        effective_scopes: list[dict[str, str]] = []
        touched_ids: set[str] = set()
        source_job_ids = [str(item) for item in update.get("source_job_ids", []) if str(item).strip()]
        source_job_id = str(update.get("source_job_id") or (source_job_ids[-1] if source_job_ids else ""))
        if source_job_id and source_job_id not in source_job_ids:
            source_job_ids.append(source_job_id)
        for index, raw in enumerate(raw_changes):
            if not isinstance(raw, dict):
                raise ValueError(f"planning contract change {index} must be an object")
            operation = str(raw.get("operation") or "").strip()
            if operation not in {"add", "update", "remove"}:
                raise ValueError(f"planning contract change {index} operation is invalid")
            scope_type = str(raw.get("scope_type") or "").strip()
            scope_id = str(raw.get("scope_id") or "").strip()
            if scope_type not in {"book", "volume", "chapter"}:
                raise ValueError(f"planning contract change {index} scope_type is invalid")
            if scope_type == "book":
                scope_id = "book"
            elif scope_type == "chapter":
                if not scope_id.isdigit() or int(scope_id) <= 0:
                    raise ValueError(f"planning contract change {index} chapter scope is invalid")
                scope_id = str(int(scope_id))
            elif not re.fullmatch(r"[A-Za-z0-9_-]+", scope_id):
                raise ValueError(f"planning contract change {index} volume scope is invalid")
            constraint_id = str(raw.get("constraint_id") or "").strip()
            if constraint_id:
                if constraint_id in touched_ids:
                    raise ValueError(f"planning contract change {index} touches {constraint_id} more than once")
                touched_ids.add(constraint_id)
            if operation == "add":
                if constraint_id:
                    raise ValueError("new constraints cannot choose their own stable id")
                category = str(raw.get("category") or "").strip()[:80]
                rule = str(raw.get("rule") or "").strip()[:2_000]
                if not category or not rule:
                    raise ValueError(f"planning contract change {index} add requires category and rule")
                duplicate = next((item for item in items if item.get("scope_type") == scope_type and str(item.get("scope_id")) == scope_id and str(item.get("category")) == category and str(item.get("rule")) == rule), None)
                if duplicate:
                    continue
                # 单值 category（如 reader_promise/protagonist_goal）只允许每个 scope 一条规则：
                # 模型改变了旧约束必须 update/remove 旧 ID，禁止 add 一条相反规则让废案继续生效。
                single_value_categories = {"reader_promise", "protagonist_goal", "stakes_and_cost", "relationship_arc"}
                if category in single_value_categories:
                    conflicting = next((item for item in items if item.get("scope_type") == scope_type and str(item.get("scope_id")) == scope_id and str(item.get("category")) == category), None)
                    if conflicting:
                        raise ValueError(f"planning contract change {index} adds {category} but an existing rule with the same scope already exists ({conflicting.get('constraint_id')}); update or remove it instead of adding a conflicting rule")
                constraint_id = f"constraint-{uuid.uuid4().hex[:16]}"
                item = {
                    "constraint_id": constraint_id,
                    "scope_type": scope_type,
                    "scope_id": scope_id,
                    "category": category,
                    "rule": rule,
                    "priority": str(raw.get("priority") or self._constraint_priority(category)),
                    "source_job_id": source_job_id,
                    "source_scope": str(update.get("source_scope") or scope_type),
                    "reason": str(raw.get("reason") or "共创规划新增约束").strip()[:1_000],
                    "created_at": now,
                    "updated_at": now,
                }
                items.append(item)
                by_id[constraint_id] = item
                added.append(constraint_id)
            else:
                if not re.fullmatch(r"constraint-[a-f0-9]{16}", constraint_id):
                    raise ValueError(f"planning contract change {index} must reference a real stable constraint id")
                existing = by_id.get(constraint_id)
                if not existing:
                    raise ValueError(f"planning contract change {index} references missing constraint {constraint_id}")
                if str(existing.get("scope_type")) != scope_type or str(existing.get("scope_id")) != scope_id:
                    raise ValueError(f"planning contract change {index} cannot move a constraint to another scope")
                if operation == "remove":
                    items.remove(existing)
                    by_id.pop(constraint_id, None)
                    removed.append(constraint_id)
                else:
                    category = str(raw.get("category") or existing.get("category") or "").strip()[:80]
                    rule = str(raw.get("rule") or "").strip()[:2_000]
                    if not category or not rule:
                        raise ValueError(f"planning contract change {index} update requires category and rule")
                    existing.update({
                        "category": category,
                        "rule": rule,
                        "priority": str(raw.get("priority") or existing.get("priority") or self._constraint_priority(category)),
                        "source_job_id": source_job_id,
                        "source_scope": str(update.get("source_scope") or scope_type),
                        "reason": str(raw.get("reason") or "共创规划更新约束").strip()[:1_000],
                        "updated_at": now,
                    })
                    updated.append(constraint_id)
            effective_scopes.append({"scope_type": scope_type, "scope_id": scope_id})
        applied_at = utc_now()
        base = {
            "schema_version": "foundation-contract-v2",
            "revision": int(current.get("revision") or (1 if current else 0)) + (1 if current else 1),
            "parent_contract_hash": current_hash,
            "source_job_id": source_job_id,
            "source_job_ids": source_job_ids,
            "generated_at": str(update.get("generated_at") or applied_at),
            "applied_at": applied_at,
            "active_constraints": sorted(items, key=lambda item: (str(item.get("scope_type")), str(item.get("scope_id")), str(item.get("category")), str(item.get("constraint_id")))),
            "rationale": [str(item) for item in update.get("rationale", [])],
            "warnings": [str(item) for item in update.get("warnings", [])],
            "applied_fields": [str(item) for item in update.get("applied_fields", [])],
            "author_contract_snapshot": update.get("author_contract_snapshot") if isinstance(update.get("author_contract_snapshot"), dict) else current.get("author_contract_snapshot", {}),
            "author_binding_snapshot": update.get("author_binding_snapshot") if isinstance(update.get("author_binding_snapshot"), dict) else current.get("author_binding_snapshot", {}),
            "author_application": update.get("author_application") if isinstance(update.get("author_application"), dict) else current.get("author_application", {}),
            "reader_world_contract": update.get("reader_world_contract") if isinstance(update.get("reader_world_contract"), dict) else current.get("reader_world_contract", {}),
            "source_artifact_hashes": update.get("source_artifact_hashes") if isinstance(update.get("source_artifact_hashes"), dict) else current.get("source_artifact_hashes", {}),
            "last_change_summary": {"added": added, "updated": updated, "removed": removed, "unchanged": max(0, len(items) - len(added) - len(updated))},
        }
        return {**base, "contract_hash": self._foundation_hash(base)}, {"scopes": effective_scopes, "changed": bool(added or updated or removed)}

    def preview_foundation_contract_delta(self, book_id: str, update: dict[str, Any]) -> dict[str, Any]:
        return self._compile_foundation_contract_delta(book_id, update)[0]

    @book_operation
    def apply_foundation_contract_delta(self, book_id: str, update: dict[str, Any]) -> dict[str, Any]:
        saved, effect = self._compile_foundation_contract_delta(book_id, update)
        current = self.load_foundation_contract(book_id)
        if current and current.get("contract_hash") and effect["changed"]:
            audit = self.book_dir(book_id) / "audit" / f"planning-contract-{str(current['contract_hash'])[:16]}.json"
            if not audit.is_file():
                self.write_json(audit, current)
        if not current or effect["changed"]:
            saved = self._save_foundation_snapshot(book_id, {key: item for key, item in saved.items() if key != "contract_hash"})
        else:
            saved = current
        invalidation: dict[str, Any] | None = None
        if effect["changed"]:
            rows = self.list_chapters(book_id)
            target_numbers: set[int] = set()
            for scope in effect["scopes"]:
                if scope["scope_type"] == "book":
                    target_numbers.update(int(row["chapter_number"]) for row in rows)
                elif scope["scope_type"] == "volume":
                    target_numbers.update(int(row["chapter_number"]) for row in rows if str((row.get("contract") or {}).get("volume_id") or "volume-1") == scope["scope_id"])
                else:
                    target_numbers.add(int(scope["scope_id"]))
            if target_numbers:
                earliest = min(target_numbers)
                generated = [int(row["chapter_number"]) for row in rows if int(row["chapter_number"]) >= earliest and (row.get("path") or row.get("content_hash"))]
                reason = f"foundation contract changed from chapter {earliest}; generated text and downstream evidence were based on an obsolete planning snapshot"
                canon_result = None
                if generated and int(self.load_canon(book_id).get("chapter_number") or 0) >= earliest:
                    canon_result = self.invalidate_canon_from(book_id, earliest, reason=reason)
                invalidation = self.invalidate_chapters(book_id, generated, reason=reason) if generated else {"chapters": [], "batches": []}
                invalidation.update({"from_chapter": earliest, "canon": canon_result})
        summary = saved.get("last_change_summary", {})
        self.append_event(book_id, None, "foundation_contract_updated", {
            "contract_hash": saved.get("contract_hash"), "parent_contract_hash": saved.get("parent_contract_hash"),
            "source_job_ids": saved.get("source_job_ids", []), "change_summary": summary, "invalidation": invalidation,
        })
        return {**saved, "application": {"changed": effect["changed"], "invalidation": invalidation}}

    def index_existing_books(self) -> dict[str, Any]:
        self.initialize()
        # Acquire every book before the first indexing mutation, including the
        # eventual dependency invalidation. No partially indexed snapshot.
        with ExitStack() as locks:
            for directory in sorted((self.root / "books").iterdir()):
                if directory.is_dir() and not directory.is_symlink():
                    locks.enter_context(book_lock(self.root, directory.name))
            return self._index_existing_books_locked()

    def _index_existing_books_locked(self) -> dict[str, Any]:
        """Sync filesystem projects without rewriting body or outline files.

        Studio calls this only after creating its database backup and inventory
        manifest. Changed inputs invalidate approvals and derived Canon/batches;
        missing legacy chapters are indexed as unreviewed, never release-ready.
        """
        self.initialize()
        added_books: list[str] = []
        updated_books: list[str] = []
        added_chapters: dict[str, list[int]] = {}
        updated_chapters: dict[str, list[int]] = {}
        invalidated_chapters: dict[str, list[int]] = {}
        removed_chapters: dict[str, list[int]] = {}
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
            try:
                contracts, _ = self._normalize_outline_chapters(book_id, outline)
            except (ValueError, TypeError):
                continue  # A malformed file is not authority to remove chapters.
            present = {item.chapter_number for item in contracts}
            removed = [int(item["chapter_number"]) for item in self.list_chapters(book_id)
                       if int(item["chapter_number"]) not in present
                       and (item["status"] != "invalidated" or item.get("review_path"))]
            if removed:
                removed_chapters[book_id] = removed
                invalidated_chapters.setdefault(book_id, []).extend(removed)
                updated_chapters.setdefault(book_id, []).extend(removed)
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
                    content_changed = existing_chapter.get("content_hash") != content_hash
                    current_status = str(existing_chapter["status"])
                    status_needs_normalization = bool(content) and current_status in {"planned", "prompt_ready", "legacy_unreviewed"} and current_status != "draft_unreviewed"
                    if contract_changed or content_changed or status_needs_normalization:
                        status = current_status
                        review_path = existing_chapter.get("review_path")
                        if (contract_changed or content_changed) and self._has_generated_body_record(existing_chapter):
                            invalidated_chapters.setdefault(book_id, []).append(number)
                        if content and status in {"planned", "prompt_ready", "legacy_unreviewed"}:
                            status = "draft_unreviewed"
                        with self.connect() as connection:
                            connection.execute(
                                """
                                UPDATE chapters SET title=?,contract_json=?,status=?,path=?,content_hash=?,word_count=?,review_path=?,updated_at=?
                                WHERE book_id=? AND chapter_number=?
                                """,
                                (chapter_title, json.dumps(contract, ensure_ascii=False), status, str(draft_path) if content else existing_chapter.get("path") or "", content_hash, word_count, review_path, now, book_id, number),
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
        for book_id, changed in list(invalidated_chapters.items()):
            result = self.invalidate_generated_dependencies(book_id, changed, reason="workspace files changed")
            invalidated_chapters[book_id] = result["chapters"]
            for number in removed_chapters.get(book_id, []):
                self.update_chapter_status(book_id, number, "invalidated", review_path=None)
        if added_books or updated_books or added_chapters or updated_chapters:
            self.append_event(None, None, "studio_filesystem_sync", {
                "added_books": added_books, "updated_books": updated_books,
                "added_chapters": added_chapters, "updated_chapters": updated_chapters,
                "invalidated_chapters": invalidated_chapters, "files_rewritten": bool(invalidated_chapters), "source_files_rewritten": False,
            })
        return {
            "added_books": added_books, "updated_books": updated_books,
            "added_chapters": added_chapters, "updated_chapters": updated_chapters,
            "invalidated_chapters": invalidated_chapters, "files_rewritten": bool(invalidated_chapters), "source_files_rewritten": False,
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

    @book_operation
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

    @book_operation
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

    @book_operation
    def save_master_outline(self, book_id: str, value: dict[str, Any]) -> dict[str, Any]:
        if not self.get_book(book_id):
            raise ValueError(f"book does not exist: {book_id}")
        saved = self._normalize_master_outline(value)
        self.write_json(self.book_dir(book_id) / "outlines" / "master.json", saved)
        book = self.get_book(book_id) or {"title": book_id, "metadata": {}}
        self.update_book(book_id, title=str(book["title"]), metadata={
            "completion_mode": saved["completion_mode"],
            "target_chapters": saved["target_chapters"],
        })
        self.append_event(book_id, None, "master_outline_updated", {"completion_mode": saved["completion_mode"], "rolling_window": saved["rolling_plan"]["window_size"]})
        return saved

    def _normalize_master_outline(self, value: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(value, dict):
            raise ValueError("master outline must be an object")
        mode = str(value.get("completion_mode") or "open_ended")
        if mode not in {"open_ended", "fixed"}:
            raise ValueError("completion_mode must be open_ended or fixed")
        rolling = value.get("rolling_plan") if isinstance(value.get("rolling_plan"), dict) else {}
        window_size = int(rolling.get("window_size") or 5)
        if not 1 <= window_size <= 20:
            raise ValueError("rolling plan window_size must be between 1 and 20")
        volumes: list[dict[str, Any]] = []
        volume_ids: set[str] = set()
        for index, item in enumerate(value.get("volumes", [])):
            if not isinstance(item, dict):
                continue
            volume_id = str(item.get("volume_id") or f"volume-{index + 1}").strip()
            if not re.fullmatch(r"[A-Za-z0-9_-]+", volume_id):
                raise ValueError(f"volume_id is invalid: {volume_id or '<empty>'}")
            if volume_id in volume_ids:
                raise ValueError(f"volume_id must be unique: {volume_id}")
            volume_ids.add(volume_id)
            volumes.append({
                "volume_id": volume_id,
                "title": str(item.get("title") or f"第 {index + 1} 卷").strip(),
                "objective": str(item.get("objective") or "").strip(),
                "main_conflict": str(item.get("main_conflict") or "").strip(),
                "character_change": str(item.get("character_change") or "").strip(),
                "foreshadowing": str(item.get("foreshadowing") or "").strip(),
                "ending": str(item.get("ending") or "").strip(),
            })
        saved = {
            "version": 1,
            "completion_mode": mode,
            "target_chapters": int(value.get("target_chapters")) if mode == "fixed" and value.get("target_chapters") else None,
            "premise": str(value.get("premise") or "").strip(),
            "core_conflict": str(value.get("core_conflict") or "").strip(),
            "ending_direction": str(value.get("ending_direction") or "未锁定").strip(),
            "major_beats": [str(item).strip() for item in value.get("major_beats", []) if str(item).strip()],
            "volumes": volumes,
            "rolling_plan": {**rolling, "window_size": window_size},
            "updated_at": utc_now(),
        }
        if mode == "fixed" and not saved["target_chapters"]:
            raise ValueError("fixed completion mode requires target_chapters")
        return saved

    @book_operation
    def save_outline_chapters(self, book_id: str, values: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if not self.get_book(book_id):
            raise ValueError(f"book does not exist: {book_id}")
        contracts, payload = self._normalize_outline_chapters(book_id, values)
        existing_by_number = {int(item["chapter_number"]): item for item in self.list_chapters(book_id)}
        self._assert_outline_keeps_chapters(book_id, contracts)
        changed_generated: list[int] = []
        for contract in sorted(contracts, key=lambda item: item.chapter_number):
            existing = existing_by_number.get(contract.chapter_number)
            if existing:
                if existing.get("contract") != contract.to_dict() and self._has_generated_body_record(existing):
                    changed_generated.append(contract.chapter_number)
                self.update_chapter_contract(contract)
            else:
                self.update_or_create_prompt_chapter(contract)
        self.write_json(self.book_dir(book_id) / "outlines" / "chapters.json", payload)
        invalidation = self.invalidate_generated_dependencies(book_id, changed_generated, reason="chapter outline changed") if changed_generated else None
        self.append_event(book_id, None, "chapter_outline_updated", {"chapters": [item.chapter_number for item in contracts], "invalidation": invalidation})
        return payload

    def _assert_outline_keeps_chapters(self, book_id: str, contracts: list[ChapterContract]) -> None:
        omitted = {int(item["chapter_number"]) for item in self.list_chapters(book_id)} - {item.chapter_number for item in contracts}
        if omitted:
            raise ValueError(f"章纲遗漏已有章节 {sorted(omitted)}；请使用专用章节删除流程，正文不会由普通保存删除")

    @staticmethod
    def _has_generated_body_record(chapter: dict[str, Any]) -> bool:
        # Planned records may reserve a future draft path without a body.
        return bool(chapter.get("content_hash") or (chapter.get("path") and chapter.get("status") not in {"planned", "prompt_ready"}))

    @book_operation
    def invalidate_generated_dependencies(self, book_id: str, changed: Iterable[int], *, reason: str) -> dict[str, Any]:
        """Share the same invalidation boundary for editor saves and file sync."""
        changed = sorted(set(changed))
        earliest = min(changed)
        downstream = [int(row["chapter_number"]) for row in self.list_chapters(book_id)
                      if int(row["chapter_number"]) > earliest and self._has_generated_body_record(row)]
        canon = None
        if int(self.load_canon(book_id).get("chapter_number") or 0) >= earliest:
            canon = self.invalidate_canon_from(book_id, earliest, reason=reason)
        result = self.invalidate_chapters(book_id, [*changed, *downstream], reason=reason)
        for number in changed:
            self.update_chapter_status(book_id, number, "modified_after_review", review_path=None)
        return {**result, "directly_changed": changed, "downstream": sorted(set(downstream) - set(changed)), "canon": canon}

    def _normalize_outline_chapters(self, book_id: str, values: list[dict[str, Any]]) -> tuple[list[ChapterContract], list[dict[str, Any]]]:
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
                causality_check=str(raw.get("causality_check") or "").strip(),
                boundary_check=str(raw.get("boundary_check") or "").strip(),
                consequence_check=str(raw.get("consequence_check") or "").strip(),
                entry_state=str(raw.get("entry_state") or "").strip(),
                entry_trigger=str(raw.get("entry_trigger") or "").strip(),
                retained_consequences=str(raw.get("retained_consequences") or "").strip(),
                exit_state=str(raw.get("exit_state") or "").strip(),
                target_word_count=max(500, min(10_000, int(raw.get("target_word_count") or 2500))),
                problem_tags=[str(item).strip() for item in raw.get("problem_tags", []) if str(item).strip()],
            ))
        payload: list[dict[str, Any]] = []
        for contract in sorted(contracts, key=lambda item: item.chapter_number):
            row = contract.to_dict()
            row.pop("book_id", None)
            payload.append(row)
        return contracts, payload

    def _validate_outline_graph(
        self,
        book_id: str,
        master: dict[str, Any],
        contracts: list[ChapterContract],
        foundation: dict[str, Any],
    ) -> None:
        volume_ids = {str(item.get("volume_id") or "") for item in master.get("volumes", []) if isinstance(item, dict)}
        chapter_numbers = {int(item.chapter_number) for item in contracts}
        missing_volumes = sorted({item.volume_id for item in contracts if item.volume_id not in volume_ids})
        if missing_volumes:
            raise ValueError(f"chapter outline references missing volume_id: {', '.join(missing_volumes)}")
        if master.get("completion_mode") == "fixed" and chapter_numbers:
            target = int(master.get("target_chapters") or 0)
            if max(chapter_numbers) > target:
                raise ValueError(f"fixed target_chapters {target} is below planned chapter {max(chapter_numbers)}")
        orphaned: list[str] = []
        for item in self._active_constraint_items(book_id, foundation):
            scope_type = str(item.get("scope_type") or "")
            scope_id = str(item.get("scope_id") or "")
            if scope_type == "volume" and scope_id not in volume_ids:
                orphaned.append(f"{item.get('constraint_id')}→volume/{scope_id}")
            elif scope_type == "chapter" and (not scope_id.isdigit() or int(scope_id) not in chapter_numbers):
                orphaned.append(f"{item.get('constraint_id')}→chapter/{scope_id}")
        if orphaned:
            raise ValueError(
                "planning constraints still reference removed outline scopes; submit remove/update in the same planning commit: "
                + ", ".join(orphaned[:20])
            )

    @staticmethod
    def _event_line_book_id(line: bytes) -> str | None:
        try:
            value = json.loads(line.decode("utf-8"))
            return str(value.get("book_id")) if isinstance(value, dict) and value.get("book_id") is not None else None
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None

    @audit_operation
    def _planning_snapshot(self, book_id: str) -> Path:
        staging_parent = (self.root / ".planning-staging").resolve()
        staging = (staging_parent / f"planning-{book_id}-{uuid.uuid4().hex[:12]}").resolve()
        if staging_parent.parent != self.root or staging_parent not in staging.parents:
            raise ValueError("unsafe planning staging path")
        staging.mkdir(parents=True, exist_ok=False)
        shutil.copytree(self.book_dir(book_id), staging / "book", symlinks=True)
        database_rows: dict[str, list[dict[str, Any]]] = {}
        with self.connect() as connection:
            for table in ["books", "chapters", "canon_snapshots", "publish_batches", "events", "skill_runs", "workflow_runs", "book_style_overrides", "book_author_bindings"]:
                key = "id" if table == "books" else "book_id"
                database_rows[table] = [dict(row) for row in connection.execute(f"SELECT * FROM {table} WHERE {key}=?", (book_id,)).fetchall()]
            if connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='browser_receipt_consumptions'").fetchone():
                database_rows["browser_receipt_consumptions"] = [dict(row) for row in connection.execute(
                    "SELECT r.* FROM browser_receipt_consumptions r JOIN publish_batches b ON b.id=r.batch_id WHERE b.book_id=?", (book_id,))]
        self.write_json(staging / "database-rows.json", database_rows)
        global_audit = self.root / "audit" / "events.jsonl"
        if global_audit.is_file():
            selected = [line for line in global_audit.read_bytes().splitlines(keepends=True) if self._event_line_book_id(line) == book_id]
            (staging / "global-events.jsonl").write_bytes(b"".join(selected))
        self.write_json(staging / "manifest.json", {"state": "prepared", "book_id": book_id, "created_at": utc_now()})
        return staging

    @audit_operation
    def _restore_planning_snapshot(self, book_id: str, staging: Path) -> None:
        snapshot_book = staging / "book"
        live_book = self.book_dir(book_id).resolve()
        if not snapshot_book.is_dir() or live_book.parent != (self.root / "books").resolve():
            raise ValueError("planning rollback snapshot is invalid")
        if live_book.exists():
            shutil.rmtree(live_book)
        shutil.copytree(snapshot_book, live_book, symlinks=True)
        database_rows = json.loads((staging / "database-rows.json").read_text(encoding="utf-8"))
        child_tables = [name for name in ["chapters", "canon_snapshots", "publish_batches", "events", "skill_runs", "workflow_runs", "book_style_overrides", "book_author_bindings"] if name in database_rows]
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                books = database_rows.get("books", [])
                if len(books) != 1:
                    raise ValueError("planning rollback is missing the book row")
                book = books[0]
                connection.execute(
                    "UPDATE books SET title=?,metadata_json=?,created_at=?,updated_at=? WHERE id=?",
                    (book["title"], book["metadata_json"], book["created_at"], book["updated_at"], book_id),
                )
                for table in child_tables:
                    connection.execute(f"DELETE FROM {table} WHERE book_id=?", (book_id,))
                    for row in database_rows.get(table, []):
                        columns = list(row)
                        placeholders = ",".join("?" for _ in columns)
                        connection.execute(
                            f"INSERT INTO {table}({','.join(columns)}) VALUES({placeholders})",
                            [row[column] for column in columns],
                        )
                # Batch restoration cascades removal of receipt consumptions;
                # restore them as well so rollback cannot erase deduplication.
                for row in database_rows.get("browser_receipt_consumptions", []):
                    columns = list(row)
                    connection.execute(f"INSERT INTO browser_receipt_consumptions({','.join(columns)}) VALUES({','.join('?' for _ in columns)})", [row[column] for column in columns])
                connection.commit()
            except Exception:
                connection.rollback()
                raise
        global_audit = self.root / "audit" / "events.jsonl"
        current_lines = global_audit.read_bytes().splitlines(keepends=True) if global_audit.is_file() else []
        retained = [line for line in current_lines if self._event_line_book_id(line) != book_id]
        prior = (staging / "global-events.jsonl").read_bytes() if (staging / "global-events.jsonl").is_file() else b""
        temporary = global_audit.with_name(f".{global_audit.name}.{uuid.uuid4().hex}.tmp")
        temporary.parent.mkdir(parents=True, exist_ok=True)
        temporary.write_bytes(b"".join(retained) + prior)
        temporary.replace(global_audit)

    def _discard_planning_snapshot(self, staging: Path) -> None:
        try:
            shutil.rmtree(staging)
        except OSError as exc:
            warnings.warn(f"operation finished; snapshot cleanup pending at {staging}: {exc}", RuntimeWarning)
            return
        # Only remove this empty parent. Other books may own sibling snapshots.
        try:
            staging.parent.rmdir()
        except OSError:
            pass

    @contextmanager
    def recoverable_book_change(self, book_id: str):
        """Compensate cross-connection/file writes; retain recovery data on failure."""
        key = lock_key(self.root, book_id)
        active = getattr(_book_changes, "active", None)
        if active is None:
            active = _book_changes.active = set()
        with book_lock(self.root, book_id):
            if key in active or delegated(self.root, book_id):
                yield
                return
            active.add(key)
            try:
                staging = self._planning_snapshot(book_id)
                try:
                    yield
                    self.write_json(staging / "manifest.json", {"state": "committed", "book_id": book_id})
                except Exception as original_error:
                    try:
                        self._restore_planning_snapshot(book_id, staging)
                    except Exception as rollback_error:
                        raise RuntimeError(f"book change failed; recovery snapshot retained at {staging}: {rollback_error}") from original_error
                    self._discard_planning_snapshot(staging)
                    raise
                else:
                    self._discard_planning_snapshot(staging)
            finally:
                active.discard(key)

    @book_operation(recoverable=True)
    def commit_outline_planning(
        self,
        book_id: str,
        *,
        master: dict[str, Any],
        chapters: list[dict[str, Any]],
        contract_update: dict[str, Any] | None = None,
        book_update: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Validate and commit every planning surface as one recoverable unit."""
        if not self.get_book(book_id):
            raise ValueError(f"book does not exist: {book_id}")
        normalized_master = self._normalize_master_outline(master)
        normalized_contracts, _ = self._normalize_outline_chapters(book_id, chapters)
        self._assert_outline_keeps_chapters(book_id, normalized_contracts)
        prospective_foundation = (
            self.preview_foundation_contract_delta(book_id, contract_update)
            if contract_update is not None
            else self.load_foundation_contract(book_id)
        )
        self._validate_outline_graph(book_id, normalized_master, normalized_contracts, prospective_foundation)
        if book_update is not None and not str(book_update.get("title") or "").strip():
            raise ValueError("book title cannot be empty")

        saved = self.save_master_outline(book_id, normalized_master)
        self.save_outline_chapters(book_id, chapters)
        foundation = (
            self.apply_foundation_contract_delta(book_id, contract_update)
            if contract_update is not None else self.load_foundation_contract(book_id)
        )
        if book_update is not None:
            self.update_book(
                book_id,
                title=str(book_update.get("title") or ""),
                metadata=dict(book_update.get("metadata")) if isinstance(book_update.get("metadata"), dict) else {},
            )
        return {
            "master": saved,
            "chapters": self.list_chapters(book_id),
            "foundation_contract": foundation,
            "planning_commit": {"status": "committed", "atomic": True},
        }

    @book_operation
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

    @book_operation
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

    @book_operation
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

    @book_operation
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

    def review_source(self, chapter: dict[str, Any], *, content: str | None = None) -> dict[str, Any] | None:
        """Bind the reviewed body/contract and all earlier chapter inputs.

        Read the dependency manifest afresh at every boundary. Publication
        states and future chapters are deliberately not review dependencies.
        """
        try:
            book_id, number = chapter["book_id"], int(chapter["chapter_number"])
            if content is None:
                content = self.read_content(book_id, number)
            if not content.strip():
                return None
            with self.connect() as connection:
                rows = connection.execute(
                    "SELECT * FROM chapters WHERE book_id=? AND chapter_number<? ORDER BY chapter_number",
                    (book_id, number),
                ).fetchall()
            dependencies = []
            for row in rows:
                item = dict(row)
                item["contract"] = json.loads(item.pop("contract_json"))
                dependencies.append(item)
            outline_path = self.book_dir(book_id) / "outlines" / "chapters.json"
            outline_present = outline_path.is_file()
            disk = {}
            if outline_present:
                disk_contracts, _ = self._normalize_outline_chapters(book_id, json.loads(outline_path.read_text(encoding="utf-8")))
                disk = {item.chapter_number: item.to_dict() for item in disk_contracts if item.chapter_number <= number}
                # Detect unsynced additions/removals, not only changed DB rows.
                if set(disk) != {item["chapter_number"] for item in [*dependencies, chapter]}:
                    return None

            def fingerprint(value: Any) -> str:
                return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()

            inputs = []
            for item in [*dependencies, chapter]:
                item_number = int(item["chapter_number"])
                body = content if item_number == number else self.read_content(book_id, item_number)
                digest = hashlib.sha256(body.encode("utf-8")).hexdigest() if body else None
                if digest != item.get("content_hash"):
                    return None
                contracts, _ = self._normalize_outline_chapters(book_id, [item["contract"]])
                contract = contracts[0].to_dict()
                if contract["chapter_number"] != item_number or (outline_present and disk.get(item_number) != contract):
                    return None
                inputs.append({"chapter_number": item_number, "content_hash": digest, "contract_hash": fingerprint(contract)})
            return {"version": 2, "book_id": book_id, **inputs[-1],
                    "outline_present": outline_present, "upstream_hash": fingerprint(inputs[:-1])}
        except (OSError, ValueError, TypeError, KeyError):
            return None

    def is_release_ready(self, book_id: str, chapter_number: int, *, content: str | None = None) -> bool:
        chapter = self.get_chapter(book_id, chapter_number)
        return self.approved_review_source(chapter, content=content) is not None

    def approved_review_source(self, chapter: dict[str, Any] | None, *, content: str | None = None) -> dict[str, Any] | None:
        """Return verified evidence once, for both eligibility and preview checks."""
        if not chapter or chapter.get("status") not in {"approved", "scheduled", "submitted", "published"} or not chapter.get("review_path"):
            return None
        review_path = Path(chapter["review_path"])
        if not review_path.is_file():
            return None
        try:
            value = json.loads(review_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        if not isinstance(value, dict):
            return None
        source = self.review_source(chapter, content=content)
        if source is None or value.get("release_source") != source:
            return None  # Legacy/unbound reviews require a new review, not a guessed approval.
        gates = value.get("gates", [])
        if not isinstance(gates, list) or any(not isinstance(item, dict) for item in gates):
            return None
        required = {"design_review", "review_logic", "review_voice", "review_continuity", "cold_review"}
        names = {str(item.get("gate")) for item in gates}
        passed = bool(
            value.get("book_id") == chapter["book_id"] and value.get("chapter_number") == chapter["chapter_number"]
            and value.get("passed") and value.get("strict_workflow") and names == required and len(gates) == len(required)
            and all(item.get("passed") and isinstance(item.get("evidence"), list) and item["evidence"]
                    and isinstance(item.get("findings", []), list)
                    and all(isinstance(finding, dict) and finding.get("status", "open") != "open" for finding in item.get("findings", [])) for item in gates)
        )
        return source if passed else None

    @book_operation
    def save_review(self, report: ReviewReport) -> Path:
        directory = self.book_dir(report.book_id) / "reviews"
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / f"chapter-{report.chapter_number:04d}.json"
        chapter = self.get_chapter(report.book_id, report.chapter_number)
        source = self.review_source(chapter) if chapter else None
        self.write_json(path, {**report.to_dict(), "release_source": source})
        path_md = directory / f"chapter-{report.chapter_number:04d}.md"
        path_md.write_text(report.to_markdown(), encoding="utf-8")
        # A legacy one-shot review is diagnostic only.  Approval requires all
        # strict workflow gates with evidence; this makes empty checklists
        # fail closed instead of silently preparing a release.
        strict_pass = source is not None and report.strict_workflow and report.passed and report.gates and all(
            gate.passed and gate.evidence and not any(item.status == "open" for item in gate.findings)
            for gate in report.gates
        )
        self.update_chapter_status(report.book_id, report.chapter_number, "approved" if strict_pass else "blocked", review_path=str(path))
        return path

    @book_operation
    def save_canon(self, book_id: str, chapter_number: int, snapshot: dict[str, Any]) -> Path:
        evidence = snapshot.get("evidence")
        if chapter_number > 0 and (not isinstance(evidence, list) or not evidence or not all(str(item).strip() for item in evidence)):
            raise ValueError("Canon 更新必须包含从最终正文提取的非空 evidence")
        path = self.book_dir(book_id) / "canon" / "current.json"
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute("UPDATE canon_snapshots SET invalidated_at=? WHERE book_id=? AND chapter_number>=? AND invalidated_at IS NULL", (utc_now(), book_id, chapter_number))
            connection.execute("INSERT INTO canon_snapshots(book_id,chapter_number,snapshot_json,created_at) VALUES(?,?,?,?)", (book_id, chapter_number, json.dumps(snapshot, ensure_ascii=False), utc_now()))
            self.write_json(path, {**snapshot, "chapter_number": chapter_number})
        self.append_event(book_id, chapter_number, "canon_updated", snapshot)
        return path

    def load_canon(self, book_id: str) -> dict[str, Any]:
        path = self.book_dir(book_id) / "canon" / "current.json"
        if not path.is_file():
            return {}
        return json.loads(path.read_text(encoding="utf-8"))

    def canon_before(self, book_id: str, chapter_number: int) -> dict[str, Any]:
        """Return the latest accepted Canon strictly before a chapter.

        This is read-only and is used to generate a replacement without
        leaking the old version of that chapter (or its downstream facts) back
        into the replacement prompt.
        """
        with self.connect() as connection:
            row = connection.execute(
                """
                SELECT chapter_number,snapshot_json FROM canon_snapshots
                WHERE book_id=? AND chapter_number<? AND invalidated_at IS NULL
                ORDER BY id DESC LIMIT 1
                """,
                (book_id, int(chapter_number)),
            ).fetchone()
        if not row:
            return {}
        value = json.loads(row["snapshot_json"])
        return {"chapter_number": int(row["chapter_number"]), **value}

    @book_operation
    def invalidate_canon_from(self, book_id: str, chapter_number: int, *, reason: str) -> dict[str, Any]:
        """Roll the active Canon pointer back without deleting accepted history.

        Candidate overrides can supersede a chapter after downstream work has
        begun.  The old cumulative snapshot is archived and remains in both the
        filesystem and ``canon_snapshots`` with an invalidation marker; only
        ancestors still on the accepted branch can restore ``current.json``.
        """
        chapter_number = int(chapter_number)
        canon_dir = self.book_dir(book_id) / "canon"
        current_path = canon_dir / "current.json"
        archived_path: Path | None = None
        if current_path.is_file():
            current = current_path.read_bytes()
            digest = hashlib.sha256(current + reason.encode("utf-8")).hexdigest()[:16]
            archived_path = canon_dir / ".invalidated" / f"from-{chapter_number:04d}-{digest}.json"
            archived_path.parent.mkdir(parents=True, exist_ok=True)
            if not archived_path.exists():
                archived_path.write_bytes(current)
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute("UPDATE canon_snapshots SET invalidated_at=? WHERE book_id=? AND chapter_number>=? AND invalidated_at IS NULL", (utc_now(), book_id, chapter_number))
            row = connection.execute(
                """
                SELECT chapter_number,snapshot_json FROM canon_snapshots
                WHERE book_id=? AND chapter_number<? AND invalidated_at IS NULL
                ORDER BY id DESC LIMIT 1
                """,
                (book_id, chapter_number),
            ).fetchone()
            restored_chapter: int | None = None
            if row:
                restored_chapter = int(row["chapter_number"])
                snapshot = json.loads(row["snapshot_json"])
                self.write_json(current_path, {**snapshot, "chapter_number": restored_chapter})
            else:
                current_path.unlink(missing_ok=True)
        result = {
            "invalidated_from_chapter": chapter_number,
            "restored_through_chapter": restored_chapter,
            "archived_path": str(archived_path) if archived_path else None,
            "reason": reason,
        }
        self.append_event(book_id, chapter_number, "canon_invalidated", result)
        return result

    @book_operation
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

    @book_operation
    def update_batch(self, batch_id: str, status: str) -> None:
        with self.connect() as connection:
            connection.execute("UPDATE publish_batches SET status=?,updated_at=?,submitted_at=? WHERE id=?", (status, utc_now(), utc_now() if status == "submitted" else None, batch_id))

    @book_operation(recoverable=True)
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

    @book_operation
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

    @book_operation
    def reset_canon(self, book_id: str, *, reason: str) -> Path:
        snapshot = {
            "chapter_number": 0,
            "characters": [], "facts": [], "relationships": [], "open_threads": [],
            "inventory": [], "locations": [], "timeline": [], "foreshadowing": [],
            "reset_reason": reason,
        }
        path = self.book_dir(book_id) / "canon" / "current.json"
        with self.connect() as connection:
            connection.execute("UPDATE canon_snapshots SET invalidated_at=? WHERE book_id=? AND invalidated_at IS NULL", (utc_now(), book_id))
            self.write_json(path, snapshot)
        self.append_event(book_id, None, "canon_reset", {"reason": reason})
        return path

    def _foundation_after_scoped_rebuild(
        self,
        book_id: str,
        contract: dict[str, Any],
        scope_type: str,
        scope_id: str,
        chapter_numbers: list[int],
    ) -> tuple[dict[str, Any], list[str]]:
        if not contract:
            return {}, []
        selected = {int(item) for item in chapter_numbers}
        kept: list[dict[str, Any]] = []
        removed: list[str] = []
        for item in self._active_constraint_items(book_id, contract):
            item_scope = str(item.get("scope_type") or "")
            item_scope_id = str(item.get("scope_id") or "")
            remove = (
                scope_type == "chapter" and item_scope == "chapter" and item_scope_id == str(int(scope_id))
                or scope_type == "volume" and (
                    item_scope == "volume" and item_scope_id == scope_id
                    or item_scope == "chapter" and item_scope_id.isdigit() and int(item_scope_id) in selected
                )
            )
            if remove:
                removed.append(str(item.get("constraint_id") or ""))
            else:
                kept.append(item)
        if not removed:
            return contract, []
        applied_at = utc_now()
        base = {
            "schema_version": "foundation-contract-v2",
            "revision": int(contract.get("revision") or 1) + 1,
            "parent_contract_hash": str(contract.get("contract_hash") or self._foundation_hash(contract)),
            "source_job_id": str(contract.get("source_job_id") or ""),
            "source_job_ids": [str(item) for item in contract.get("source_job_ids", [])] if isinstance(contract.get("source_job_ids"), list) else [],
            "generated_at": str(contract.get("generated_at") or applied_at),
            "applied_at": applied_at,
            "active_constraints": kept,
            "rationale": [*(
                [str(item) for item in contract.get("rationale", [])]
                if isinstance(contract.get("rationale"), list) else []
            ), f"{scope_type}/{scope_id} 已永久重建，对应局部约束同步退役"],
            "warnings": [str(item) for item in contract.get("warnings", [])] if isinstance(contract.get("warnings"), list) else [],
            "applied_fields": [str(item) for item in contract.get("applied_fields", [])] if isinstance(contract.get("applied_fields"), list) else [],
            "author_contract_snapshot": contract.get("author_contract_snapshot") if isinstance(contract.get("author_contract_snapshot"), dict) else {},
            "author_binding_snapshot": contract.get("author_binding_snapshot") if isinstance(contract.get("author_binding_snapshot"), dict) else {},
            "source_artifact_hashes": contract.get("source_artifact_hashes") if isinstance(contract.get("source_artifact_hashes"), dict) else {},
            "last_change_summary": {"added": [], "updated": [], "removed": removed, "unchanged": len(kept)},
        }
        return {**base, "contract_hash": self._foundation_hash(base)}, removed

    def preview_rebuild(self, book_id: str, scope_type: str, scope_id: str) -> dict[str, Any]:
        """Describe a permanent rebuild without changing files or databases.

        Rebuild used to mean "move another copy into ``books/<id>/.trash``".
        That left old prose, prompts and review artifacts inside the project and
        made a supposedly clean book look (and, to less careful readers, act)
        like it still had history.  A confirmed rebuild is now a real purge:
        only the explicitly retained identity/assets survive.
        """
        book = self.get_book(book_id)
        if not book:
            raise ValueError(f"book does not exist: {book_id}")
        if scope_type not in {"chapter", "volume", "book"}:
            raise ValueError("scope_type must be chapter, volume or book")
        chapters = self.list_chapters(book_id)
        if scope_type == "chapter":
            try:
                number = int(scope_id)
            except (TypeError, ValueError):
                raise ValueError("chapter scope_id must be a positive integer") from None
            selected = [number] if any(int(item["chapter_number"]) == number for item in chapters) else []
        elif scope_type == "volume":
            selected = [int(item["chapter_number"]) for item in chapters if str(item.get("contract", {}).get("volume_id") or "volume-1") == scope_id]
        else:
            selected = [int(item["chapter_number"]) for item in chapters]
        if scope_type != "book" and not selected:
            raise ValueError("selected rebuild scope has no local chapters")
        book_dir = self.book_dir(book_id)
        files: set[str] = set()
        if scope_type == "book":
            for child in book_dir.iterdir() if book_dir.is_dir() else []:
                if child.name != "assets":
                    files.add(str(child))
        else:
            if (book_dir / "outlines").exists():
                # Chapter and volume rebuilds rewrite the active outline set.
                # Stage the complete directory so old outline versions cannot
                # survive as hidden local artifacts and a failed write can
                # restore the exact pre-rebuild state.
                files.add(str(book_dir / "outlines"))
            if (book_dir / "workflow").exists():
                files.add(str(book_dir / "workflow"))
            if (book_dir / "canon").exists():
                files.add(str(book_dir / "canon"))
            if (book_dir / "audit").exists():
                files.add(str(book_dir / "audit"))
            for item in chapters:
                if int(item["chapter_number"]) not in selected:
                    continue
                for raw in [item.get("path"), item.get("review_path")]:
                    if raw and Path(str(raw)).exists():
                        files.add(str(Path(str(raw))))
            for root_name in ["reviews", "publish"]:
                root = book_dir / root_name
                if not root.is_dir():
                    continue
                for path in root.rglob("*"):
                    if not path.is_file():
                        continue
                    related = any(f"{number:04d}" in path.name or f"chapter-{number}" in path.name for number in selected)
                    if root_name == "publish" and path.suffix.lower() == ".json":
                        try:
                            payload = json.loads(path.read_text(encoding="utf-8"))
                            related = bool(set(int(item) for item in payload.get("chapter_numbers", [])).intersection(selected))
                        except (OSError, ValueError, TypeError, json.JSONDecodeError):
                            related = False
                    if related:
                        files.add(str(path))
            trash = book_dir / ".trash"
            if trash.is_dir():
                chapter_tokens = {f"chapter-{number:04d}" for number in selected}
                for archive in trash.iterdir():
                    related = any(token in archive.name.lower() for token in chapter_tokens)
                    if not related and archive.is_dir():
                        related = any(
                            any(token in path.name.lower() for token in chapter_tokens)
                            for path in archive.rglob("*")
                        )
                    if related:
                        # An archive namespace can contain shared workflow state
                        # whose meaning depends on the selected chapter.  Purge
                        # the namespace as a unit instead of leaving a misleading
                        # half-recoverable workflow behind.
                        files.add(str(archive))
        active_runs = [item["id"] for item in self.list_workflow_runs(book_id) if str(item.get("status")) == "running"]
        external = [int(item["chapter_number"]) for item in chapters if int(item["chapter_number"]) in selected and (item.get("platform_id") or str(item.get("status")) in {"submitted", "published"})]
        phrase = f"REBUILD BOOK {book_id}" if scope_type == "book" else f"DELETE VOLUME {scope_id}" if scope_type == "volume" else f"DELETE CHAPTER {scope_id}"
        return {
            "book_id": book_id, "scope_type": scope_type, "scope_id": scope_id,
            "chapter_numbers": sorted(selected), "file_paths": sorted(files),
            "confirmation_phrase": phrase,
            "blocked": bool(active_runs), "blockers": [f"运行中的严格工作流：{', '.join(active_runs)}"] if active_runs else [],
            "warnings": ([f"第 {', '.join(map(str, external))} 章已有平台提交记录；这里只清理本地，不会删除平台内容"] if external else []),
            "retained": (["作品编号", "作品标题", "assets/ 中的封面", "作者版本绑定（保证重建后仍可生成）"] if scope_type == "book" else ["未选章节正文与章纲", "作者绑定", "全书级与未选范围的有效规划约束"]),
            "cleared": ["选中范围的章纲与正文", "选中章/卷作用域的规划约束", "关联审查、Prompt 和返工记录", "依赖该范围的 Canon", "共享工作流快照", "本地发布预览、反馈与旧回收副本"],
            "permanent": True,
        }

    @book_operation
    @audit_operation
    def apply_rebuild(self, book_id: str, scope_type: str, scope_id: str, confirmation: str) -> dict[str, Any]:
        preview = self.preview_rebuild(book_id, scope_type, scope_id)
        if preview["blocked"]:
            raise ValueError("; ".join(preview["blockers"]))
        if confirmation != preview["confirmation_phrase"]:
            raise ValueError("confirmation phrase does not match rebuild preview")
        book = self.get_book(book_id) or {}
        book_dir = self.book_dir(book_id).resolve()
        purge_id = f"rebuild-{scope_type}-{scope_id}-{uuid.uuid4().hex[:12]}"
        staging_parent = (self.root / ".rebuild-staging").resolve()
        staging_root = (staging_parent / purge_id).resolve()
        if staging_parent.parent != self.root or staging_parent not in staging_root.parents:
            raise ValueError("unsafe rebuild staging path")

        numbers = list(preview["chapter_numbers"])
        earliest = min(numbers) if numbers else 1
        # Capture all information required to build the clean replacement
        # before any file is moved out of the live book directory.
        master = self.load_master_outline(book_id)
        prior_foundation = self.load_foundation_contract(book_id)
        rebuilt_foundation, removed_constraint_ids = self._foundation_after_scoped_rebuild(
            book_id, prior_foundation, scope_type, scope_id, numbers,
        ) if scope_type != "book" else ({}, [])
        chapters_outline = [
            item.get("contract", item) for item in self.list_chapters(book_id)
            if int(item["chapter_number"]) not in set(numbers)
        ]
        prior_canon: dict[str, Any] | None = None
        if scope_type != "book":
            prior_canon = self.canon_before(book_id, earliest) or None

        # The append-only workspace audit lives outside books/<id>; without
        # filtering it, a "clean" rebuild could still retain old feedback or
        # workflow summaries.  Keep an exact backup only for rollback and
        # remove every historical event for this book on successful rebuild.
        global_audit = self.root / "audit" / "events.jsonl"
        original_audit = global_audit.read_bytes() if global_audit.is_file() else None
        temporary_audit = global_audit.with_name(f".{global_audit.name}.{purge_id}.tmp")
        filtered_audit = b""
        if original_audit is not None:
            retained_lines: list[bytes] = []
            for line in original_audit.splitlines(keepends=True):
                try:
                    event = json.loads(line.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    retained_lines.append(line)
                    continue
                if str(event.get("book_id") or "") != book_id:
                    retained_lines.append(line)
            filtered_audit = b"".join(retained_lines)

        staged: list[tuple[Path, Path]] = []

        def retain_failed_restore(errors: list[str]) -> None:
            if errors:
                # Never delete the only surviving originals after a failed move.
                self.write_json(staging_root / "recovery.json", {
                    "book_id": book_id, "errors": errors,
                    "paths": [{"original": str(source), "staged": str(target)} for source, target in staged],
                })

        def restore_staged() -> list[str]:
            """Restore every moved path, reporting (rather than hiding) failures.

            Staging is deliberately outside SQLite's transaction, so a failed
            move must have its own compensating operation.  The helper is
            idempotent enough for the normal error path and is also used when
            a later move fails before the full set has been staged.
            """
            restore_errors: list[str] = []
            for source, staged_path in reversed(staged):
                try:
                    if not staged_path.exists():
                        continue
                    if source.exists():
                        if source.is_dir() and not source.is_symlink():
                            shutil.rmtree(source)
                        else:
                            source.unlink()
                    source.parent.mkdir(parents=True, exist_ok=True)
                    shutil.move(str(staged_path), str(source))
                except Exception as restore_error:  # pragma: no cover - filesystem dependent
                    restore_errors.append(f"{source}: {restore_error}")
            return restore_errors

        try:
            staging_root.mkdir(parents=True, exist_ok=True)
            if original_audit is not None:
                (staging_root / "original-global-events.jsonl").write_bytes(original_audit)
            for raw in preview["file_paths"]:
                source = Path(raw).resolve()
                if not source.exists():
                    continue
                if source == book_dir or book_dir not in source.parents or source.name == "assets":
                    raise ValueError(f"unsafe rebuild source: {source}")
                destination = staging_root / source.relative_to(book_dir)
                destination.parent.mkdir(parents=True, exist_ok=True)
                if destination.exists():
                    destination = destination.with_name(f"{destination.name}.{hashlib.sha256(str(source).encode()).hexdigest()[:8]}")
                try:
                    shutil.move(str(source), str(destination))
                except Exception:
                    # A platform/filesystem can fail after creating the
                    # destination (for example a cross-volume move).  Treat
                    # that as a staged item when it is visibly present so the
                    # compensating pass can recover it as well.
                    if destination.exists():
                        staged.append((source, destination))
                    raise
                staged.append((source, destination))
        except Exception as error:
            restore_errors = restore_staged()
            retain_failed_restore(restore_errors)
            if not restore_errors and staging_root.is_dir():
                shutil.rmtree(staging_root, ignore_errors=True)
            if staging_parent.is_dir() and not any(staging_parent.iterdir()):
                staging_parent.rmdir()
            temporary_audit.unlink(missing_ok=True)
            if restore_errors:
                raise OSError(
                    f"rebuild staging failed: {error}; recovery retained at {staging_root}; restore failed for: {'; '.join(restore_errors)}"
                ) from error
            raise

        try:
            with self.connect() as connection:
                connection.execute("BEGIN IMMEDIATE")
                try:
                    if scope_type == "book":
                        for table in ["chapters", "canon_snapshots", "publish_batches", "skill_runs", "workflow_runs", "events", "book_style_overrides"]:
                            connection.execute(f"DELETE FROM {table} WHERE book_id=?", (book_id,))
                        metadata = {
                            "author": "", "synopsis": "", "genre": "", "target_platform": "番茄小说",
                            "chapters_per_day": 2, "buffer_days": 7, "completion_mode": "open_ended", "target_chapters": None,
                        }
                        connection.execute("UPDATE books SET metadata_json=?,updated_at=? WHERE id=?", (json.dumps(metadata, ensure_ascii=False), utc_now(), book_id))
                    else:
                        placeholders = ",".join("?" for _ in numbers)
                        connection.execute(f"DELETE FROM chapters WHERE book_id=? AND chapter_number IN ({placeholders})", [book_id, *numbers])
                        connection.execute("DELETE FROM canon_snapshots WHERE book_id=? AND chapter_number>=?", (book_id, earliest))
                        rows = connection.execute("SELECT id,chapter_numbers_json FROM publish_batches WHERE book_id=?", (book_id,)).fetchall()
                        for row in rows:
                            if set(json.loads(row["chapter_numbers_json"])).intersection(numbers):
                                connection.execute("DELETE FROM publish_batches WHERE id=?", (row["id"],))
                        connection.execute("DELETE FROM workflow_runs WHERE book_id=?", (book_id,))
                        connection.execute("DELETE FROM skill_runs WHERE book_id=? AND chapter_number>=?", (book_id, earliest))
                        connection.execute("DELETE FROM events WHERE book_id=?", (book_id,))

                    # Build the clean scope before committing the database.  If
                    # any write fails, both database changes and staged files
                    # are restored as one operation.
                    for child in ["assets", "canon", "outlines", "drafts", "reviews", "publish", "audit", "workflow", ".trash"]:
                        (book_dir / child).mkdir(parents=True, exist_ok=True)
                    if scope_type == "book":
                        metadata = json.loads(connection.execute("SELECT metadata_json FROM books WHERE id=?", (book_id,)).fetchone()["metadata_json"])
                        self.write_structured(book_dir / "book.yaml", {"book_id": book_id, "title": book.get("title", book_id), **metadata, "created_at": book.get("created_at") or utc_now()})
                        self.write_json(book_dir / "outlines" / "master.json", {"version": 1, "completion_mode": "open_ended", "target_chapters": None, "premise": "", "core_conflict": "", "ending_direction": "未锁定", "major_beats": [], "volumes": [], "rolling_plan": {"window_size": 5, "planned_through": 0}, "updated_at": utc_now()})
                        self.write_json(book_dir / "outlines" / "chapters.json", [])
                        self.write_json(book_dir / "canon" / "current.json", {"chapter_number": 0, "characters": [], "facts": [], "relationships": [], "open_threads": [], "inventory": [], "locations": [], "timeline": []})
                    else:
                        if scope_type == "volume":
                            master["volumes"] = [item for item in master.get("volumes", []) if str(item.get("volume_id")) != scope_id]
                        master["rolling_plan"] = {**(master.get("rolling_plan") or {}), "planned_through": max((int(item.get("chapter_number") or 0) for item in chapters_outline), default=0)}
                        master["updated_at"] = utc_now()
                        self.write_json(book_dir / "outlines" / "master.json", master)
                        self.write_json(book_dir / "outlines" / "chapters.json", chapters_outline)
                        if rebuilt_foundation:
                            if removed_constraint_ids:
                                self._save_foundation_snapshot(book_id, {key: item for key, item in rebuilt_foundation.items() if key != "contract_hash"})
                            else:
                                self.write_json(book_dir / "outlines" / "foundation-contract.json", rebuilt_foundation)
                        self.write_json(book_dir / "canon" / "current.json", prior_canon or {"chapter_number": 0, "characters": [], "facts": [], "relationships": [], "open_threads": [], "inventory": [], "locations": [], "timeline": []})
                    if original_audit is not None:
                        temporary_audit.write_bytes(filtered_audit)
                        temporary_audit.replace(global_audit)
                    connection.commit()
                except Exception:
                    connection.rollback()
                    raise
        except Exception as error:
            # Best-effort restore while the originals are still isolated in the
            # staging directory.  Successful rebuilds never retain the staging
            # copy; failed rebuilds never silently discard user data.
            restore_errors = restore_staged()
            if original_audit is not None:
                try:
                    global_audit.parent.mkdir(parents=True, exist_ok=True)
                    global_audit.write_bytes(original_audit)
                except Exception as audit_error:
                    restore_errors.append(f"{global_audit}: {audit_error}")
            retain_failed_restore(restore_errors)
            if not restore_errors and staging_root.is_dir():
                shutil.rmtree(staging_root, ignore_errors=True)
            if staging_parent.is_dir() and not any(staging_parent.iterdir()):
                staging_parent.rmdir()
            temporary_audit.unlink(missing_ok=True)
            if restore_errors:
                raise OSError(
                    f"rebuild failed: {error}; recovery retained at {staging_root}; restore failed for: {'; '.join(restore_errors)}"
                ) from error
            raise

        deleted_paths = [str(source) for source, _ in staged]
        if staging_root.is_dir():
            shutil.rmtree(staging_root)
        if staging_parent.is_dir() and not any(staging_parent.iterdir()):
            staging_parent.rmdir()
        result = {
            **preview,
            "purge_id": purge_id,
            "deleted_paths": deleted_paths,
            "archived_paths": [],
            "removed_constraint_ids": removed_constraint_ids,
            "applied_at": utc_now(),
            "recoverable": False,
        }
        self.append_event(book_id, None, "rebuild_applied", {
            "scope_type": scope_type, "scope_id": scope_id,
            "chapter_numbers": numbers, "purge_id": purge_id,
            "deleted_path_count": len(deleted_paths), "recoverable": False,
        })
        return result

    @book_operation
    @audit_operation
    def append_event(self, book_id: str | None, chapter_number: int | None, event_type: str, payload: dict[str, Any]) -> None:
        event = {"book_id": book_id, "chapter_number": chapter_number, "event_type": event_type, "payload": payload, "created_at": utc_now()}
        (self.root / "audit").mkdir(parents=True, exist_ok=True)
        with (self.root / "audit" / "events.jsonl").open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(event, ensure_ascii=False) + "\n")
        if self.db_path.is_file():
            with self.connect() as connection:
                connection.execute("INSERT INTO events(book_id,chapter_number,event_type,payload_json,created_at) VALUES(?,?,?,?,?)", (book_id, chapter_number, event_type, json.dumps(payload, ensure_ascii=False), event["created_at"]))

    @book_operation
    def record_skill_run(self, book_id: str | None, chapter_number: int | None, stage: str, module_chain: list[str], skill_hash: str, prompt_hash: str | None, references: dict[str, Any] | None) -> None:
        if not self.db_path.is_file():
            self.initialize()
        with self.connect() as connection:
            connection.execute("INSERT INTO skill_runs(book_id,chapter_number,stage,module_chain_json,skill_hash,prompt_hash,references_json,created_at) VALUES(?,?,?,?,?,?,?,?)", (book_id, chapter_number, stage, json.dumps(module_chain), skill_hash, prompt_hash, json.dumps(references or {}, ensure_ascii=False), utc_now()))

    @book_operation
    def write_json(self, path: Path, value: Any) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temporary.replace(path)

    @book_operation
    def write_structured(self, path: Path, value: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        if yaml:
            path.write_text(yaml.safe_dump(value, allow_unicode=True, sort_keys=False), encoding="utf-8")
        else:
            path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
