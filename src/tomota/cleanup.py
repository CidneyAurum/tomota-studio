from __future__ import annotations

import shutil
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable

from .store import ProjectStore


@dataclass
class CleanupReport:
    book_id: str
    apply: bool
    reclaimed_bytes: int = 0
    candidates: list[str] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)
    protected_roots: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return self.__dict__.copy()


class CleanupManager:
    """Seven-day project trash with an absolute 100 MB per-book ceiling.

    Purging is intentionally constrained to ``books/<id>/.trash``.  Final
    chapters, outlines, Canon, ledgers, and unresolved reviews are outside that
    root and therefore cannot be selected even if the caller passes a bad glob.
    """

    def __init__(self, store: ProjectStore, *, retention_days: int = 7, limit_mb: int = 100):
        self.store = store
        self.retention = timedelta(days=retention_days)
        self.limit_bytes = limit_mb * 1024 * 1024

    def run(self, book_id: str, *, apply: bool = False, now: datetime | None = None) -> CleanupReport:
        if not self.store.get_book(book_id):
            raise ValueError(f"book does not exist: {book_id}")
        book = self.store.book_dir(book_id).resolve()
        trash = (book / ".trash").resolve()
        if trash.parent != book:
            raise ValueError("unsafe trash path")
        trash.mkdir(parents=True, exist_ok=True)
        current = now or datetime.now(timezone.utc)
        files = sorted((path for path in trash.rglob("*") if path.is_file()), key=lambda item: item.stat().st_mtime)
        sizes = {path: path.stat().st_size for path in files}
        expired = {
            path for path in files
            if datetime.fromtimestamp(path.stat().st_mtime, timezone.utc) <= current - self.retention
        }
        selected = set(expired)
        remaining_size = sum(sizes.values()) - sum(sizes[path] for path in selected)
        for path in files:
            if remaining_size <= self.limit_bytes:
                break
            if path in selected:
                continue
            selected.add(path)
            remaining_size -= sizes[path]
        report = CleanupReport(
            book_id=book_id, apply=apply,
            candidates=[str(path) for path in sorted(selected)],
            protected_roots=[str(book / name) for name in ("drafts", "outlines", "canon", "reviews", "publish", "workflow")],
        )
        if not apply:
            report.reclaimed_bytes = sum(sizes[path] for path in selected)
            return report
        for path in sorted(selected):
            resolved = path.resolve()
            if trash not in resolved.parents:
                raise ValueError(f"refusing to remove path outside trash: {resolved}")
            size = sizes[path]
            path.unlink()
            report.removed.append(str(path))
            report.reclaimed_bytes += size
        for directory in sorted((path for path in trash.rglob("*") if path.is_dir()), reverse=True):
            try:
                directory.rmdir()
            except OSError:
                pass
        self.store.append_event(book_id, None, "trash_cleanup", report.to_dict())
        return report

    def archive(self, book_id: str, paths: Iterable[Path | str], *, namespace: str) -> list[Path]:
        book = self.store.book_dir(book_id).resolve()
        trash = (book / ".trash" / namespace).resolve()
        if book not in trash.parents:
            raise ValueError("unsafe archive namespace")
        moved: list[Path] = []
        for raw in paths:
            source = Path(raw).resolve()
            if not source.exists():
                continue
            if book not in source.parents or ".trash" in source.parts:
                raise ValueError(f"archive source outside book or already trashed: {source}")
            relative = source.relative_to(book)
            destination = trash / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            if destination.exists():
                suffix = datetime.now(timezone.utc).strftime(".%Y%m%dT%H%M%SZ")
                destination = destination.with_name(destination.name + suffix)
            shutil.move(str(source), str(destination))
            moved.append(destination)
        self.store.append_event(book_id, None, "artifacts_archived", {"namespace": namespace, "paths": [str(path) for path in moved]})
        return moved
