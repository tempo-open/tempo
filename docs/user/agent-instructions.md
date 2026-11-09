# Agent instructions (CLAUDE.md / AGENTS.md)

Claude and Codex read instruction files when a session starts: your personal files,
each project's files, and Claude's auto memory. **Settings > Instructions** lists every
one that the selected environment's agents load, says which agent loads it and when, and
opens it in an editor. You can also run **Edit instructions** from the command palette.

Files live on the environment's machine. Select a remote machine in the settings scope
picker to see and edit its files, not your laptop's. Select a project to list only that
project's files next to the global ones. From a thread, **Edit instructions** opens the
files that thread's agent loads.

## What loads

| File                                                        | Claude                                                                           | Codex                                                                         |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `~/.claude/CLAUDE.md`, `~/.claude/rules/*.md`               | Every session                                                                    | No                                                                            |
| `~/.codex/AGENTS.md` (or `AGENTS.override.md`)              | No                                                                               | Every session                                                                 |
| Project `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md` | At start; in subfolders, when Claude works there                                 | No                                                                            |
| Project `.claude/rules/*.md`                                | At start, or on matching files with `paths:`                                     | No                                                                            |
| Project `AGENTS.md`                                         | Only when no `CLAUDE.md` exists (Claude Code 2.1.277 or later), or when imported | From the git root down to the project folder; nested ones when it edits there |
| `MEMORY.md` in Claude's auto memory folder                  | First 200 lines at start                                                         | No                                                                            |

Each row in the page spells this out for the actual file, including files in parent
folders, `@path` imports, and size limits Codex applies (`project_doc_max_bytes`).
Select an `@import` under the editor to open the imported file; **Back** returns to the
file that imports it.

A project file that imports something outside the project (such as
`@~/.claude/my-notes.md`) only loads after you approve imports from outside that
project once in Claude Code. Tempo cannot show that prompt, so the row warns you; run
`claude` in the project once to approve them. Imports in your own `~/.claude` files need
no approval.

## Editing

Edits apply to **new** sessions; running sessions keep what they loaded. A thread in a
worktree reads that checkout's copy of committed files.

Rows marked "Not created yet" show where a file would load; select **Create** to start
it. If a file changed on disk after you opened it, saving stops until you reload, so you
never overwrite a change you have not seen. Leaving a file with unsaved edits asks first.
Deleting asks for confirmation; deleting a symlink removes only the link.

Only instruction files appear here. Imports open when they are Markdown or text files
inside a project or an agent's config folder. A file that links elsewhere opens when it
is a text file inside those folders; your own `~/.claude` and `~/.codex` files may also
link to a dotfiles folder. Links to anything else are listed but do not open. Files
larger than 256 KB do not open.

Reading the page needs file read access on the environment; saving needs permission to
change its settings.

## Sync your agent files to another machine

**Sync to** _host_ on this page copies your personal agent files from this device to another
environment. On this device's own page it syncs to the machine that runs new work (**Run new
work on** in **Settings > Environments**); select any other connected environment in the scope
picker to sync there instead. It copies:

- `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md` and `~/.codex/AGENTS.override.md`
- the `skills`, `commands`, `agents`, `workflows`, `rules` and `output-styles` folders in
  `~/.claude`
- `~/.codex/skills` and `~/.agents/skills`

Agents on that machine load them the way they do here (see above). Each machine's
`CLAUDE_CONFIG_DIR` and `CODEX_HOME` are respected. A file there is replaced only when it
differs, and none is deleted. A symlink to another file or folder on this list, such as a skill
in `~/.claude/skills` that links into `~/.agents/skills`, is made again there unless something
else is in its place; other symlinks are not copied. Settings, credentials, Codex's `agents` role
files (they hold config), `node_modules`, `.git`, and files over 1 MB are not copied, and the
result lists anything it skipped. Skills Claude and Codex download or install themselves
(`skills/synced`, `skills/.system`) stay behind too.
