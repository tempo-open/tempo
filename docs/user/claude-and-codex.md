# Claude and Codex in Tempo

Tempo runs two agents, Claude and Codex, on this Mac's own sign-ins. Claude uses Claude Code's own
login, and Codex uses its own `~/.codex` login. Tempo keeps no accounts of its own and uses no
personal API keys.

## Signing in

The welcome wizard shows a card for Claude and one for Codex. **Sign in** opens a terminal running
`claude auth login` or `codex login`; **Install** appears when the command is missing. You can also
run either command in a terminal yourself and restart Tempo. Provider status in
**Settings → Providers** shows whether each agent is installed and signed in.

Tempo installs Codex on each environment itself. Claude needs Claude Code on the environment: install
it with `npm install -g @anthropic-ai/claude-code` (or Anthropic's native installer) and Tempo finds
it on its next check. After that, Tempo keeps both up to date; see
[Update providers](./updating.md#update-providers).

## Your own Claude and Codex files

Claude runs as it does in your terminal, from `~/.claude` and `~/.claude.json`: your memory,
`CLAUDE.md`, settings, hooks, skills and MCP servers all load. A thread that Tempo continued from a
Claude Desktop session keeps its history in Tempo and starts a new Claude session the next time you
continue it.

Codex runs the same way from `~/.codex`, and loads `~/.agents/skills` as it is. Claude's workflow and
auto-compact options are in the **Claude** section of **Settings → Providers**.

## Models

You can pick the models Claude Code and Codex normally offer. Claude models keep their usual options,
such as reasoning effort and Ultracode.
