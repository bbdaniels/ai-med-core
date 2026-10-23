#!/bin/sh
# deploy-commit.sh: which commit's image should be serving?
#
#   tools/deploy-commit.sh <ref>          the image commit for <ref>
#   tools/deploy-commit.sh --list <ref>   the files of <ref>'s build context
#
# Run it inside the repository (it reads the repository of the current
# directory, as git does). <ref> is anything git resolves to a commit
# (HEAD, origin/main, a SHA).
#
# The API image is built from `git archive <commit>` with the repository's
# Dockerfile and .dockerignore (Dockerfile header). Its build context is
# therefore every file tracked at the commit that .dockerignore does not
# exclude. Two commits whose contexts are identical build the same image, so
# a commit that changed only paths outside the context (documentation,
# workflows, tools the image never runs) needs no new image.
#
# The image commit for <ref> is the newest commit at or before <ref>, along
# the first-parent history, that changed a path in the context, with
# Dockerfile and .dockerignore always counting (they shape the build even if
# excluded from it). Its context is byte for byte the context of <ref>. It
# prints that commit's full SHA. This is the contract with the hosts:
#
#   - the Pi's deployer (the runner job hosting-deploy, every five minutes,
#     running pi/hosting/bin/auto-deploy.sh from raspberry-pi) builds
#     `git archive <image commit>`, unpacked
#     into a directory (Docker applies .dockerignore to a directory context,
#     never to a tar on stdin), with --build-arg GIT_COMMIT_SHA=<image commit>
#     (any prefix of 7 or more characters), and rebuilds only when the image
#     commit of origin/main changes;
#   - deploy-pages.yml (through tools/wait-for-deploy.ts, tools/lib/deploy-ready.ts)
#     waits until /api/health reports the image commit of the pushed commit,
#     or a later commit that contains it.
#
# The deployer keeps its own copy of this rule, pi/hosting/bin/image-commit.sh
# in raspberry-pi (this script with the build context as a parameter). On
# every ai-med check it runs both and deploys nothing when they disagree, so a
# change here must be mirrored there (docs/deployment.md, section 4).
#
# The path filter is .dockerignore itself, read from <ref> (the rules that
# build <ref>'s image), and matched with Docker's rules: comments and blank
# lines skipped, each pattern cleaned and anchored at the context root, `*`
# and `?` within one path segment, `**` across any number, `!` re-includes,
# the last matching pattern wins, and a pattern that matches a directory
# matches everything under it. `--list` prints the same filter applied to
# every file tracked at <ref>; test.yml checks that list against the files of
# a real image, so this script and Docker cannot disagree unnoticed.
#
# Exits 1, saying why, when <ref> is not a commit, when the history is
# shallow at the commit it would print (its parent is missing, so the answer
# cannot be known), when a path needs git's quoting, or when .gitattributes
# declares export-ignore (git archive would then drop files this script
# counts).
#
# Tests: packages/api/src/deploy-commit.test.ts.

set -eu

usage() {
  echo "usage: tools/deploy-commit.sh [--list] <ref>" >&2
  exit 2
}

mode=commit
if [ "${1:-}" = "--list" ]; then
  mode=list
  shift
fi
[ $# -eq 1 ] || usage

die() {
  echo "deploy-commit.sh: $*" >&2
  exit 1
}

sha=$(git rev-parse --verify --quiet "$1^{commit}") || die "$1 is not a commit"

if git cat-file -e "$sha:.gitattributes" 2>/dev/null \
  && git show "$sha:.gitattributes" | grep -q 'export-ignore'; then
  die ".gitattributes at $1 declares export-ignore, which git archive honors and this script does not"
fi

ignore=$(mktemp)
trap 'rm -f "$ignore"' EXIT
if git cat-file -e "$sha:.dockerignore" 2>/dev/null; then
  git show "$sha:.dockerignore" >"$ignore"
fi

# The filter: .dockerignore compiled to regular expressions with Docker's
# rules (moby/patternmatcher), applied to one path per input line.
FILTER='
function clean(p,   n, seg, out, k, i, s, abs) {
  abs = (substr(p, 1, 1) == "/")
  n = split(p, seg, "/")
  k = 0
  for (i = 1; i <= n; i++) {
    s = seg[i]
    if (s == "" || s == ".") continue
    if (s == ".." && k > 0 && out[k] != "..") { k--; continue }
    if (s == ".." && abs) continue
    out[++k] = s
  }
  p = ""
  for (i = 1; i <= k; i++) p = p (i > 1 ? "/" : "") out[i]
  if (p == "") p = abs ? "/" : "."
  return p
}
function compile(p,   re, i, n, c, d) {
  re = "^"; n = length(p); i = 1
  while (i <= n) {
    c = substr(p, i, 1)
    if (c == "*") {
      if (substr(p, i + 1, 1) == "*") {
        i += 2
        if (substr(p, i, 1) == "/") i++
        re = re (i > n ? ".*" : "(.*/)?")
        continue
      }
      re = re "[^/]*"
    } else if (c == "?") {
      re = re "[^/]"
    } else if (c == "\\") {
      i++
      d = substr(p, i, 1)
      re = re (index(".+()|{}$^*?[]\\", d) ? "\\" d : d)
    } else if (index(".+()|{}$", c)) {
      re = re "\\" c
    } else {
      re = re c
    }
    i++
  }
  return re "$"
}
function included(f,   m, k, n, seg, prefix, j, hit) {
  m = 0
  for (k = 1; k <= np; k++) {
    if (excl[k] != m) continue
    hit = (f ~ re[k])
    if (!hit) {
      n = split(f, seg, "/")
      prefix = ""
      for (j = 1; j < n && !hit; j++) {
        prefix = (j == 1 ? seg[1] : prefix "/" seg[j])
        hit = (prefix ~ re[k])
      }
    }
    if (hit) m = excl[k] ? 0 : 1
  }
  return !m
}
function checkpath(f) {
  if (substr(f, 1, 1) == "\"") {
    print "deploy-commit.sh: git quoted the path " f "; this script reads plain paths only" > "/dev/stderr"
    bad = 1
    exit 1
  }
}
BEGIN {
  np = 0
  while ((getline line < ignorefile) > 0) {
    sub(/\r$/, "", line)
    if (substr(line, 1, 1) == "#") continue
    gsub(/^[ \t]+|[ \t]+$/, "", line)
    if (line == "") continue
    neg = 0
    if (substr(line, 1, 1) == "!") {
      neg = 1
      line = substr(line, 2)
      gsub(/^[ \t]+|[ \t]+$/, "", line)
    }
    if (line != "") {
      line = clean(line)
      if (length(line) > 1 && substr(line, 1, 1) == "/") line = substr(line, 2)
    }
    np++
    excl[np] = neg
    re[np] = compile(line)
  }
  close(ignorefile)
}
'

if [ "$mode" = list ]; then
  git -c core.quotePath=false ls-tree -r --name-only "$sha" \
    | awk -v ignorefile="$ignore" "$FILTER"'
      { checkpath($0); if (included($0)) print }
      END { if (bad) exit 1 }'
  exit
fi

# Newest first along the first parent, each commit with the paths it changed
# against its first parent (both sides of a rename; every path of a root
# commit). The first commit with a path in the context is the answer.
found=$(git -c core.quotePath=false log --first-parent --diff-merges=first-parent \
    --no-renames --root --name-only --format='@%H' "$sha" \
  | awk -v ignorefile="$ignore" "$FILTER"'
      substr($0, 1, 1) == "@" && $0 ~ /^@[0-9a-f]+$/ && (length($0) == 41 || length($0) == 65) {
        cur = substr($0, 2); next
      }
      $0 == "" { next }
      {
        checkpath($0)
        if ($0 == "Dockerfile" || $0 == ".dockerignore" || included($0)) { print cur; exit }
      }
      END { if (bad) exit 1 }') || die "could not read the history of $1"

[ -n "$found" ] || die "no commit at or before $1 changed a path in the build context"

if [ "$(git rev-parse --is-shallow-repository)" = true ] \
  && grep -qx "$found" "$(git rev-parse --git-path shallow)"; then
  die "the history is shallow at $found, so whether it changed the build context is unknown; fetch more history (CI: actions/checkout with fetch-depth: 0)"
fi

echo "$found"
