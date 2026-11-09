# Claude

In Tempo, Claude runs on Claude Code's own sign-in on this Mac. See
[Claude and Codex in Tempo](./claude-and-codex.md). Claude Code must be installed on the environment
(`claude` on its `PATH`).

Claude runs from `~/.claude` and `~/.claude.json`, as it does in your terminal, so your
memory, `CLAUDE.md`, settings, hooks, skills and MCP servers load as usual.

Claude Code's verbose mode can stay enabled when you use Claude for text generation, including
thread titles, branch names, commit messages, and pull request descriptions. On a remote connection,
Tempo uses the Claude configuration on the connected server.

Claude Code also runs housekeeping tasks of its own in the background. Tempo keeps them out of the
thread, the agents list, and the background-work banner, and a thread is not shown as waiting on
them. Monitors Claude starts still appear under background work.

## Compact long conversations

Set **Auto-compact after** in **Settings > Providers > Claude** to an integer between
`100000` and `1000000`. For example, `300000` asks Claude to summarize at about
300,000 tokens. This changes when compaction happens, not the model's context
window. Leave it empty for Claude Code's default. Tempo compacts a thread as soon as a turn
leaves it close to that point, so your next message does not wait for it; see
[commands and skills](./composer.md#commands-and-skills).

You can also send `/compact` in an existing conversation. Web and desktop offer
**Compact context** from the context meter. When you return to a large thread
after Claude's prompt cache expires, a **Compact** chip with the thread's token count shows
next to the send button. While it is on, Enter summarizes the history first, then
sends your message. Click the chip to switch it to **Full** and keep the full
history for that message. The cache lasts about an hour on a Claude
subscription and 5 minutes with an API key, Bedrock, or Vertex. See [commands and skills](./composer.md#commands-and-skills) for using
composer commands.

**Compact idle threads** in **Settings > Providers** controls this for idle threads
with at least 20,000 tokens of context:

- **Before the cache expires** compacts an idle thread shortly before its
  prompt cache expires, so coming back does not reprocess the whole conversation.
  The compaction appears in the thread as a `/compact` turn sent by Tempo. This is the
  default.
- **When you return** shows the **Compact** chip described above.
- **Never** skips idle compaction and Claude's resume prompt. **Auto-compact after**
  still applies, and you can still compact by hand.

## Usage limits

If your Claude subscription runs out of usage mid-turn, the thread shows which
limit was reached and the remaining wait when Claude provides a reset time.
Claude Code holds the turn until that window reopens, so it can keep showing as
working. Wait for the reset, or stop the turn and continue later. The warning's
timestamp shows when the displayed wait started.

## Connectors (MCP servers)

Send `/mcp` in a Claude thread, or choose **Connectors** in the command palette, to see the MCP
servers that thread's Claude has and whether each one is connected. A server that needs a sign in
shows **Sign in**, which opens the server's sign-in page in the Mac's browser. After you finish
there, every running Claude thread that lacked the server connects it. **Retry** connects a failed
server again, for example after you open the app it runs in.

## Skills

Claude skills come from the `skills` folder in `~/.claude` and the project's `.claude/skills` folder. If both define the same name, the config-directory copy
wins. Skills disabled in Claude's settings do not appear in the composer.

Use `$` in the composer to select a skill. Enabled installed Claude plugins also
contribute skills under names such as `plugin:review`. Skills marked `disable-model-invocation`
can still be started by you. Invoke those one per message: Claude directly runs
only the last named skill and may try to start earlier ones through its Skill
tool, which refuses skills reserved for manual invocation.

## Claude workflows and ultracode in Tempo

Claude can split large work into a workflow: a script that runs many agents in
phases, in parallel, and gathers their results. Tempo turns workflows on for every
Claude session.

**Ultracode** asks Claude to plan each turn as a workflow at extra-high effort.
Turn it on with the **Ultracode** button next to the effort picker, with
`mod+shift+u`, or with **Toggle ultracode** in the command palette. It stays on for the
thread until you turn it off, and new threads start with it off. Turns that ran
with it show an **ultracode** badge. Writing the word "ultracode" in a message,
outside quotes and code, also runs that one turn as a workflow; the composer
says **Runs as a workflow** when that will happen.

Ultracode and large workflows use many more tokens than a normal turn, and every
agent's tokens count against your Claude usage limits. Use it for work that splits
cleanly, such as migrations, audits, or reviews from several angles.

A running workflow appears in the thread as a card with its phases, each agent's
state, the agents done so far, and the tokens used. On web and desktop,
**Details** opens every agent's prompt and result, links to agent chats, and
**Copy run id**. **Stop** ends the whole
workflow. A workflow keeps running in the background after the turn that started
it ends; stopping that turn while it is still running stops the workflow too. In
**Supervised** mode, Claude asks before it starts a workflow and shows the
workflow's name, description, phases, and script.

Saved workflows in the project's `.claude/workflows` folder, or in `~/.claude/workflows`,
appear in the composer's `/` menu as
`/workflow:<name>`. Choosing one asks Claude to run it by name.

Worktree threads run with the main checkout's Claude project config, as Claude
Code does for a session in a worktree: its `.claude` folder (workflows, skills,
commands, agents), project settings with their hooks and permissions, and
`.mcp.json`. `CLAUDE_PROJECT_DIR` in hooks points at the main checkout, not the
worktree. Changes a branch makes to that config take effect once they are in the
main checkout.

Tempo keeps the main checkout current for this. Before a worktree thread's turn, at
most once a minute per checkout, it fetches the checkout's branch and
fast-forwards it. It leaves the checkout alone when it is on a branch other than
the default or has no upstream, has uncommitted changes to tracked files or
commits of its own, is mid-merge, rebase, cherry-pick or bisect, or a running
thread works in it or a folder inside it, and when the update would overwrite an
untracked or ignored file.

The **Claude** section of **Settings > Providers** controls workflows:

- **Workflows** turns workflows and ultracode off for the environment.
- **Workflow size** tells Claude roughly how many agents to aim for: small
  (under 5), medium (under 10, the default), large (under 50), or unrestricted.
- **Ultracode keyword** turns off the keyword trigger.

A change to these settings applies from each thread's next message. Running
sessions and workflows keep going. Claude's own Artifact tool is off in Tempo.
