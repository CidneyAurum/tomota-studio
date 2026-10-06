"""Real subprocess/file/SQLite regressions; all data lives in temp projects."""
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
import time
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from tomota.book_lock import BookBusyError, owner_path
from tomota.book_transaction import coordinate
from tomota.store import ProjectStore


class BookTransactionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="tomota-transactions-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.store = ProjectStore(self.root)
        self.store.create_book("demo", "Original", {})
        self.env = {**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src"),
                    "PYTHONUTF8": "1", "PYTHONDONTWRITEBYTECODE": "1",
                    "TOMOTA_BOOK_TRANSACTION": "", "TOMOTA_BOOK_TRANSACTION_BOOK": ""}
        self.children = []
        self.addCleanup(self.stop_children)

    def stop_children(self):
        for child in self.children:
            if child.poll() is None:
                child.kill()
            child.communicate(timeout=10)

    def spawn(self, args, env=None):
        child = subprocess.Popen([sys.executable, *args], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, text=True, encoding="utf-8", env=env or self.env,
                                 creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        self.children.append(child)
        return child

    def start(self):
        child = self.spawn(["-m", "tomota.book_transaction", "--root", str(self.root), "--book-id", "demo"])
        ready = json.loads(child.stdout.readline())
        self.assertEqual(ready["status"], "ready", ready)
        return child, ready["token"]

    def update(self, token, title="Changed", book="demo"):
        payload = self.root / "update.json"
        payload.write_text(json.dumps({"title": title, "metadata": {}}), encoding="utf-8")
        child = self.spawn(["-m", "tomota", "--root", str(self.root), "book", "update", "--book-id", "demo", "--file", str(payload), "--json"],
                           {**self.env, "TOMOTA_BOOK_TRANSACTION": token, "TOMOTA_BOOK_TRANSACTION_BOOK": book})
        stdout, stderr = child.communicate(timeout=15)
        self.assertEqual(stderr, "")
        return child.returncode, json.loads(stdout)

    def finish(self, child, command):
        stdout, stderr = child.communicate(command, timeout=15)
        self.assertEqual(stderr, "")
        return json.loads(stdout)

    def test_real_cli_delegation_commits_or_restores_files_and_database(self):
        for command, expected in [("commit\n", "Changed"), ("rollback\n", "Original"), ("", "Original")]:
            with self.subTest(command=command):
                self.store.update_book_title("demo", "Original")
                files_before = {p.relative_to(self.root): p.read_bytes() for p in self.store.book_dir("demo").rglob("*") if p.is_file()}
                child, token = self.start()
                self.assertEqual(self.update(token)[0], 0)
                self.assertEqual(self.store.get_book("demo")["title"], "Changed")
                with self.assertRaises(BookBusyError):
                    self.store.update_book_title("demo", "Outsider")
                result = self.finish(child, command)
                self.assertEqual(result["status"], "committed" if command.startswith("commit") else "rolled_back")
                self.assertEqual(self.store.get_book("demo")["title"], expected)
                if expected == "Original":
                    for path, content in files_before.items():
                        self.assertEqual((self.root / path).read_bytes(), content)
                self.assertFalse(owner_path(self.root, "demo").exists())
                self.assertFalse((self.root / ".planning-staging").exists())

    def test_cli_missing_or_stale_delegation_fails_with_json(self):
        child, token = self.start()
        code, value = self.update(token, book="")
        self.assertEqual(code, 2)
        self.assertIn("作品编号", value["message"])
        child.kill()
        child.communicate(timeout=10)
        code, value = self.update(token)
        self.assertEqual(code, 2)
        self.assertIn("协调进程已退出", value["message"])
        self.assertEqual(self.store.get_book("demo")["title"], "Original")
        self.assertEqual(coordinate(self.store, "demo", recover=True)["status"], "rolled_back")

    def test_durable_studio_commit_wins_over_lost_pipe_or_rollback(self):
        for command in ["", "rollback\n"]:
            with self.subTest(command=command):
                child, token = self.start()
                self.assertEqual(self.update(token)[0], 0)
                with closing(sqlite3.connect(self.root / "studio.db")) as db, db:
                    db.execute("CREATE TABLE IF NOT EXISTS book_transaction_commits(transaction_id TEXT PRIMARY KEY,book_id TEXT)")
                    db.execute("INSERT INTO book_transaction_commits VALUES(?,?)", (token, "demo"))
                self.assertEqual(self.finish(child, command)["status"], "committed")
                self.assertEqual(self.store.get_book("demo")["title"], "Changed")

    def test_recovery_waits_for_inflight_borrower_and_then_restores(self):
        coordinator, token = self.start()
        borrower = self.spawn(["-c", """
import sys
from tomota.book_lock import delegated_cli
from tomota.store import ProjectStore
s=ProjectStore(sys.argv[1])
with delegated_cli(s.root,'demo'):
 s.update_book_title('demo','In flight')
 print('ready',flush=True)
 sys.stdin.readline()
 s.update_book_title('demo','Late write')
""", str(self.root)], {**self.env, "TOMOTA_BOOK_TRANSACTION": token})
        self.assertEqual(borrower.stdout.readline().strip(), "ready")
        coordinator.kill()
        coordinator.communicate(timeout=10)
        recovery = self.spawn(["-m", "tomota.book_transaction", "--root", str(self.root), "--book-id", "demo", "--recover"])
        deadline = time.monotonic() + 10
        while json.loads(owner_path(self.root, "demo").read_text(encoding="utf-8"))["state"] != "closing":
            self.assertLess(time.monotonic(), deadline)
            time.sleep(0.01)
        # The active borrower owns the lease regardless of process scheduling.
        self.assertEqual(self.store.get_book("demo")["title"], "In flight")
        self.assertIsNone(recovery.poll())
        borrower.communicate("finish\n", timeout=15)
        self.assertEqual(borrower.returncode, 0)
        self.assertEqual(self.finish(recovery, "")["status"], "rolled_back")
        self.assertEqual(self.store.get_book("demo")["title"], "Original")

    def test_failed_compensation_keeps_snapshot_and_blocks_writes_until_recovery(self):
        child, token = self.start()
        self.assertEqual(self.update(token)[0], 0)
        child.kill()
        child.communicate(timeout=10)
        with patch.object(self.store, "_restore_planning_snapshot", side_effect=OSError("injected restore failure")):
            with self.assertRaisesRegex(OSError, "injected restore"):
                coordinate(self.store, "demo", recover=True)
        marker = json.loads(owner_path(self.root, "demo").read_text(encoding="utf-8"))
        self.assertTrue(Path(marker["snapshot"]).is_dir())
        with self.assertRaises(BookBusyError):
            self.store.update_book_title("demo", "Unsafe overwrite")
        self.assertEqual(coordinate(self.store, "demo", recover=True)["status"], "rolled_back")
        self.assertEqual(self.store.get_book("demo")["title"], "Original")

    def test_recovery_after_snapshot_discard_does_not_need_a_second_restore(self):
        child, token = self.start()
        self.assertEqual(self.update(token)[0], 0)
        child.kill()
        child.communicate(timeout=10)
        original_unlink = Path.unlink
        marker = owner_path(self.root, "demo")
        def fail_owner(path, *args, **kwargs):
            if path == marker:
                raise OSError("injected owner removal failure")
            return original_unlink(path, *args, **kwargs)
        with patch.object(Path, "unlink", fail_owner):
            with self.assertRaisesRegex(OSError, "owner removal"):
                coordinate(self.store, "demo", recover=True)
        self.assertFalse((self.root / ".planning-staging").exists())
        self.assertEqual(coordinate(self.store, "demo", recover=True)["status"], "rolled_back")

    def test_dead_coordinator_recovery_uses_studio_decision_for_staged_files(self):
        for committed in [False, True]:
            with self.subTest(committed=committed):
                self.store.update_book_title("demo", "Original")
                source = self.root / ".tomota-studio" / "jobs" / "artifact.json"
                source.parent.mkdir(parents=True, exist_ok=True)
                source.write_bytes(b"Original Studio artifact.\r\n")
                child, token = self.start()
                self.assertEqual(self.update(token)[0], 0)
                directory = self.root / ".tomota-studio" / "rebuild-staging" / token
                (directory / "files").mkdir(parents=True)
                (directory / "manifest.json").write_text(json.dumps({
                    "version": 1, "token": token, "book_id": "demo",
                    "moves": [{"source": source.relative_to(self.root).as_posix(), "staged": "files/0"}],
                }), encoding="utf-8")
                source.rename(directory / "files" / "0")
                if committed:
                    with closing(sqlite3.connect(self.root / "studio.db")) as db, db:
                        db.execute("CREATE TABLE IF NOT EXISTS book_transaction_commits(transaction_id TEXT PRIMARY KEY,book_id TEXT)")
                        db.execute("INSERT INTO book_transaction_commits VALUES(?,?)", (token, "demo"))
                child.kill()
                child.communicate(timeout=10)
                result = coordinate(self.store, "demo", recover=True)
                self.assertEqual(result["status"], "committed" if committed else "rolled_back")
                self.assertEqual(self.store.get_book("demo")["title"], "Changed" if committed else "Original")
                if committed:
                    self.assertFalse(source.exists())
                else:
                    self.assertEqual(source.read_bytes(), b"Original Studio artifact.\r\n")
                self.assertFalse(directory.exists())
                self.assertFalse(owner_path(self.root, "demo").exists())

    def test_recovery_does_not_override_a_live_coordinator(self):
        child, token = self.start()
        self.assertEqual(self.update(token)[0], 0)
        with self.assertRaises(BookBusyError):
            coordinate(self.store, "demo", recover=True)
        self.assertEqual(self.store.get_book("demo")["title"], "Changed")
        self.assertEqual(self.finish(child, "rollback\n")["status"], "rolled_back")
        self.assertEqual(self.store.get_book("demo")["title"], "Original")

    def test_snapshot_cleanup_failure_retains_recovery_marker(self):
        child, token = self.start()
        self.assertEqual(self.update(token)[0], 0)
        child.kill()
        child.communicate(timeout=10)
        with patch.object(self.store, "_discard_planning_snapshot", return_value=None):
            with self.assertRaisesRegex(OSError, "snapshot cleanup pending"):
                coordinate(self.store, "demo", recover=True)
        marker = json.loads(owner_path(self.root, "demo").read_text(encoding="utf-8"))
        self.assertTrue(marker["restored"])
        self.assertTrue(Path(marker["snapshot"]).is_dir())
        with self.assertRaises(BookBusyError):
            self.store.update_book_title("demo", "Unsafe overwrite")
        self.assertEqual(coordinate(self.store, "demo", recover=True)["status"], "rolled_back")
        self.assertEqual(self.store.get_book("demo")["title"], "Original")

    def test_single_file_snapshot_is_bounded_and_recovers_without_touching_other_files(self):
        target = self.store.book_dir("demo") / "drafts" / "chapter.md"
        target.parent.mkdir(exist_ok=True)
        target.write_bytes(b"Original single file\r\n")
        sibling = target.with_name("other.md")
        sibling.write_bytes(b"x" * 1_000_000)
        before_title = self.store.get_book("demo")["title"]
        child = self.spawn(["-m", "tomota.book_transaction", "--root", str(self.root), "--book-id", "demo", "--file", str(target)])
        ready = json.loads(child.stdout.readline())
        self.assertEqual(ready["status"], "ready")
        marker = json.loads(owner_path(self.root, "demo").read_text(encoding="utf-8"))
        snapshot = Path(marker["snapshot"])
        self.assertEqual(marker["scope"], "file")
        self.assertLess(sum(p.stat().st_size for p in snapshot.rglob("*") if p.is_file()), 1000)
        self.assertEqual(self.update(ready["token"])[0], 2, "file leases must reject delegated book mutations")
        target.write_bytes(b"Changed")
        sibling.write_bytes(b"Other contents must survive")
        child.kill(); child.communicate(timeout=10)
        self.assertEqual(coordinate(self.store, "demo", recover=True)["status"], "rolled_back")
        self.assertEqual(target.read_bytes(), b"Original single file\r\n")
        self.assertEqual(sibling.read_bytes(), b"Other contents must survive")
        self.assertEqual(self.store.get_book("demo")["title"], before_title)

    def test_single_file_transaction_commit_and_scope_guards(self):
        target = self.store.book_dir("demo") / "drafts" / "chapter.md"
        target.parent.mkdir(exist_ok=True); target.write_text("Original", encoding="utf-8")
        child = self.spawn(["-m", "tomota.book_transaction", "--root", str(self.root), "--book-id", "demo", "--file", str(target)])
        self.assertEqual(json.loads(child.stdout.readline())["status"], "ready")
        target.write_text("Committed", encoding="utf-8")
        self.assertEqual(self.finish(child, "commit\n")["status"], "committed")
        self.assertEqual(target.read_text(encoding="utf-8"), "Committed")
        from tomota.file_snapshot import snapshot_file
        for forbidden in [self.root / "tomota.db", self.store.book_dir("demo") / "canon" / "state.json", target.parent / ".." / ".." / "escape.md"]:
            with self.assertRaises(ValueError):
                snapshot_file(self.store, "demo", forbidden)


if __name__ == "__main__":
    unittest.main()
