"""Cross-process book write isolation. OS locks are released on process exit.

Reentrancy is per logical thread, not per ProjectStore object. A Studio
transaction may explicitly delegate its lock to short-lived CLI children.
"""
from __future__ import annotations

import hashlib
import inspect
import json
import os
import threading
import time
from contextlib import contextmanager
from functools import wraps
from pathlib import Path


class BookBusyError(RuntimeError):
    pass


_local = threading.local()
_mutex = threading.Lock()
_locks: dict[str, threading.RLock] = {}


def lock_key(root, book_id):
    return hashlib.sha256(f"{os.path.normcase(str(Path(root).resolve()))}\0{book_id}".encode()).hexdigest()


def owner_path(root, book_id):
    return Path(root).resolve() / ".tomota-locks" / f"{lock_key(root, book_id)}.owner.json"


def delegated(root, book_id):
    token = os.environ.get("TOMOTA_BOOK_TRANSACTION", "")
    if not token:
        return False
    try:
        value = json.loads(owner_path(root, book_id).read_text(encoding="utf-8"))
        if value.get("scope") == "file":
            return False  # Editor-only lease; no delegated SQL/book writes.
        in_flight = lock_key(root, book_id) in getattr(_local, "held", set())
        return (value.get("token") == token and value.get("book_id") == book_id
                and (value.get("state", "active") == "active" or in_flight))
    except (OSError, ValueError):
        return False


@contextmanager
def book_lock(root, book_id, *, allow_pending=False, wait_timeout=0):
    key = lock_key(root, book_id)
    held = getattr(_local, "held", None)
    if held is None:
        held = _local.held = set()
    if key in held:
        yield
        return
    with _mutex:
        mutex = _locks.setdefault(key, threading.RLock())
    acquired_mutex = mutex.acquire(timeout=wait_timeout) if wait_timeout else mutex.acquire(blocking=False)
    if not acquired_mutex:
        raise BookBusyError("同一本书有写入操作正在提交，请稍后重试")
    handle = None
    acquired = False
    try:
        directory = Path(root).resolve() / ".tomota-locks"
        directory.mkdir(parents=True, exist_ok=True)
        handle = (directory / f"{key}.lock").open("a+b")
        if handle.tell() == 0:
            handle.write(b"\0")
            handle.flush()
        handle.seek(0)
        deadline = time.monotonic() + wait_timeout
        while True:
            try:
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError as exc:
                if time.monotonic() >= deadline:
                    raise BookBusyError("同一本书有其他进程正在写入，请稍后重试") from exc
                time.sleep(min(0.05, max(0, deadline - time.monotonic())))
        acquired = True
        if not allow_pending and owner_path(root, book_id).exists():
            raise BookBusyError(f"作品存在未完成事务，禁止覆盖；请先恢复 {owner_path(root, book_id)}")
        held.add(key)
        yield
    finally:
        held.discard(key)
        if handle is not None:
            if acquired:
                handle.seek(0)
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(handle, fcntl.LOCK_UN)
            handle.close()
        mutex.release()


@contextmanager
def delegated_cli(root, book_id):
    """Hold a borrower lease for the ENTIRE child command, not each write.

    The coordinator must obtain the same lease before restoring a snapshot.
    A late child cannot borrow after the owner marker has been removed.
    """
    token = os.environ.get("TOMOTA_BOOK_TRANSACTION", "")
    if not token:
        yield
        return
    if not book_id:
        raise BookBusyError("事务子命令缺少作品编号")
    with book_lock(root, f":borrow:{book_id}"):
        if not delegated(root, book_id):
            raise BookBusyError("作品事务已结束或委托令牌无效")
        # A stale marker after coordinator death is not a live delegation.
        try:
            with book_lock(root, book_id, allow_pending=True):
                pass
        except BookBusyError:
            pass  # The coordinator still owns the OS book lock.
        else:
            raise BookBusyError("作品事务协调进程已退出，请先恢复")
        key = lock_key(root, book_id)
        _local.held.add(key)
        try:
            yield
        finally:
            _local.held.discard(key)


def book_operation(function=None, *, recoverable=False):
    def decorate(fn):
        parameter = list(inspect.signature(fn).parameters)[1]

        @wraps(fn)
        def wrapped(self, *args, **kwargs):
            store = getattr(self, "store", self)
            value = args[0] if args else kwargs.get(parameter)
            if parameter == "run_id":
                run = store.load_workflow_run(value)
                book_id = run.book_id if run else None
            elif parameter == "batch_id":
                batch = store.get_batch(value)
                book_id = batch.book_id if batch else None
            elif parameter == "path":
                try:
                    parts = Path(value).resolve().relative_to(store.root / "books").parts
                    book_id = parts[0] if len(parts) > 1 else None
                except ValueError:
                    book_id = None
            else:
                book_id = getattr(value, "book_id", value)
            if not book_id:
                return fn(self, *args, **kwargs)
            with book_lock(store.root, str(book_id)):
                if recoverable and store.get_book(book_id):
                    with store.recoverable_book_change(book_id):
                        return fn(self, *args, **kwargs)
                return fn(self, *args, **kwargs)
        return wrapped
    return decorate(function) if function else decorate


def audit_operation(fn):
    """Serialize the shared JSONL file after acquiring any book lock."""
    @wraps(fn)
    def wrapped(self, *args, **kwargs):
        with book_lock(self.root, ":global-audit"):
            return fn(self, *args, **kwargs)
    return wrapped
