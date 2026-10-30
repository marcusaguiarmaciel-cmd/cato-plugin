# CATO Privacy Policy

_Last updated: 2026-10-30_

CATO is a Claude Code plugin that runs entirely on your machine. It has no server, no account and no telemetry.

## What CATO reads

- **Claude Code session transcripts** (`~/.claude/projects`), for `/cato` and `/cato-import`. Only token usage, model, timestamps and tool names are used.
- **Claude Code settings** (`settings.json`, `settings.local.json`, `.mcp.json`, `~/.claude.json`), for `/cato-doctor`. `~/.claude.json` may contain your account email; CATO only uses the names of configured MCP servers and projects and ignores everything else.
- **Tool output** in the current session (shell commands, MCP responses), to compress or sandbox it.

## What CATO stores

All on your machine:

- Counts of tokens, costs and interventions, in CATO's store inside Claude Code.
- Raw logs of compressed shell output in `~/.cato/logs` and large MCP responses in `~/.cato/sandbox`. These may contain whatever the command or tool returned. They are deleted automatically after 14 days, and you can delete the folder at any time.

## What CATO sends

Nothing. CATO makes no network requests of its own and shares no data with the author or any third party. The optional, off-by-default `warmCache` feature makes one small call to the session's own Claude model through Claude Code, like any other turn.

## Contact

Questions: open an issue at https://github.com/marcusaguiarmaciel-cmd/cato-plugin/issues
