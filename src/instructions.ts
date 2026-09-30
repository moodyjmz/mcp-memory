/**
 * Server instructions, returned to the client in the MCP initialize result.
 *
 * Claude Code keeps these in context even when the server's tools are deferred behind tool
 * search (https://code.claude.com/docs/en/mcp#scale-with-mcp-tool-search), which makes them
 * the home for the *when* of memory use: triggers the model has to see before it has any
 * reason to load a tool. Parameter detail stays in the tool descriptions. Whether subagents
 * receive them isn't documented, and two informal probes disagreed.
 *
 * Kept short on purpose: every character here is paid for on every main-session turn, and
 * Claude Code truncates instructions past 2,048 characters by default (same docs page).
 */
export const SERVER_INSTRUCTIONS = `Persistent project memory. The memory tools may be deferred: load them through tool search before the first call.

Session start: call memory_project_summary. If session_state lists ephemerals from an earlier session, ask the user whether to promote or clear them. If no ephemeral task spec exists, ask "What are we working on?" and store the answer with ephemeral: true. In an unfamiliar project, call memory_graph for an overview. In a workspace that isn't a git repo, do this once the work settles on a repo.

Before exploring unfamiliar code, check memory_query; before cross-repo assumptions, check repo_map.

Store non-obvious architecture, conventions and gotchas, user corrections, cross-repo relationships (repo_link), and key learnings before context is compacted. Tags should add search terms the text lacks (synonyms, related terms). Set load_with on both of two memories that only make sense together. Store session working state (task spec, infra topology, validated commands) with ephemeral: true. For setups too detailed for one memory, use memory_store_file.

If something you observe contradicts or refines a stored memory, say so in one line and offer memory_update or memory_forget.

After a meaningful unit of work with unstored learnings, ask once: "Worth a quick retro before we move on?"

When the session-start hook prints a cm-findings path, write investigation notes there and store a pointer memory with file_path set.

Before the session ends, show session_state and ask whether to promote or clear each ephemeral.`;

/** Upper bound for SERVER_INSTRUCTIONS; the test fails if the text grows past it. */
export const SERVER_INSTRUCTIONS_MAX_CHARS = 1600;
