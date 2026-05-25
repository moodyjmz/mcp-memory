#!/bin/bash
RED='\033[0;31m'
DIM='\033[2m'
RESET='\033[0m'

echo -e "${RED}Memory${RESET} ${DIM}|${RESET} Context compacting — store these NOW as ephemeral memories before they are lost:"
echo "  1. What is currently working and the git commit hash (if relevant)"
echo "  2. Any docker/infra topology — which image, which repo for each service, volume mounts"
echo "  3. The current task spec — what you are trying to accomplish right now"
echo "Use memory_store with ephemeral: true for session state that may not belong long-term."
