from __future__ import annotations

from pathlib import Path

from .cleanup import CleanupManager
from .models import utc_now
from .store import ProjectStore


class StrictWorkflowMigrator:
    """Invalidate legacy approvals and archive bulky disposable artifacts."""

    def __init__(self, store: ProjectStore):
        self.store = store
        self.cleanup = CleanupManager(store)

    def migrate(self, book_id: str, *, chapters: list[int] | None = None, force: bool = False) -> dict:
        chapters = chapters or [1, 2]
        book_dir = self.store.book_dir(book_id)
        if not self.store.get_book(book_id):
            raise ValueError(f"book does not exist: {book_id}")
        marker_path = book_dir / "audit" / "strict-workflow-migration.json"
        if marker_path.is_file() and not force:
            raise ValueError("strict workflow migration already completed; refusing to archive current final assets")
        candidates: list[Path] = []
        candidates.extend((book_dir / "drafts").glob("*"))
        candidates.extend((book_dir / "reviews").glob("chapter-*"))
        candidates.extend((book_dir / "audit").glob("*.handoff.md"))
        planning_prompt = book_dir / "outlines" / "planning.prompt.md"
        if planning_prompt.is_file():
            candidates.append(planning_prompt)
        canon = book_dir / "canon" / "current.json"
        if canon.is_file():
            candidates.append(canon)
        namespace = "legacy-strict-migration-" + utc_now().replace(":", "-")
        moved = self.cleanup.archive(book_id, candidates, namespace=namespace)
        invalidated = self.store.invalidate_chapters(book_id, chapters, reason="旧流程无严格证据链，按严格写作计划作废")
        with self.store.connect() as connection:
            connection.execute(
                "UPDATE chapters SET status='planned',path=NULL,content_hash=NULL,word_count=0,review_path=NULL WHERE book_id=? AND chapter_number NOT IN ({})".format(",".join("?" for _ in chapters)),
                [book_id, *chapters],
            )
        self.store.reset_canon(book_id, reason="旧两章撤销通过；Canon 必须从严格通过的最终正文重新提取")
        marker = {
            "book_id": book_id, "migrated_at": utc_now(), "invalidated_chapters": chapters,
            "superseded_batches": invalidated["batches"], "archived_files": [str(path) for path in moved],
            "retention_days": 7, "note": "回收内容可在七天内手动恢复；清理命令默认仅预览",
        }
        self.store.write_json(marker_path, marker)
        return marker
