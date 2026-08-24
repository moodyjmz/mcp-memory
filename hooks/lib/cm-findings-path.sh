#!/bin/bash
# Shared helper: the canonical cm-findings directory for the current repo.
#
# ~/cm-findings/<org>/<repo>, derived from `git remote get-url origin` —
# works for both SSH (git@host:org/repo.git) and HTTPS (https://host/org/repo.git)
# remotes. Falls back to ~/cm-findings/_local/<dirname> when there's no remote
# (a fresh local-only repo). Known limitation: assumes the last two path segments
# are org/repo — a host that nests repos deeper (e.g. some GitLab subgroups)
# isn't handled.
cm_findings_dir() {
  local remote org_repo repo_root dirname_

  remote=$(git remote get-url origin 2>/dev/null)
  if [ -n "$remote" ]; then
    org_repo=$(printf '%s' "$remote" \
      | sed -E 's#^[^@]*@##; s#^[a-z]+://##; s#:#/#; s#\.git$##' \
      | awk -F/ '{print $(NF-1)"/"$NF}')
    printf '%s/cm-findings/%s' "$HOME" "$org_repo"
  else
    repo_root=$(git rev-parse --show-toplevel 2>/dev/null)
    dirname_=$(basename "${repo_root:-$PWD}")
    printf '%s/cm-findings/_local/%s' "$HOME" "$dirname_"
  fi
}
