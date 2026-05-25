#!/bin/bash
YELLOW='\033[0;33m'
DIM='\033[2m'
RESET='\033[0m'

echo -e "${YELLOW}Memory${RESET} ${DIM}|${RESET} Session ending — call memory_project_summary to show session_state."
echo "For each ephemeral memory, ask the user: promote to long-term (memory_update ephemeral:false) or clear (memory_clear_ephemerals)?"
echo "If nothing was offered yet this session, also ask: 'Anything else worth storing before we close?'"
