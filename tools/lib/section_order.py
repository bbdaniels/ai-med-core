"""One implementation of the order rule both legal builders need.

A document's sections are read in one order, and whatever locates them --
`build-jump-maps.py` locating a heading on a PDF PAGE, `build-legal-corpus.py`
locating a map section at a TEXT LINE -- must produce locations that run in that
same order. A location that contradicts the reading order is evidence of a
mismatch, not of an out-of-order document: an n-gram that matched the wrong
page, a recurrence of `Điều 17.` inside an appendix form.

Both builders had that problem and only one of them solved it. The corpus
builder ran a longest-increasing-subsequence over each section's candidate lines
and silently discarded whatever contradicted the rest -- which meant the MAP
could ship a page claim the very next tool in the pipeline threw away, with
nothing anywhere saying so. `luat-15-2023-qh15` shipped `chuong-10` on page 1
(the scope sentence of Điều 1 enumerates every chapter's subject, so a sliding
n-gram of Chương X's title words matched it), the corpus builder's LIS dropped
that section, and eleven articles -- Điều 104 to 114 -- were re-parented under
Chương IX and cited that way. Two implementations of one job, and the
disagreement between them was the bug.

So the rule lives here, once, and the map builder runs it too. A map is now
ordered by construction, and the corpus builder's assignment is the same
function applied to a harder input: several candidate lines per section rather
than one page.

The function is the general form -- each item offers a list of candidate
positions, and the answer is the largest set of items that can all be placed at
once without going backwards:

    monotone_assignment({0: [4], 1: [9], 2: [2]}, 3, strict=False)
    -> {0: 4, 1: 9}                # item 2 contradicts the other two

    monotone_subset([4, 9, 2])     # the same call for one candidate each
    -> {0: 4, 1: 9}

`strict` is the difference between the two callers and is not cosmetic. Two
sections cannot BEGIN at the same text line, so the corpus builder asks for
strictly increasing lines; two sections routinely start on the same PDF page, so
the map builder asks for non-decreasing pages. Passing the wrong one silently
throws away every section that shares a page with its neighbour.

What a caller does with the items left out is the caller's own business, and the
two answer it differently: the corpus builder fills them in by number inside the
window between the anchors that survived, and the map builder demotes them to
their structural page where that page fits the window and drops them where it
does not.
"""

from __future__ import annotations

from collections.abc import Sequence

__all__ = ["monotone_assignment", "monotone_subset"]


def monotone_assignment(options: dict[int, Sequence[int]], count: int,
                        strict: bool = True) -> dict[int, int]:
    """The largest set of items placeable in order. Returns {item -> position}.

    `options[i]` is item `i`'s candidate positions, ASCENDING -- the caller
    builds them in document order and this function does not re-sort them, so a
    caller that hands over an unsorted list gets a short answer rather than an
    error. An item with no entry, or an empty one, simply cannot be placed.

    Naive forward-only matching is the implementation this replaced, and it was
    wrong in a way that hid: one bad match dragged the cursor 9,000 lines
    forward and silently cost every one of the 131 articles after it. The
    assignment is chosen globally instead, so a single misleading candidate now
    loses at most itself.

    `dp[k]` is the smallest position any chain of `k` placed items can end on;
    `back` records how each chain was reached so the winner can be walked back.
    """
    dp: list[float] = [float("-inf")]        # dp[0]: nothing placed yet
    chain: list[int] = [-1]                  # index into `back` for dp[k]
    back: list[tuple[int, int, int]] = []    # (position, item, parent chain id)
    for i in range(count):
        candidates = options.get(i) or ()
        for k in range(len(dp) - 1, -1, -1):
            nxt = next((p for p in candidates
                        if (p > dp[k] if strict else p >= dp[k])), None)
            if nxt is None:
                continue
            if k + 1 == len(dp):
                dp.append(nxt)
                back.append((nxt, i, chain[k]))
                chain.append(len(back) - 1)
            elif nxt < dp[k + 1]:
                dp[k + 1] = nxt
                back.append((nxt, i, chain[k]))
                chain[k + 1] = len(back) - 1
    assigned: dict[int, int] = {}
    node = chain[len(dp) - 1]
    while node >= 0:
        position, item, parent = back[node]
        assigned[item] = position
        node = parent
    return assigned


def monotone_subset(positions: Sequence[int], strict: bool = False) -> dict[int, int]:
    """`monotone_assignment` for the case of one candidate per item.

    Returns {item -> position} for the items kept; an item missing from the
    result is one whose position contradicts the rest.
    """
    return monotone_assignment({i: (p,) for i, p in enumerate(positions)},
                               len(positions), strict=strict)
