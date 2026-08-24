#!/bin/bash
YELLOW='\033[0;33m'
DIM='\033[2m'
RESET='\033[0m'

echo -e "${YELLOW}Memory${RESET} ${DIM}|${RESET} Session ending — call memory_project_summary to show session_state."
echo "For each ephemeral memory, ask the user: promote to long-term (memory_update ephemeral:false) or clear (memory_clear_ephemerals)?"
echo "If nothing was offered yet this session, also ask: 'Anything else worth storing before we close?'"

# cm-findings retro: extract topics from git history, prompt semantic check
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/cm-findings-path.sh"
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
CM_FINDINGS_DIR=$(cm_findings_dir)
if [ -n "$REPO_ROOT" ] && [ -d "$CM_FINDINGS_DIR" ]; then
  echo ""
  echo "cm-findings retro:"
  RECENT_LOG=$(git -C "$REPO_ROOT" log --oneline -20 2>/dev/null)
  if [ -n "$RECENT_LOG" ]; then
    echo "Recent commits:"
    echo "$RECENT_LOG"
    echo "Run memory_query using keywords from these commits. Surface any cm-findings or memories that relate to what was touched — check they still reflect reality. If a finding is outdated, update $CM_FINDINGS_DIR/<topic>.md and the linked memory."
  fi
fi
