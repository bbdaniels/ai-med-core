"""Reading a document's hand-curated figure transcriptions.

A figure in a legal instrument is a picture: a flow chart, or -- in 1868/QĐ-BYT
-- a whole interpretation table laid out as an image. Nothing can extract what
it says, so it is transcribed by a person into
`content/legal/transcriptions/<id>.md`, named from that document's registry
entry as `figureTranscriptions`, one `## fig-NN — <caption>` section per figure.

TWO CONSUMERS, ONE PARSER. The transcription is *retrieval* material, not
reading material: HAIVN's reviewers read the figure itself and told us on
2026-09-04 that a transcription printed underneath it duplicated what they were
already looking at. So `fetch-legal-docs.py` no longer splices it into the
displayed text -- the reader gets image plus caption -- and
`build-legal-corpus.py` reads this sidecar directly and indexes it against the
section the figure sits in. Both tools parse it here, once, so the sidecar's
shape cannot drift between the tool that validates it and the tool that indexes
it.

The heading is keyed on the figure's STEM (`fig-03`), which is stable against
the publisher re-cropping an image, and carries the caption it was written
against as a drift detector: if the source page inserts an image, every later
ordinal shifts, and a caption that no longer matches is reported by the fetch
run rather than shipped.
"""

from __future__ import annotations

import re
from pathlib import Path

HEADING_RE = re.compile(r"^##\s+(fig-\d+)\s*(?:[—–-]+\s*(.*?))?\s*$")


def parse(text: str) -> dict[str, tuple[str, str]]:
    """`{stem: (caption it was written against, Markdown)}`.

    Anything above the first `## fig-NN` heading is the curator's own note to
    the next curator and is not emitted. Sections with no body are returned so
    a caller can report them, and dropped by `read`."""
    out: dict[str, tuple[str, str]] = {}
    stem = caption = None
    buf: list[str] = []
    for line in text.split("\n"):
        head = HEADING_RE.match(line)
        if head:
            if stem:
                out[stem] = (caption or "", "\n".join(buf).strip())
            stem, caption, buf = head.group(1), (head.group(2) or "").strip(), []
        elif stem:
            buf.append(line)
    if stem:
        out[stem] = (caption or "", "\n".join(buf).strip())
    return out


def read(doc: dict, repo_root: Path) -> tuple[dict[str, tuple[str, str]], str]:
    """One document's transcriptions, plus a note about anything unusable.

    `({}, "")` for a document that declares none -- which is most of them, and
    is not a problem to report."""
    rel = doc.get("figureTranscriptions")
    if not rel:
        return {}, ""
    path = repo_root / rel
    if not path.is_file():
        return {}, f"{rel} is named in the registry and is not on disk"
    out = parse(path.read_text(encoding="utf-8"))
    empty = [s for s, (_, body) in out.items() if not body]
    return ({s: v for s, v in out.items() if v[1]},
            f"{rel}: {', '.join(empty)} carry no transcription" if empty else "")
