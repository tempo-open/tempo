# Threads from older Tempo versions

On your first V2 launch, Tempo copies the V1 database, `state.sqlite`, into `statev2.sqlite`
in the same data directory and migrates the copy. Your threads appear automatically, with full
transcripts imported as needed. You do not need to run an import command.

V1 continues using its original database while V2 uses the copy. The database import can run while
V1 is open. Opening V2 again resumes your V2 history. The copy happens only once: later conversations
and changes in either version do not sync to the other. Settings, attachments, and workspace files
remain shared.

The V2 desktop app uses a separate browser profile, so browser cookies and caches do not carry
over from V1. You may need to sign in again to websites opened inside the app. On its first launch,
the V2 desktop app copies stashed prompts, unsent drafts, layout, and theme from V1. Anything you
change in V2 afterwards stays in V2.

The migrated thread keeps its title, project, provider and model selection, permission and
interaction modes, branch or worktree, archive state, settlement state, snooze and pin state, and
linked pull request. Tempo also brings over user and assistant messages, their timestamps, and
supported attachments. Large histories may appear in stages while the server imports transcripts.

The migration does not recreate the old provider's live session. It also does not convert old run
records, checkpoints and diffs, tool activity, approval history, or proposed plan history into the
new format. These items may be absent from a migrated timeline even though the conversation text is
present.

## Continuing a migrated thread

The first new message starts a fresh provider session. Tempo selects intact user and assistant
messages using the same [handoff budget](./portable-handoffs.md) as a provider switch. Omitted text
remains in the thread and can be retrieved by the agent. The migration retains its separate
32,000-character recovery excerpt; neither that excerpt nor the handoff replaces the full imported
transcript.

Before continuing a long or important thread, read the recent transcript and include any older
requirements the agent still needs in your next message. Starting a new thread and pasting a short
handoff is also a good choice when the old conversation contains conflicting instructions.

## Moving a thread to another machine

When the desktop or web app is connected to more than one environment, for example your laptop and
another Mac, open a thread's menu (right-click it in the sidebar, or use the menu in the chat header)
and choose **Move to** and the machine; **Here** is the machine this app runs on. The command palette offers **Move thread to …** for the open thread. Only machines whose server
can move threads, and on which this connection may change threads, branches and files, are listed.

A thread in a Git repository with a remote moves its Git work, and the other machine finds its copy
of the repository by that remote. If it has no project for the repository, the move stops with
**Open \<repository\> as a project on \<machine\> first**: add the project there and try again.
Any other thread, such as one under **No project**, in a plain folder, or in a repository without a
remote, moves as a copy of its whole folder, `.git` included; see
[Threads without a Git remote](#threads-without-a-git-remote). Stop a running turn before moving a
thread.

The move carries the conversation with its attachments and plans, the linked pull request, and the
thread's Git work: the branch, commits that are not on the repository's remotes yet, and
uncommitted changes, including untracked files. On the other machine the thread opens in a new
worktree on the same branch (or `<branch>-moved` when that name is taken), tracking the same
upstream branch when that machine has it, with the uncommitted changes still uncommitted. Staged
changes arrive unstaged. Files Git ignores, such as `.env` and `node_modules`, stay behind, and the
project's worktree setup script runs in the new worktree. Tool activity and checkpoints stay with
the original copy, and moving away leaves the original checkout as it was.

The original becomes a read-only copy that says where the thread went and links to it, in the
mobile app too. Scheduled tasks that posted into the thread are paused; recreate them on the other
machine. To keep working on the original machine anyway, for example when the other machine is
gone, fork the read-only copy. If the original could not be marked as moved, both copies stay
usable and the notification says why. After a dropped connection it offers **Try again**. If the
original took a new turn during the move, the moved copy does not have that turn: keep the copy you
want and archive the other.

The moved thread continues like a [migrated thread](#continuing-a-migrated-thread): the next
message starts a fresh provider session that receives the history. If the other machine does not
have the thread's provider, pick a model before continuing.

Moving a thread back uses the same commands. When its original checkout is still on the branch,
commit, and uncommitted changes it left with, the thread returns to that checkout, which picks up
the work done away. Otherwise it arrives in a new worktree like any other move. Either way it
arrives as a new thread beside the read-only copy it left there, which keeps the tool activity from
before the move.

### Threads without a Git remote

A thread with no Git remote to find its repository by brings a copy of its folder: every file and
folder in it, including a repository's `.git`. On the other machine it opens under **No project**
in a new folder, made the way a new thread there gets one, and the notification names that folder.
Moving it back copies the folder again into another new folder; the original folder stays as it
was.

Sockets, devices, files the app cannot read, and links that point outside the folder stay behind,
and the notification lists them. A worktree's `.git` link to a repository elsewhere stays behind
too, so its files arrive without Git history. A thread that ran in the shared **No project**
folder, rather than one of its own, moves without files. A folder over 2 GB, or with more than
100,000 files and folders, cannot move: delete what can be rebuilt, such as `node_modules`, or move
large files out of it. Both machines need a Tempo that moves folders; otherwise the move stops
and says which one to update.

## Importing your T3 Code threads

Tempo can copy the projects and threads of T3 Code on the same machine. Open **Settings →
Maintenance**, choose **Scan** under **Import from T3 Code**, and check what it found: T3 Code's
folder (`~/.t3`), how many threads each project would bring, and which Tempo project they go to. A
project whose folder Tempo does not have yet arrives as a new project. Then choose **Import**.
When you are connected to several machines, each one imports its own T3 Code.

The import brings your current work: active and snoozed threads, and a snoozed thread stays
snoozed until its wake time. Settled and archived threads stay in T3 Code unless you turn on
**Also import settled threads**; then they arrive settled or archived.

Each thread brings its conversation: user and assistant messages, proposed plans and their
attachments, with its title, branch, worktree and linked pull requests. Tool activity, checkpoints
and diffs stay in T3 Code, as do its settings, provider sign-ins and connections. T3 Code's data
is only read, never changed, and T3 Code keeps working as before.

An imported thread continues like a [migrated thread](#continuing-a-migrated-thread): its first new
message starts a fresh provider session that receives the history. It keeps working in the
same checkout, so a thread in a T3 Code worktree still uses that worktree. If you continue a
thread in both apps, the two copies drift apart.

Running the import again brings only threads it has not brought before; a thread you deleted from
Tempo after importing it stays deleted. Some threads wait for a later run: threads T3 Code is
still working on (quit T3 Code first to import everything), older threads whose history T3 Code
has not loaded yet (open T3 Code once and let it finish), and threads in a project whose folder is
gone or that you removed from Tempo after an import (add the folder as a project again to bring
them). If T3 Code is newer than Tempo, update Tempo first.

## Your Codex and Claude Code threads

Tempo keeps the threads you start in Codex (the CLI or the Codex app) and in Claude Code on the
same machine. Each one appears in the project for its folder, which Tempo adds when it has none,
and stays current: new messages arrive within a minute or two, and a thread you archive or delete
there is archived here, and comes back if you restore it there. A thread started in a git
worktree, such as one the Codex app made, appears in its repository's project and keeps working in
that worktree. Each machine you are connected to brings its own threads. To stop, turn off
**Settings → Threads → Sync Codex and Claude Code threads**; threads already brought stay.

Left out: threads already archived or deleted there, sub-agents, scripted runs (`codex exec`,
`claude -p`), the threads a Codex automation starts each time it runs (the automation itself
comes over, see below), threads other apps started through Codex or Claude Code (Tempo's own
included), and threads started in a folder Tempo would not add as a project, such as your home
folder, Downloads or Codex's scratch folder `Documents/Codex`.

A synced thread continues its own Codex or Claude Code session, with its full history. Once you
continue it here it is this Tempo's thread: what happens to it in Codex or Claude Code afterwards
is not brought over. A synced thread you delete here stays deleted. Codex and Claude Code files are
only read, never changed.

Scheduled tasks come too: Claude Code's saved scheduled tasks and Codex app automations become
scheduled tasks here, **paused**, so nothing runs twice while Codex or Claude Code still run them.
Turn each on in **Settings → Scheduled tasks** once you stop it there. A task made in a thread runs
in that thread; the others start a new thread each time. When Tempo cannot follow a schedule
exactly, such as a monthly date or several times a day, the task runs on the nearest schedule it
can and its title says how it runs there. One-time Claude Code reminders stay out. A change to a
task there updates it here without turning it on or off; deleting it there removes it here unless
you turned it on.

## Keeping a recovery copy

Tempo does not currently have a whole-thread export command. Before a major server update, stop
the server and copy its `userdata` directory to a safe location. For Tempo the default is
`~/.tempo/userdata`; a server started with `--home-dir <path>` uses `<path>/userdata`.

If a migrated transcript is missing from the app, keep that copy unchanged. You can inspect the
old transcript without starting a server against it:

```sh
sqlite3 -readonly /path/to/recovery-copy/state.sqlite
```

At the SQLite prompt, list recent legacy threads:

```sql
.headers on
.mode tabs
SELECT thread_id, title, updated_at
FROM projection_threads
ORDER BY updated_at DESC;
```

Then print one transcript, replacing `<thread-id>` with the value from the first query:

```sql
SELECT role, text, created_at
FROM projection_thread_messages
WHERE thread_id = '<thread-id>'
  AND role IN ('user', 'assistant')
ORDER BY created_at, message_id;
```

Open only the copied database. Do not edit it or point a newer or older server at your recovery
copy. If the affected environment is remote, make and inspect the copy on the machine that runs
that environment.
