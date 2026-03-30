#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="$(which node)"
SERVER_PATH="$SCRIPT_DIR/dist/server.js"
CLAUDE_MD="$HOME/.claude/CLAUDE.md"
MARKER="<!-- claude-memory-mcp -->"

echo "==> Building TypeScript..."
npm run build

echo "==> Registering MCP server globally..."
# Remove existing registration if present (ignore errors)
claude mcp remove memory -s user 2>/dev/null || true
claude mcp add memory -s user "$NODE_BIN" "$SERVER_PATH"

echo "==> Configuring global CLAUDE.md..."
mkdir -p "$HOME/.claude"

# Only append if not already present
if [ -f "$CLAUDE_MD" ] && grep -q "$MARKER" "$CLAUDE_MD"; then
  echo "    Memory instructions already in $CLAUDE_MD — skipping."
else
  cat >> "$CLAUDE_MD" << 'BLOCK'

<!-- claude-memory-mcp -->
## Codebase Memory (MCP)

You have access to persistent memory tools via the `memory` MCP server.

**MANDATORY FIRST ACTION — DO THIS BEFORE ANYTHING ELSE:**
When a session starts (you will see a SessionStart hook message), you MUST:
1. Tell the user: "Loading project memory..." (so they can see it happening)
2. Call `memory_project_summary` with the detected project
3. Only THEN respond to whatever the user asked

Do NOT skip this. Do NOT respond to the user first. This provides critical project context that prevents wasted investigation time. If the hook detected a project, use that. Otherwise auto-detect from file_path.

Use memory proactively throughout the session:
- **When you learn something non-obvious**: store architectural decisions, conventions, gotchas, and preferences
- **When the user corrects your approach**: store the correction so you don't repeat the mistake
- **When you discover how systems connect**: store cross-repo relationships and integration points
- **Before exploring unfamiliar code**: check if you already know something relevant
- **Before context compaction**: store key learnings from the session — decisions made, gotchas found, conventions discovered — before they're compressed away

The tools are: `memory_store`, `memory_query`, `memory_list`, `memory_forget`, `repo_link`, `repo_unlink`, `repo_map`.
Project is auto-detected from git root when you provide a file path.
Use `repo_link` when you discover how repos relate (provides, consumes, depends_on, builds_from, extends). Use `repo_map` to check known relationships before making cross-repo assumptions.

Store silently but announce with a brief one-liner, e.g. "Storing: LESS overrides needed for escaped string interpolation". No need to ask permission — just be transparent about what goes in.

When storing memories, always include a \`tags\` array of keywords that someone might use to search for this memory later. Think about synonyms, related concepts, and alternate phrasings — not just the literal terms in the text. For example, a memory about \`editor.jsx\` improvements might have \`tags: ["mobile", "editor", "patch", "bridge", "refactor", "code review", "editor.jsx"]\`. Good tags bridge the gap between how the memory is written and how someone might search for it later.

When the user explicitly asks you to remember something permanently, use \`pinned: true\` on \`memory_store\`. Pinned memories are never evicted. Only pin when the user explicitly asks — normal codebase facts stay unpinned.
<!-- /claude-memory-mcp -->
BLOCK
  echo "    Added memory instructions to $CLAUDE_MD"
fi

echo "==> Installing Claude Code hooks..."
mkdir -p "$HOME/.claude/hooks"
cp "$SCRIPT_DIR/hooks/"*.sh "$HOME/.claude/hooks/"
chmod +x "$HOME/.claude/hooks/"*.sh
echo "    Hooks copied to $HOME/.claude/hooks/"

# --- Prompt user before modifying settings.json ---
echo ""
echo "To work autonomously, claude-memory needs to add the following to ~/.claude/settings.json:"
echo "  - Tool permissions: allow all memory MCP tools without prompting"
echo "  - Hooks: SessionStart, PreCompact, SessionEnd"
echo ""
read -r -p "Configure permissions and hooks in settings.json? [Y/n] " REPLY
REPLY="${REPLY:-Y}"

if [[ "$REPLY" =~ ^[Yy]$ ]]; then
  SETTINGS_FILE="$HOME/.claude/settings.json"

  # Create settings.json if it doesn't exist
  if [ ! -f "$SETTINGS_FILE" ]; then
    echo '{}' > "$SETTINGS_FILE"
  fi

  # Use node to merge permissions and hooks into existing settings
  "$NODE_BIN" -e "
const fs = require('fs');
const settingsPath = process.argv[1];
const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

// --- Permissions ---
const memoryTools = [
  'mcp__memory__memory_store',
  'mcp__memory__memory_query',
  'mcp__memory__memory_list',
  'mcp__memory__memory_forget',
  'mcp__memory__memory_project_summary',
  'mcp__memory__repo_link',
  'mcp__memory__repo_unlink',
  'mcp__memory__repo_map'
];

if (!settings.permissions) settings.permissions = {};
if (!Array.isArray(settings.permissions.allow)) settings.permissions.allow = [];

const existing = new Set(settings.permissions.allow);
let addedPerms = 0;
for (const tool of memoryTools) {
  if (!existing.has(tool)) {
    settings.permissions.allow.push(tool);
    addedPerms++;
  }
}

// --- Hooks ---
const hookEntries = {
  SessionStart: 'session-start.sh',
  PreCompact: 'pre-compact.sh',
  SessionEnd: 'session-end.sh'
};

if (!settings.hooks) settings.hooks = {};

for (const [event, script] of Object.entries(hookEntries)) {
  const cmd = 'bash ~/.claude/hooks/' + script;
  if (!settings.hooks[event]) settings.hooks[event] = [];

  // Check if this hook command is already registered
  const alreadyExists = settings.hooks[event].some(group =>
    group.hooks && group.hooks.some(h => h.command === cmd)
  );

  if (!alreadyExists) {
    settings.hooks[event].push({
      hooks: [{ type: 'command', command: cmd, timeout: 5 }]
    });
  }
}

fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
console.log('    Added ' + addedPerms + ' tool permissions');
console.log('    Hooks configured for: ' + Object.keys(hookEntries).join(', '));
" "$SETTINGS_FILE"
else
  echo "    Skipped. See README for manual configuration."
fi

echo ""
echo "Done. Restart Claude Code to pick up the changes."
