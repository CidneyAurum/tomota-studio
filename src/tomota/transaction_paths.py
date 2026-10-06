"""Path guards shared by transaction snapshot participants."""
from pathlib import Path
import stat


def linked_path(path: Path) -> bool:
    if path.is_symlink():
        return True
    try:
        # Python <3.12 has no Path.is_junction(). Inspect Windows reparse
        # attributes too, so the developer and embedded runtimes agree.
        return bool(getattr(path.lstat(), "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0))
    except FileNotFoundError:
        return False


def checked_path(root: Path, path: Path) -> Path:
    relative = path.relative_to(root)
    if not relative.parts or ".." in relative.parts:
        raise ValueError("unsafe transaction recovery path")
    current = root
    for part in relative.parts:
        current = current / part
        if linked_path(current):
            raise ValueError("linked transaction recovery path")
    if not path.resolve().is_relative_to(root):
        raise ValueError("transaction recovery path escaped workspace")
    return path
