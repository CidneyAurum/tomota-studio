"""Private file/SQLite coordinator; durable Studio decisions survive pipe loss.

After coordinator death, writes stay blocked by the owner marker. Recover with
python -m tomota.book_transaction --root ROOT --book-id BOOK --recover.
Recovery never overwrites a live coordinator and retains failed compensation.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sqlite3
import sys
import uuid
from pathlib import Path

from .book_lock import book_lock, owner_path
from .store import ProjectStore
from .transaction_paths import checked_path
from .file_snapshot import snapshot_file, restore_file


def studio_committed(root: Path, book_id: str, token: str) -> bool:
    database = root / "studio.db"
    if not database.exists():
        return False
    connection = sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)
    try:
        if not connection.execute("SELECT 1 FROM sqlite_master WHERE name='book_transaction_commits' AND type='table'").fetchone():
            return False
        return connection.execute("SELECT 1 FROM book_transaction_commits WHERE transaction_id=? AND book_id=?", (token, book_id)).fetchone() is not None
    finally:
        connection.close()


def finish_studio_files(root: Path, book_id: str, token: str, committed: bool) -> None:
    directory = checked_path(root, root / ".tomota-studio" / "rebuild-staging" / token)
    if not directory.exists():
        return
    manifest_path = checked_path(root, directory / "manifest.json")
    if not manifest_path.exists():
        directory.rmdir()  # Only an empty, already-cleaned directory is safe.
        return
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("version") != 1 or manifest.get("token") != token or manifest.get("book_id") != book_id:
        raise ValueError("invalid Studio recovery manifest")
    moves = []
    for index, move in enumerate(manifest["moves"]):
        if move.get("staged") != f"files/{index}":
            raise ValueError("invalid Studio staging entry")
        source = checked_path(root, root / move["source"])
        staged = checked_path(root, directory / move["staged"])
        moves.append((source, staged))
    if not committed:
        for source, staged in reversed(moves):
            if not staged.exists():
                continue
            if source.exists():
                raise ValueError(f"recovery refuses to overwrite {source}")
            source.parent.mkdir(parents=True, exist_ok=True)
            staged.rename(source)
    files = checked_path(root, directory / "files")
    if files.exists():
        shutil.rmtree(files)
    manifest_path.unlink()
    directory.rmdir()
    try:
        directory.parent.rmdir()
    except OSError:
        pass


def coordinate(store: ProjectStore, book_id: str, *, recover=False, file=None) -> dict:
    owner = owner_path(store.root, book_id)
    with book_lock(store.root, book_id, allow_pending=recover):
        if recover:
            value = json.loads(owner.read_text(encoding="utf-8"))
            if value.get("book_id") != book_id or not re.fullmatch(r"[a-f0-9]{32}", value.get("token", "")):
                raise ValueError("invalid transaction owner marker")
            token = value["token"]
            staging = checked_path(store.root, Path(value["snapshot"]))
            if staging.parent != store.root / ".planning-staging":
                raise ValueError("invalid book recovery snapshot")
            command = "recover"
        else:
            if not store.get_book(book_id):
                raise ValueError("transaction book does not exist")
            if file is not None:
                staging, target = snapshot_file(store, book_id, Path(file))
            else:
                staging = store._planning_snapshot(book_id)
            token = uuid.uuid4().hex
            value = {"book_id": book_id, "token": token, "snapshot": str(staging), "state": "active"}
            if file is not None:
                value.update(scope="file", file=target)
            store.write_json(owner, value)
            print(json.dumps({"status": "ready", "token": token}), flush=True)
            command = sys.stdin.readline().strip()
        # Revoke late borrowers BEFORE waiting for the in-flight child lease.
        value["state"] = "closing"
        store.write_json(owner, value)
        with book_lock(store.root, f":borrow:{book_id}", wait_timeout=30):
            committed = (value.get("decision") == "commit" or studio_committed(store.root, book_id, token)
                         or command == "commit")
            value["decision"] = "commit" if committed else "rollback"
            store.write_json(owner, value)
            # Failure keeps BOTH snapshot and marker, blocking new writes until
            # explicit recovery completes. A durable commit never rolls back.
            finish_studio_files(store.root, book_id, token, committed)
            if not committed and not value.get("restored"):
                if value.get("scope") == "file":
                    restore_file(store, book_id, staging, value["file"])
                else:
                    store._restore_planning_snapshot(book_id, staging)
                value["restored"] = True
                store.write_json(owner, value)
            if staging.exists():
                store.write_json(staging / "manifest.json", {"state": "committed" if committed else "rolled_back", "book_id": book_id})
                store._discard_planning_snapshot(staging)
                if staging.exists():
                    raise OSError(f"transaction snapshot cleanup pending at {staging}")
            owner.unlink()
            return {"status": "committed" if committed else "rolled_back"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--book-id", required=True)
    parser.add_argument("--recover", action="store_true")
    parser.add_argument("--file")
    args = parser.parse_args()
    try:
        result = coordinate(ProjectStore(args.root), args.book_id, recover=args.recover, file=args.file)
    except Exception as exc:
        print(json.dumps({"status": "error", "message": str(exc), "recovery": str(owner_path(args.root, args.book_id))}), flush=True)
        return 1
    print(json.dumps(result), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
