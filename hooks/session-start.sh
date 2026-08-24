#!/bin/bash
# Detect project from git and remind Claude to load memory context
CYAN='\033[0;36m'
DIM='\033[2m'
RESET='\033[0m'

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/cm-findings-path.sh"

PROJECT=$(git remote get-url origin 2>/dev/null | sed 's/\.git$//' | sed 's|^git@[^:]*:|https://|')
if [ -z "$PROJECT" ]; then
  PROJECT=$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null)
fi

if [ -n "$PROJECT" ]; then
  echo -e "${CYAN}Memory${RESET} ${DIM}|${RESET} project: ${PROJECT}"
  echo "Use memory_project_summary to load context for this project."
  echo "Check session_state in the summary: if ephemerals exist with old timestamps (previous session), ask the user 'I have notes from a previous session — promote any or clear all?'"
  echo "If no ephemeral task spec exists, ask the user: 'What are we working on?' and store the answer with ephemeral: true."

  # cm-findings: check the canonical (org/repo, outside-repo) location, prompt to create on first use
  CM_FINDINGS_DIR=$(cm_findings_dir)
  if [ ! -d "$CM_FINDINGS_DIR" ]; then
    echo "No cm-findings/ directory found for this project. Ask the user: 'OK to create one at $CM_FINDINGS_DIR for local investigation notes?'. If they agree, run: mkdir -p \"$CM_FINDINGS_DIR\"."
  else
    COUNT=$(find "$CM_FINDINGS_DIR" -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
    if [ "$COUNT" -gt 0 ]; then
      echo "cm-findings has $COUNT finding(s) for this project ($CM_FINDINGS_DIR). Run memory_query to check if any are relevant to what you're working on."
    fi
  fi

  # One-time nudge: an old-style in-repo cm-findings/ predates the outside-repo convention
  REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
  if [ -n "$REPO_ROOT" ] && [ -d "$REPO_ROOT/cm-findings" ]; then
    echo "Found an old-style $REPO_ROOT/cm-findings/ inside the repo — cm-findings now lives outside the repo, at $CM_FINDINGS_DIR. Ask the user whether to migrate its contents there."
  fi
else
  echo -e "${CYAN}Memory${RESET} ${DIM}|${RESET} no git project detected"
  echo "Use memory_query if you need stored context."
fi
