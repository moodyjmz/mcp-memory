#!/bin/bash
# Detect project from git and remind Claude to load memory context
CYAN='\033[0;36m'
DIM='\033[2m'
RESET='\033[0m'

PROJECT=$(git remote get-url origin 2>/dev/null | sed 's/\.git$//' | sed 's|^git@[^:]*:|https://|')
if [ -z "$PROJECT" ]; then
  PROJECT=$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null)
fi

if [ -n "$PROJECT" ]; then
  echo -e "${CYAN}Memory${RESET} ${DIM}|${RESET} project: ${PROJECT}"
  echo "Use memory_project_summary to load context for this project."
else
  echo -e "${CYAN}Memory${RESET} ${DIM}|${RESET} no git project detected"
  echo "Use memory_query if you need stored context."
fi
