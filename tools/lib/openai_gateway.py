"""One HTTP layer for the OpenAI-compatible endpoint the corpus builders use.

`tools/build-ppol-corpus.py` and `tools/build-legal-corpus.py` both embed their
chunks through the same gateway and both used to carry their own copy of this
code. The copies drifted in exactly the way two implementations of one job
always do: when the Harvard HUIT gateway started 403ing on the default urllib
User-Agent, the fix had to land twice or one builder would silently ship an
index with no vector column. It lands here instead.

Nothing in this file is project-specific and nothing in it is secret; the
credential is read from the environment or the untracked repo-root .env.
"""

from __future__ import annotations

import json
import os
import struct
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent

# The Harvard HUIT gateway sits behind a WAF that returns a bare HTML 403 to the
# default "Python-urllib/3.x" User-Agent. It is not a quota error, it carries no
# JSON body, and 403 is not a retryable status -- so a build that omits this
# header loses every embedding and every gloss call while still writing a
# usable-looking FTS5 index. Measured 2026-08-29: identical request, 403 with
# the default header and 200 with this one. Do not remove it.
USER_AGENT = "ai-med-corpus-builder/1.0"

RETRY_STATUSES = (429, 500, 502, 503, 504)


def load_env() -> dict[str, str]:
    """Environment first, repo-root .env second. No secret lives in this repo."""
    env = dict(os.environ)
    dotenv = REPO_ROOT / ".env"
    if dotenv.exists():
        for line in dotenv.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            env.setdefault(key.strip(), value.strip().strip('"').strip("'"))
    return env


def api_post(env: dict[str, str], path: str, payload: dict,
             retries: int = 4) -> dict:
    base = env.get("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    key = env.get("OPENAI_API_KEY", "")
    if not key:
        raise RuntimeError("OPENAI_API_KEY is not set (environment or repo-root .env)")
    req = urllib.request.Request(
        f"{base}{path}",
        data=json.dumps(payload).encode(),
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
        },
        method="POST",
    )
    last: Exception | None = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                body = resp.read()
                # The gateway gzips its responses whatever the request's
                # Accept-Encoding says, so decode by what actually came back.
                # urllib, unlike requests, does no content decoding at all.
                encoding = (resp.headers.get("Content-Encoding") or "").lower()
                if encoding == "gzip":
                    import gzip
                    body = gzip.decompress(body)
                elif encoding == "deflate":
                    import zlib
                    body = zlib.decompress(body)
                return json.loads(body.decode())
        except urllib.error.HTTPError as e:
            last = e
            if e.code in RETRY_STATUSES:
                time.sleep(2 ** attempt)
                continue
            raise RuntimeError(f"{path} failed {e.code}: {e.read()[:400]!r}") from e
        except Exception as e:                       # noqa: BLE001 - transport
            last = e
            time.sleep(2 ** attempt)
    raise RuntimeError(f"{path} failed after {retries} attempts: {last}")


def embed_batch(env: dict[str, str], texts: list[str], model: str) -> list[list[float]]:
    data = api_post(env, "/embeddings", {"model": model, "input": texts})
    return [row["embedding"] for row in data["data"]]


def pack(vec: list[float]) -> bytes:
    return struct.pack(f"<{len(vec)}f", *vec)


def unpack(blob: bytes) -> list[float]:
    return list(struct.unpack(f"<{len(blob) // 4}f", blob))
