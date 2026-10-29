---
name: cato-efficiency
description: CATO's rules for saving tokens while navigating and reading code, including with Serena, Graphify, ast-grep and GitHub MCP. Use when exploring a repository, reading large files, or when the conversation's context is already large.
---

# Token efficiency with CATO

Every turn's cost is the whole context re-read. Whatever enters the context stays there until /compact or /clear.

## Pick the most precise tool available

| For | Use first | If not available |
|---|---|---|
| Project overview | `graphify-out/GRAPH_REPORT.md` (Graphify) | `mcp__cato__repo_map` |
| Where a concept appears and what it connects to | `mcp__cato__graph_query` (Graphify) | `mcp__cato__repo_map` with `focus` |
| Reading a class/function | Serena's `find_symbol` with `include_body: true` | `mcp__cato__read_symbol` |
| A file's structure | Serena's `get_symbols_overview` | `Read` with `offset`/`limit` on the repo_map's `[L<start>-L<end>]` |
| Who uses a symbol | Serena's `find_referencing_symbols` | `mcp__cato__structural_search` |
| A code pattern (call, decorator, hook) | `mcp__cato__structural_search` (ast-grep) | Grep |
| Free text | Grep | — |

## Rules

1. **Surgical reads:** in files over 300 lines, never read the whole file; use the tools above or `Read` with `offset` and `limit`.
2. **No re-reads:** do not read a file that is already in the context again unless it changed.
3. **Broad searches in a subagent:** delegate to `cato-explorer` when you need to search many unknown files; only the conclusion comes back.
4. **Serena:** CATO applies an answer limit when you don't pass `max_answer_chars`. If Serena says the answer went over the limit, narrow the request (`relative_path`, `depth`, `include_body: false`) instead of raising the limit.
5. **GitHub MCP:** ask only for what you need: `fields` (no `body` when not needed), `perPage`, `detail: "none"` on `get_commit`, `failed_only`/`tail_lines` on `get_job_logs`. CATO strips API-only fields from the JSON.
6. **Graphify:** do not read `graphify-out/graph.json` (CATO denies it); use the report or `graph_query`.
7. **Large output:** compressed output carries `#cmd_xxxxxxxx` and large MCP responses carry `#sbx_xxxxxxxx`. Search them with `mcp__cato__search_sandbox` instead of running again. When the output warns "⚠ N error lines not shown", the errors are in the log: search for the failure term before concluding anything.
8. **Verbose output in a subagent:** a full test suite, long logs and lengthy documentation stay in the subagent's context; only the summary comes back.
9. **CLI before MCP:** when a CLI exists (`gh`, `aws`, `gcloud`), it adds no tool definitions to the context.
10. **Abandoned path:** to drop an attempt, suggest `/rewind` ("Summarize from here"), which returns to a prefix already in the cache; `/compact` is for natural breaks, and `/clear` for switching tasks (with `/rename` first, to find the session later).
11. **Concise answers:** do not reprint code that was already written; cite `file:line`.
12. **Cost:** `/cato` shows the real recorded cost, cache misses, tokens saved and what would save the most; `/cato-doctor` points out settings that spend context; `/cato-import` adds the sessions from before the install. CATO writes these in the user's language.
