"""Isolated regressions for the 2026-09-24 runtime audit. No live project data."""
import io
import json
import shutil
import tempfile
import unittest
from contextlib import redirect_stdout, redirect_stderr
from pathlib import Path
from unittest.mock import patch

from tomota.cli import main as cli_main
from tomota.models import ChapterContract
from tomota.store import ProjectStore
from tomota.publisher import FanqiePublisher, DryRunBrowserDriver, PublishBlocked
from tomota.browser_job import BrowserJobError
from tomota.workflow import WorkflowEngine, WorkflowError
import test_tomota as fixtures


class RuntimeRegressionTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.StrictStateMachineTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.root, self.store = self.fixture.root, self.fixture.store

    def approve_chapters(self, count=2):
        contracts = [ChapterContract("demo", n, str(n), "goal", "obstacle", "change", next_first_beat="next")
                     for n in range(1, count + 1)]
        self.store.save_outline_chapters("demo", [c.to_dict() for c in contracts])
        for c in contracts:
            body = f"Chapter {c.chapter_number} has exact regression evidence."
            fixtures.strict_approve(self.store, c, body)
            self.store.save_canon("demo", c.chapter_number, {"facts": [body], "evidence": [body]})
        return contracts

    def test_filesystem_changes_invalidate_downstream_reviews_and_canon(self):
        for kind in ("body", "outline", "empty", "missing"):
            with self.subTest(kind=kind):
                self.approve_chapters()
                book = self.store.book_dir("demo")
                draft = book / "drafts/chapter-0001.md"
                if kind == "outline":
                    target = book / "outlines/chapters.json"
                    rows = json.loads(target.read_text(encoding="utf-8"))
                    rows[0]["objective"] = "a different goal"
                    self.store.write_json(target, rows)
                elif kind == "missing":
                    draft.unlink()
                else:
                    draft.write_text("Different facts" if kind == "body" else "", encoding="utf-8")
                result = self.store.index_existing_books()
                self.assertEqual(result["invalidated_chapters"]["demo"], [1, 2])
                self.assertEqual(self.store.get_chapter("demo", 1)["status"], "modified_after_review")
                self.assertEqual(self.store.get_chapter("demo", 2)["status"], "invalidated")
                self.assertFalse(self.store.is_release_ready("demo", 1))
                self.assertFalse(self.store.is_release_ready("demo", 2))
                self.assertLess(self.store.load_canon("demo").get("chapter_number", 0), 1)
                self.assertEqual(self.store.index_existing_books()["invalidated_chapters"], {})

    def test_unchanged_sync_keeps_approvals(self):
        self.approve_chapters()
        self.assertEqual(self.store.index_existing_books()["invalidated_chapters"], {})
        self.assertTrue(self.store.is_release_ready("demo", 2))

    def test_release_rejects_unsynced_changes_and_unbound_legacy_reviews(self):
        for change in ("body", "missing", "empty", "outline", "removed_outline", "legacy_review", "wrong_identity"):
            with self.subTest(change=change):
                self.approve_chapters()
                chapter = self.store.get_chapter("demo", 1)
                path = Path(chapter["path"])
                outline = self.store.book_dir("demo") / "outlines/chapters.json"
                if change == "body":
                    path.write_text("Unreviewed replacement", encoding="utf-8")
                elif change == "missing":
                    path.unlink()
                elif change == "empty":
                    path.write_text("", encoding="utf-8")
                elif change == "outline":
                    data = json.loads(outline.read_text(encoding="utf-8"))
                    data[0]["objective"] = "unreviewed goal"
                    self.store.write_json(outline, data)
                elif change == "removed_outline":
                    outline.unlink()
                else:
                    data = json.loads(Path(chapter["review_path"]).read_text(encoding="utf-8"))
                    if change == "legacy_review":
                        del data["release_source"]
                    else:
                        data["chapter_number"] = 2
                    self.store.write_json(Path(chapter["review_path"]), data)
                self.assertFalse(self.store.is_release_ready("demo", 1))
                with self.assertRaises(PublishBlocked):
                    FanqiePublisher(self.store, DryRunBrowserDriver()).prepare_batch("demo", [1], {})

    def test_export_requires_both_current_approval_and_original_preview(self):
        contracts = self.approve_chapters()
        publisher = FanqiePublisher(self.store, DryRunBrowserDriver())
        batch = publisher.prepare_batch("demo", [1], {})
        Path(self.store.get_chapter("demo", 1)["path"]).write_text("Unreviewed body", encoding="utf-8")
        with self.assertRaises(BrowserJobError):
            publisher.export_browser_job(batch, confirmation=f"PUBLISH {batch.batch_id}")
        fixtures.strict_approve(self.store, contracts[0], "Newly reviewed replacement")
        self.assertTrue(self.store.is_release_ready("demo", 1))
        with self.assertRaisesRegex(BrowserJobError, "since preview"):
            publisher.export_browser_job(batch, confirmation=f"PUBLISH {batch.batch_id}")
        replacement = publisher.prepare_batch("demo", [1], {})
        self.assertTrue(publisher.export_browser_job(replacement, confirmation=f"PUBLISH {replacement.batch_id}").is_file())

    def test_downstream_release_rejects_unsynced_upstream_changes(self):
        for change in ("body", "missing_body", "empty_body", "outline", "removed", "reapproved", "removed_db"):
            with self.subTest(change=change):
                contracts = self.approve_chapters(3)
                publisher = FanqiePublisher(self.store, DryRunBrowserDriver())
                batch = publisher.prepare_batch("demo", [3], {})
                if change == "body":
                    Path(self.store.get_chapter("demo", 1)["path"]).write_text("Different upstream facts", encoding="utf-8")
                elif change == "missing_body":
                    Path(self.store.get_chapter("demo", 1)["path"]).unlink()
                elif change == "empty_body":
                    Path(self.store.get_chapter("demo", 1)["path"]).write_text("", encoding="utf-8")
                elif change == "reapproved":
                    fixtures.strict_approve(self.store, contracts[0], "Newly approved upstream facts")
                elif change == "removed_db":
                    with self.store.connect() as db:
                        db.execute("DELETE FROM chapters WHERE book_id='demo' AND chapter_number=1")
                else:
                    path = self.store.book_dir("demo") / "outlines/chapters.json"
                    data = json.loads(path.read_text(encoding="utf-8"))
                    if change == "outline":
                        data[0]["objective"] = "Different upstream goal"
                    else:
                        data = data[1:]
                    self.store.write_json(path, data)
                self.assertFalse(self.store.is_release_ready("demo", 3))
                with self.assertRaises(PublishBlocked):
                    publisher.prepare_batch("demo", [3], {})
                with self.assertRaises(BrowserJobError):
                    publisher.export_browser_job(batch, confirmation=f"PUBLISH {batch.batch_id}")

    def test_future_changes_and_publication_status_do_not_stale_prior_reviews(self):
        contracts = self.approve_chapters(3)
        fixtures.strict_approve(self.store, contracts[2], "Changed future chapter")
        self.store.update_chapter_status("demo", 1, "submitted", platform_id="fixture-1")
        path = self.store.book_dir("demo") / "outlines/chapters.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        data[2]["objective"] = "Different future goal"
        self.store.write_json(path, list(reversed(data)))
        self.assertTrue(self.store.is_release_ready("demo", 2))
        self.store.write_json(path, data[:2])
        self.assertTrue(self.store.is_release_ready("demo", 2))

    def test_release_detects_new_upstream_inputs_and_requires_fresh_preview(self):
        contracts = [ChapterContract("demo", n, str(n), "goal", "obstacle", "change") for n in (1, 2, 3)]
        outline = self.store.book_dir("demo") / "outlines/chapters.json"
        self.store.save_outline_chapters("demo", [contracts[n].to_dict() for n in (0, 2)])
        for n in (0, 2):
            fixtures.strict_approve(self.store, contracts[n], f"Reviewed chapter {n + 1}")
        publisher = FanqiePublisher(self.store, DryRunBrowserDriver())
        batch = publisher.prepare_batch("demo", [3], {})
        self.store.write_json(outline, [c.to_dict() for c in contracts])
        self.assertFalse(self.store.is_release_ready("demo", 3))  # Disk-only addition.
        self.store.write_json(outline, [contracts[n].to_dict() for n in (0, 2)])
        fixtures.strict_approve(self.store, contracts[1], "Inserted earlier facts")
        self.assertFalse(self.store.is_release_ready("demo", 3))  # DB-only addition.
        self.store.write_json(outline, [c.to_dict() for c in contracts])
        self.assertFalse(self.store.is_release_ready("demo", 3))  # Synced, but old review.
        fixtures.strict_approve(self.store, contracts[2], "Reviewed chapter 3")
        self.assertTrue(self.store.is_release_ready("demo", 3))
        with self.assertRaisesRegex(BrowserJobError, "since preview"):
            publisher.export_browser_job(batch, confirmation=f"PUBLISH {batch.batch_id}")
        replacement = publisher.prepare_batch("demo", [3], {})
        self.assertTrue(publisher.export_browser_job(replacement, confirmation=f"PUBLISH {replacement.batch_id}").is_file())

    def test_v1_review_cannot_prove_upstream_dependencies(self):
        self.approve_chapters()
        chapter = self.store.get_chapter("demo", 2)
        path = Path(chapter["review_path"])
        report = json.loads(path.read_text(encoding="utf-8"))
        report["release_source"]["version"] = 1
        del report["release_source"]["upstream_hash"]
        self.store.write_json(path, report)
        self.assertFalse(self.store.is_release_ready("demo", 2))

    def test_publication_validates_each_source_once_per_boundary(self):
        self.approve_chapters(3)
        publisher = FanqiePublisher(self.store, DryRunBrowserDriver())
        with patch.object(self.store, "review_source", wraps=self.store.review_source) as sources:
            batch = publisher.prepare_batch("demo", [2, 3], {})
        self.assertEqual(sources.call_count, 2)
        with patch.object(self.store, "review_source", wraps=self.store.review_source) as sources:
            publisher.export_browser_job(batch, confirmation=f"PUBLISH {batch.batch_id}")
        self.assertEqual(sources.call_count, 2)

    def test_export_uses_the_same_content_it_validated(self):
        self.approve_chapters()
        publisher = FanqiePublisher(self.store, DryRunBrowserDriver())
        batch = publisher.prepare_batch("demo", [1], {})
        original = self.store.read_content("demo", 1)
        with patch.object(self.store, "read_content", side_effect=[original, "Unreviewed second read"]) as read:
            path = publisher.export_browser_job(batch, confirmation=f"PUBLISH {batch.batch_id}")
        self.assertEqual(read.call_count, 1)
        self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["chapters"][0]["content"], original)

    def test_submit_and_reconcile_reject_unsynced_body_changes(self):
        self.approve_chapters()
        driver = DryRunBrowserDriver()
        publisher = FanqiePublisher(self.store, driver)
        batch = publisher.prepare_batch("demo", [1], {})
        path = publisher.export_browser_job(batch, confirmation=f"PUBLISH {batch.batch_id}")
        job = json.loads(path.read_text(encoding="utf-8"))
        Path(self.store.get_chapter("demo", 1)["path"]).write_text("Unreviewed body", encoding="utf-8")
        with patch.object(driver, "submit_chapter") as submit:
            result = publisher.submit_batch(batch, confirmation=f"PUBLISH {batch.batch_id}")
        self.assertEqual(result.status, "failed")
        submit.assert_not_called()
        result_path = self.root / "result.json"
        self.store.write_json(result_path, {"batch_id": batch.batch_id, "status": "submitted", "chapters": [{**job["chapters"][0], "status": "submitted"}]})
        with self.assertRaisesRegex(BrowserJobError, "content changed"):
            publisher.reconcile_browser_job(batch, result_path)

    def test_repeated_rework_never_reactivates_invalidated_canon(self):
        self.approve_chapters(3)
        engine = WorkflowEngine(self.root, skill_root=fixtures.SKILL_ROOT)
        engine.start_rework("demo", 1, "Replace first chapter facts")
        self.assertEqual(self.store.load_canon("demo"), {})
        run = engine.start_rework("demo", 3, "Revise third chapter")
        baseline = self.store.book_dir("demo") / "workflow" / run.run_id / "rework-baseline-canon.json"
        self.assertEqual(json.loads(baseline.read_text(encoding="utf-8")), {})
        self.assertEqual(self.store.load_canon("demo"), {})
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM canon_snapshots WHERE invalidated_at IS NOT NULL").fetchone()[0], 3)

    def test_new_canon_and_reset_retire_old_downstream_history(self):
        self.approve_chapters(3)
        self.store.save_canon("demo", 1, {"facts": ["replacement"], "evidence": ["replacement"]})
        self.assertEqual(self.store.canon_before("demo", 3)["facts"], ["replacement"])
        self.store.invalidate_canon_from("demo", 3, reason="later rework")
        self.assertEqual(self.store.load_canon("demo")["facts"], ["replacement"])
        self.store.reset_canon("demo", reason="reset")
        self.assertEqual(self.store.canon_before("demo", 4), {})
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM canon_snapshots").fetchone()[0], 4)

    def test_legacy_canon_migration_honors_current_pointer(self):
        self.approve_chapters(3)
        self.store.invalidate_canon_from("demo", 2, reason="old-version rollback")
        with self.store.connect() as db:
            db.execute("ALTER TABLE canon_snapshots DROP COLUMN invalidated_at")
        self.store.initialize()
        self.assertEqual(self.store.canon_before("demo", 4)["chapter_number"], 1)
        self.store.invalidate_canon_from("demo", 3, reason="after migration")
        self.assertEqual(self.store.load_canon("demo")["chapter_number"], 1)

    def test_outline_omission_rejects_before_any_planning_write(self):
        contracts = self.approve_chapters()
        book = self.store.book_dir("demo")
        before = {p.relative_to(book): p.read_bytes() for p in book.rglob("*") if p.is_file()}
        with self.assertRaisesRegex(ValueError, "专用章节删除"):
            self.store.commit_outline_planning("demo", master={"completion_mode": "fixed", "target_chapters": 1, "volumes": [{"volume_id": "volume-1"}]}, chapters=[contracts[0].to_dict()])
        with self.assertRaisesRegex(ValueError, "专用章节删除"):
            self.store.save_outline_chapters("demo", [contracts[0].to_dict()])
        self.assertEqual({p.relative_to(book): p.read_bytes() for p in book.rglob("*") if p.is_file()}, before)
        self.assertTrue(self.store.is_release_ready("demo", 2))

    def test_external_outline_removal_invalidates_but_preserves_bodies(self):
        contracts = self.approve_chapters(3)
        publisher = FanqiePublisher(self.store, DryRunBrowserDriver())
        batch = publisher.prepare_batch("demo", [2, 3], {})
        original = self.store.read_content("demo", 2)
        self.store.write_json(self.store.book_dir("demo") / "outlines/chapters.json", [contracts[0].to_dict(), contracts[2].to_dict()])
        self.assertFalse(self.store.is_release_ready("demo", 2))
        self.assertEqual(self.store.index_existing_books()["invalidated_chapters"]["demo"], [2, 3])
        self.assertEqual(self.store.get_chapter("demo", 2)["status"], "invalidated")
        self.assertFalse(self.store.is_release_ready("demo", 3))
        self.assertEqual(self.store.get_batch(batch.batch_id).status, "superseded")
        self.assertEqual(self.store.read_content("demo", 2), original)
        self.assertEqual(self.store.index_existing_books()["invalidated_chapters"], {})

    def test_first_external_draft_is_not_mistaken_for_a_changed_approved_body(self):
        contract = self.fixture.contract
        self.store.save_outline_chapters("demo", [contract.to_dict()])
        draft = self.store.book_dir("demo") / "drafts/chapter-0001.md"
        draft.write_text("First externally supplied draft", encoding="utf-8")
        result = self.store.index_existing_books()
        self.assertEqual(result["invalidated_chapters"], {})
        self.assertEqual(self.store.get_chapter("demo", 1)["status"], "draft_unreviewed")
        self.assertFalse(self.store.is_release_ready("demo", 1))

    def test_failed_rebuild_restore_retains_only_surviving_originals(self):
        self.approve_chapters()
        original = self.store.read_content("demo", 1)
        preview = self.store.preview_rebuild("demo", "book", "book")
        real_move, real_write = shutil.move, self.store.write_json

        def fail_restore(source, destination, *args, **kwargs):
            if ".rebuild-staging" in Path(source).parts:
                raise OSError("injected restore move failure")
            return real_move(source, destination, *args, **kwargs)

        def fail_rebuild(target, value):
            if Path(target).name == "master.json":
                raise OSError("injected rebuild write failure")
            return real_write(target, value)

        with patch("tomota.store.shutil.move", side_effect=fail_restore), patch.object(self.store, "write_json", side_effect=fail_rebuild):
            with self.assertRaisesRegex(OSError, "recovery retained.*restore failed"):
                self.store.apply_rebuild("demo", "book", "book", preview["confirmation_phrase"])
        recovery = list((self.root / ".rebuild-staging").rglob("recovery.json"))
        self.assertEqual(len(recovery), 1)
        manifest = json.loads(recovery[0].read_text(encoding="utf-8"))
        self.assertTrue(manifest["errors"])
        copies = list((recovery[0].parent / "drafts").rglob("chapter-0001.md"))
        self.assertEqual(len(copies), 1)
        self.assertEqual(copies[0].read_text(encoding="utf-8"), original)
        self.assertTrue((recovery[0].parent / "original-global-events.jsonl").is_file())
        self.assertIsNotNone(self.store.get_chapter("demo", 1))

    @staticmethod
    def arc_review(affected):
        return {"stage": "arc_review", "passed": not affected,
                **{key: "Concrete diagnosis" for key in ["story_engine", "pacing", "character_change", "foreshadow_density", "pattern_repetition", "conflict_escalation", "mainline_progress", "reader_promise_fulfillment"]},
                **{key: [] for key in ["foreshadow_backlog", "ending_hook_repetition", "low_change_scenes", "risks"]},
                "next_batch_adjustments": ["Change sequence"], "affected_chapters": affected,
                "preserve": ["Known facts"], "changes": ["Change scene"],
                "evidence": ["Chapter 3 has exact regression evidence."]}

    def arc_repair(self, affected):
        self.approve_chapters(3)
        self.store.save_chapter(ChapterContract("demo", 4, "four", "goal", "obstacle", "change", next_first_beat="next"), status="planned")
        engine = WorkflowEngine(self.root, skill_root=fixtures.SKILL_ROOT)
        run = engine.start("demo", [1, 2, 3, 4])
        run.current_stage, run.current_chapter, run.completed_chapters = "arc_review", 3, [1, 2, 3]
        self.store.save_workflow_run(run)
        action = engine.next_action(run.run_id)
        result = engine.submit(run.run_id, self.arc_review(affected), action_id=action["action_id"])
        self.assertEqual(engine.status(run.run_id)["status"], "superseded")
        return engine, engine._run(result["redirect_run_id"])

    def test_arc_repair_rechecks_then_continues_unfinished_queue(self):
        engine, run = self.arc_repair([3])
        self.assertEqual(run.chapter_numbers, [3, 4])
        run.completed_chapters = [3]
        engine._finish_or_next(run)
        self.assertEqual(run.current_stage, "arc_review")
        engine._submit_arc_review(run, self.arc_review([]))
        self.assertEqual((run.current_stage, run.current_chapter), ("chapter_design", 4))
        run.completed_chapters.append(4)
        engine._finish_or_next(run)
        self.assertEqual(run.status, "completed")

    def test_arc_repair_carries_invalidated_completed_dependencies(self):
        engine, run = self.arc_repair([2])
        self.assertEqual(run.chapter_numbers, [2, 3, 4])
        run.completed_chapters = [2]
        engine._finish_or_next(run)
        self.assertEqual((run.current_stage, run.current_chapter), ("chapter_design", 3))
        run.completed_chapters.append(3)
        engine._finish_or_next(run)
        self.assertEqual(run.current_stage, "arc_review")

    def test_long_feedback_and_rules_commit_together(self):
        self.approve_chapters()
        engine = WorkflowEngine(self.root, skill_root=fixtures.SKILL_ROOT)
        run = engine.start_feedback_rework("demo", [1], "长" * 3900 + "评" * 200,
                                          book_rules=[{"rule": "Keep concrete actions", "category": "节奏"}])
        self.assertEqual(run.current_stage, "chapter_design")
        self.assertEqual(len(engine.authors.list_overrides("demo")), 1)

    def test_feedback_failure_restores_rules_files_canon_and_chapter_state(self):
        self.approve_chapters()
        engine = WorkflowEngine(self.root, skill_root=fixtures.SKILL_ROOT)
        engine.authors.compile_policy("demo")
        book = self.store.book_dir("demo")
        files = {p.relative_to(book): p.read_bytes() for p in book.rglob("*") if p.is_file()}
        chapters, canon = self.store.list_chapters("demo"), self.store.load_canon("demo")
        with patch.object(engine, "_freeze_writing_policy", side_effect=OSError("injected after invalidation")):
            with self.assertRaisesRegex(OSError, "injected"):
                engine.start_feedback_rework("demo", [1], "Change sequence", book_rules=[{"rule": "New rule"}])
        self.assertEqual(engine.authors.list_overrides("demo"), [])
        self.assertEqual(self.store.list_workflow_runs("demo"), [])
        self.assertEqual(self.store.list_chapters("demo"), chapters)
        self.assertEqual(self.store.load_canon("demo"), canon)
        self.assertEqual({p.relative_to(book): p.read_bytes() for p in book.rglob("*") if p.is_file()}, files)

    def test_oversized_feedback_has_no_side_effects(self):
        self.approve_chapters()
        engine = WorkflowEngine(self.root, skill_root=fixtures.SKILL_ROOT)
        with self.assertRaisesRegex(WorkflowError, "12000"):
            engine.start_feedback_rework("demo", [1], "x" * 12001, book_rules=[{"rule": "New rule"}])
        self.assertEqual(engine.authors.list_overrides("demo"), [])
        self.assertEqual(self.store.list_workflow_runs("demo"), [])
        self.assertTrue(self.store.is_release_ready("demo", 1))

    def test_failed_create_cleans_children_and_preserves_original_validation_error(self):
        request = self.root / "request.json"
        self.store.write_json(request, {"book_id": "newbook", "title": "Failed fixture",
            "chapters": [ChapterContract("newbook", 1, "one", "goal", "obstacle", "change", next_first_beat="next").to_dict()],
            "planning_contract": {"constraints": {}}})
        output = io.StringIO()
        with redirect_stdout(output), redirect_stderr(output):
            code = cli_main(["--root", str(self.root), "book", "create", "--file", str(request), "--json"])
        self.assertEqual(code, 2)
        self.assertNotIn("FOREIGN KEY", output.getvalue())
        self.assertIn("error", output.getvalue())
        self.assertIsNone(self.store.get_book("newbook"))
        self.assertFalse(self.store.book_dir("newbook").exists())
        with self.store.connect() as connection:
            for table in ("chapters", "book_author_bindings", "book_style_overrides"):
                self.assertEqual(connection.execute(f"SELECT COUNT(*) FROM {table} WHERE book_id='newbook'").fetchone()[0], 0)
            self.assertEqual(connection.execute("PRAGMA foreign_key_check").fetchall(), [])


if __name__ == "__main__":
    unittest.main()
