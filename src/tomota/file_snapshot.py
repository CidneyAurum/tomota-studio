"""A single-file recovery participant. It never snapshots or restores SQL."""
import shutil
import uuid
from pathlib import Path

from .transaction_paths import checked_path, linked_path


def editable_file(root: Path, book_id: str, path: Path) -> Path:
    supplied = path.absolute()
    if ".." in supplied.parts:
        raise ValueError("unsafe file transaction path")
    # Check the spelling supplied by the caller BEFORE resolving it. Resolving
    # first would hide a junction; not resolving would reject Windows 8.3 aliases.
    for component in (supplied, *supplied.parents):
        if linked_path(component):
            raise ValueError("linked file transaction path")
    target = checked_path(root, supplied.resolve())
    parts = target.relative_to(root / "books" / book_id).parts
    if len(parts) < 2 or parts[0] not in {"drafts", "outlines"}:
        raise ValueError("file transaction requires an editable book file")
    if target.suffix.lower() not in {".md", ".txt", ".json", ".yaml", ".yml", ".toml"}:
        raise ValueError("unsupported file transaction extension")
    if not target.is_file() or target.stat().st_nlink != 1:
        raise ValueError("file transaction refuses missing files and hardlinks")
    return target


def snapshot_file(store, book_id: str, path: Path) -> tuple[Path, str]:
    target = editable_file(store.root, book_id, path)
    staging = checked_path(store.root, store.root / ".planning-staging" / f"file-{uuid.uuid4().hex}")
    staging.mkdir(parents=True)
    shutil.copy2(target, staging / "payload")
    store.write_json(staging / "manifest.json", {"state": "prepared", "scope": "file", "book_id": book_id})
    return staging, target.relative_to(store.root).as_posix()


def restore_file(store, book_id: str, staging: Path, relative: str) -> None:
    target = editable_file(store.root, book_id, store.root / relative)
    payload = checked_path(store.root, staging / "payload")
    if not payload.is_file() or payload.stat().st_nlink != 1:
        raise ValueError("invalid single-file recovery snapshot")
    temporary = checked_path(store.root, target.with_name(f".{target.name}.{uuid.uuid4().hex}.restore"))
    try:
        shutil.copy2(payload, temporary)
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)
