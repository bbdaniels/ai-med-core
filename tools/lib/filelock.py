"""One exclusive advisory lock, for every tool in this directory that writes a
file two runs could write at the same time.

There are two such files, and both had the same defect for the same reason: the
writer read, modified and wrote with nothing in between, so a second run
overlapping the first produced a file with one run's work silently missing.

  - `legal-corpus.db`, where two builds unlink each other's temp file and leave
    an index whose embeddings table is a fraction of its chunks (observed twice
    on 2026-09-02).
  - `registry.json`, where two `fetch-legal-docs.py` runs each read the whole
    registry and each write the whole registry, so the second one's write drops
    whatever the first added -- which is how the `vbhn-15-2024-byt` entry was
    lost once on 2026-09-03.

The lock is a file whose content is the holder's pid, created with `O_EXCL` so
creation is the atomic test-and-set. A lock whose holder is no longer running is
stale and is cleared, because the alternative is a crashed run wedging the tool
until someone deletes a file by hand.

**Every entry point here takes the RESOURCE being protected, and derives the
lock file itself** (`<resource>.lock`, beside it). It used to take the lock
file's own path, which put one character between correct use and total data
loss: `acquire` opens its argument `O_CREAT|O_WRONLY`, so a caller passing the
file it meant to protect TRUNCATES it to nothing, and `release` then UNLINKS it.
That is not theoretical -- `registry.json` was emptied that way on 2026-09-04 by
a caller that read `exclusive_lock(path)` as "lock this file", which is the only
reading the name supports. Deriving the path removes the mistake instead of
documenting it; a path that already ends in `.lock` is refused outright, since
the only way to produce one is the old call shape.

Advisory, and deliberately so: it protects these tools from each other, not the
file from anything else on the machine. What it must never do is stand in for
the re-read -- a caller that holds this lock still re-reads the file it is about
to overwrite, because the lock cannot cover the run that started before it.
"""

from __future__ import annotations

import atexit
import os
import time
from contextlib import contextmanager
from pathlib import Path


class LockBusy(RuntimeError):
    """Another live process holds the lock. Carries the holder's pid as text."""

    def __init__(self, holder: str) -> None:
        self.holder = holder
        super().__init__(f"pid {holder or '?'}")


def lock_path(resource: Path) -> Path:
    """The lock file for `resource`: `<resource>.lock`, beside it.

    Refuses a path that is already a lock file. A caller reaching this with a
    `.lock` path is passing what it used to pass -- the lock's own name -- and
    would otherwise take a `.lock.lock`, protecting nothing while looking like
    it worked."""
    resource = Path(resource)
    if resource.name.endswith(".lock"):
        raise ValueError(
            f"filelock takes the RESOURCE to protect, not a lock file: got "
            f"{resource}. Pass the file itself (the '.lock' suffix is added "
            f"here); passing a lock path silently locks the wrong thing.")
    return resource.with_name(resource.name + ".lock")


def _holder(path: Path) -> tuple[str, bool]:
    """(pid as written, whether that process is still running)."""
    holder = ""
    try:
        holder = path.read_text(encoding="utf-8").strip()
    except OSError:
        pass
    if not holder.isdigit():
        # No readable pid: an empty file from a run killed between create and
        # write. Nothing can be waited for, so treat it as stale.
        return holder, False
    try:
        os.kill(int(holder), 0)
        return holder, True
    except (OSError, ProcessLookupError):
        return holder, False


def acquire(resource: Path, timeout: float = 0.0, poll: float = 0.2) -> None:
    """Take the lock protecting `resource`, releasing it when this process exits.

    `resource` is the file being protected, NOT a lock file: the lock taken is
    `<resource>.lock` (see `lock_path`), and `resource` itself is never opened,
    written or unlinked by this module.

    Raises `LockBusy` if a live holder is still there after `timeout` seconds.
    `timeout=0` is the fail-fast case a long job wants (a second corpus build
    should say so rather than queue behind a twenty-minute run); a short timeout
    is what a small critical section wants, since waiting a moment beats failing
    a whole fetch over a write that takes milliseconds."""
    path = lock_path(resource)
    deadline = time.monotonic() + timeout
    while True:
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            break
        except FileExistsError:
            holder, alive = _holder(path)
            if alive:
                if time.monotonic() >= deadline:
                    raise LockBusy(holder) from None
                time.sleep(poll)
                continue
            # The holder is gone. Unlink and go round again rather than
            # assuming the unlink wins the race -- another waiter may create
            # the file first, and then it is a live holder like any other.
            try:
                path.unlink()
            except FileNotFoundError:
                pass
    os.write(fd, str(os.getpid()).encode())
    os.close(fd)
    atexit.register(release, resource)


def release(resource: Path) -> None:
    """Drop the lock protecting `resource`, but ONLY while this process holds it.

    The pid check is the whole point. A short critical section releases at the
    end of its `with`, and the same process may then run on for minutes; an
    unconditional unlink at exit would delete whatever lock file is there by
    then, which is somebody else's."""
    path = lock_path(resource)
    try:
        if path.read_text(encoding="utf-8").strip() != str(os.getpid()):
            return
    except OSError:
        return
    try:
        path.unlink()
    except FileNotFoundError:
        pass


@contextmanager
def exclusive_lock(resource: Path, timeout: float = 20.0, poll: float = 0.2):
    """`acquire` for a critical section short enough to hold in a `with`.

    Takes the RESOURCE to protect. `<resource>.lock` is what gets created and
    deleted; the resource is never touched."""
    acquire(resource, timeout=timeout, poll=poll)
    try:
        yield
    finally:
        release(resource)
