# Working with threads

Use a new thread for a separate task. New threads work in the project folder itself by default.
Choose **New worktree** in the composer when its code changes need a separate branch and working
directory.

## Start a thread

On web and desktop, a new thread keeps the current project and carries your model
and mode selections, unless the destination project has its own model default.
Its branch and workspace mode come from your configured defaults. To continue in
an existing worktree, use **New thread in this worktree** from the branch toolbar.

On mobile, **New thread** starts in the current thread's project, or else in the
last project you opened or chose on that device. If neither is available, the
project picker opens. Turn off **Settings → General → Use last project** to
choose a project every time. When you pick a project that is on more than one
machine, the thread starts on a connected one if any is connected.

When you change a new thread's project, Tempo stays in the current environment
if that project exists there. Otherwise it selects an environment that has it.

### Start without a project

A thread does not need a project. To start one without a project, click **or
start without a project** under a new thread's heading, pick **No project** from
the project menu in that heading or from **New thread in...** in the command
palette, or press `mod+alt+n`. On mobile, pick **No project** from the project
list. It starts on your current machine; before sending, pick another machine
from the machine menu to move it there. To move a draft into a project, pick the
project in the heading.

Each thread without a project works in its own folder under `~/.t3/scratch` (the
`scratch` folder of your T3 data directory), named after its date, the first words
of its first message, and a short id, like
`2026-09-25-convert-these-pngs-to-webp-a1b2c3d4`. Deleting a thread keeps its
folder, so the files the agent wrote stay until you delete them. Branch, worktree, and diff controls stay hidden because
these folders are not Git repositories. This is unavailable when the data
directory itself sits inside a Git checkout.

When the work grows into something real, pick **Turn into project** from the
thread's menu. The thread's folder becomes a project where it is, so nothing
moves and the agent keeps working in the same place. Other threads in that folder
move with it. Rename the project in its settings, and use **Initialize Git** to
get branch and diff controls.

### Start in the background

In a desktop browser or the desktop app, press `Cmd+Enter` on macOS or `Ctrl+Enter`
on Windows and Linux to start a new thread and immediately open another draft. The
next draft keeps the workspace mode and base branch you selected. With **New
worktree**, each background submission creates its own worktree.

To send the same prompt to several models on web or desktop, **Shift-click** models
in a new thread's model picker to add or remove them. A regular click returns to a
single model. Choose a base branch and send. Each selection starts a separate thread
and worktree while you stay in the new thread composer. This requires a Git project.

## Compact sidebar

<!-- tempo: Tempo's opt-in dense sidebar. The rest of this page describes Tempo's sidebar. -->

Turn on **Settings → General → Compact sidebar** to switch the sidebar to one-line rows, with
sub chats nested under the chat that started them. It is off by default; with it off, the classic
look's sidebar matches T3 Code's. The sidebar follows the setting of the primary environment. The
mobile thread list shows the same rows, without nesting, when any environment it lists has the
setting on.

Each row is the thread's title and one thing on the right:

- A chip when the thread needs you: **Approval**, **Question** (an agent is asking you
  something), **Plan** (a plan is ready to act on), **Failed**, **Limit** (a usage limit
  stopped it), or **Done** (it finished since you last opened it).
- A spinner and the elapsed time (for example `2m`) while it is running.
- Otherwise, how long ago you last sent it work.

Hover a row for its project, machine, model and pull requests, and for **Snooze** and **Settle**. The sections
are Tempo's: pinned threads, set off by a line, then your other threads, then **Working** and
**Waiting** unless you turned off the Working section, **Waiting for Production** unless you
turned it off, **Snoozed** and **Settled**.

A thread that needs you stays at its place in your list and shows its chip. While it does, it
never folds into **Working** or **Waiting**, even when a subagent or watch of its own still runs.
Pinned, snoozed, settled and waiting-for-production threads stay in their sections. The thread you
have open keeps its place until you open another one or it starts working again, so a **Done**
thread whose watch still runs does not drop into **Waiting** while you read it.

Sub chats are the chats a chat launched or created. Chats it delegates work to (agents) are not
listed: follow them in the chat that started them, or in **Agents**. Each sub chat shows under
the chat that started it, indented under a thin line, one line each, whichever section it would
otherwise be in. They are always open, and a sub chat can have sub chats of its own. A sub chat
is a normal chat: it has the same chips, spinner and elapsed time as any row, and the same
right-click menu, except Rename. Sub chats go where the chat that started them goes: if that
chat is in a folded section (a collapsed Working, Waiting, Snoozed, Waiting for Production or
Settled section, or Settled past **Show more**), its sub chats are folded away with it, and they
show again under it when that chat's row shows. Search still finds them, and opening one
highlights the nearest chat above it that is showing. A sub chat is an ordinary row in its own
section only when the chat that started it is archived or hidden by a project filter. A fork is
never a sub chat.

A sub chat that needs you is never folded away: while the chat that started it is in a folded
section, it shows as its own row until it no longer needs you. When an agent is waiting on an
approval or a question, including Claude's own background agents such as the ones its Agent tool
starts, the chat that started it shows that need.

With this on, automatic settling also leaves alone:

- Chats a chat delegated work to, which go with their parent. Chats a chat launched or
  created settle like any other chat, and also when you settle the chat that started them.
- Threads that still need you: a **Done** thread you have not opened since it finished,
  a **Failed** or **Limit** thread, a thread with a plan ready, and a thread whose
  subagent is waiting on an approval or a question.

Once you have dealt with them, they settle after the usual days of inactivity. The sidebar
layout follows the primary environment's setting. Each environment's automatic settling reads
its own copy of the setting and applies these exemptions on its own.

## Pin and reorder threads

On web and desktop, the sidebar lists **Pinned**, then **Open**, then **Settled today**: the threads
settled since midnight, with **Show all** for older settled threads. **Working**, **Waiting**,
**Waiting for Production** and **Snoozed** stay at the bottom of the sidebar while the list
scrolls. Each thread is one line; hover it for its project, branch, pull requests and model. Drag
a thread between these sections to pin, wake, settle or un-settle it.

Pin a thread from its menu to keep it above your active work.

On web and desktop, unpinning, settling, snoozing, and archiving a thread each show
a notification with **Undo** for five seconds. Undo restores the thread's previous
state, including its pinned position, and reopens an archived thread you were
viewing. Discarding an unsent draft from the sidebar works the same way: Undo brings
back its text and attachments.

Deleting a thread and closing a terminal do not ask first. A deleted thread leaves the sidebar at
once and keeps running until the five seconds end, so Undo stops nothing. A closed terminal keeps
running the same way, and Undo brings it back. The notification sits in the sidebar's footer, and
shows as a toast while the sidebar is hidden or Settings or Usage is open. If the window closes
inside the five seconds, the delete or close happens then. `mod+z` triggers the most recent Undo, even from the composer; see
[Keybindings](./keybindings.md#commands-with-special-behavior).

On web and desktop, you can also drag files from your computer onto any thread row:
the thread opens and the files are attached in its composer, ready for
your next message. The same per-message file limits apply as when attaching
files directly; see [Attach files](./composer.md#attach-files).

On web and desktop, pinning or unpinning a thread keeps the sidebar at your current
scroll position instead of following the thread to its new place in the list.

<!-- tempo: the server skips pinned threads when it sweeps, with the opt-in sidebar on or off. -->

Pinned threads never settle automatically. Settling a thread removes its pin.

On web and desktop, drag a thread between sections to change its state. Drag a thread up into
the pinned section to pin it at the spot you drop it; drag a pinned thread down into the active
list to unpin it. Dragging a thread onto the **Settled** header settles it, and dragging a settled
thread into the active list un-settles it. A snoozed thread can be dragged out of the snoozed
shelf, which wakes it, but threads cannot be dragged into the shelf because snoozing needs a wake
time. Dragging a pinned thread out of the pinned section does not ask for unpin confirmation.
Pinned and active boundary labels appear only while dragging, without moving the rows. The
other rows slide aside to show where the thread will land. When you cross into another section,
the dragged thread shows the action the drop performs, with its icon: **Pin**, **Unpin**,
**Settle**, **Un-settle**, or **Wake**. Its status and hover actions hide during the drag. A pinned
thread keeps its pin only while it stays in the pinned section; once it leaves, the badge takes
over. Reordering within the same section shows no badge. When there are no pins, drag to the top
edge to pin a thread. Section labels stay readable for the whole drag, and the section the
thread is over takes the accent color. Section labels also
identify empty sections and a collapsed settled shelf.

Drag within the pinned or active section to change its order. Other rows slide aside to show the
spot where the thread will land. Drops into either section keep the position you choose. On
mobile, open a thread's menu and choose **Arrange threads**. Drag a handle within or between
**Pinned** and **Active** to reorder, pin, or unpin. Drop onto the **Settled** divider to
settle a thread. The dragged card shows the action before you release it. Expand **Snoozed**
or **Settled** to drag a parked thread back into either live section. Each drop saves; close the sheet to return to the thread list.
**Move up** and **Move down** are also available in the thread menu. The server
saves the order, so it survives a refresh and appears on your other connected devices.

On web and desktop, the list also animates section changes made with thread actions such as
**Pin**, **Settle**, and **Snooze**. These transitions respect your system's reduced-motion
preference. While dragging, rows follow the insertion gap without replaying a second transition
after the drop.

New threads appear above the active threads you have arranged. Settling clears a thread's active
position, so using **Un-settle** returns it to the top. Pinning and snoozing preserve its active
position until you move it again. Thread activity does not change the order. The settled shelf
continues to use settlement time.

If dragging is unavailable for one environment, update the Tempo server running in that
environment. Pinned and active reordering require server support. Threads from older servers keep
their default order until the server is updated.

To generate a fresh title from the conversation, click the thread's title above the chat and
choose **Regenerate title**. The action is unavailable while title generation is in progress
or when the connected environment needs a server update.

To change how titles are written, add **Thread title instructions** in **Settings → Threads →
Text generation**, under Advanced, such as a length limit or an identifier to put first. They apply to new and
regenerated titles. Select a project to give it its own instructions.

Agents connected through Tempo can use the same server-owned metadata workflow to
rename a thread, regenerate its title, or link and unlink a pull request. These changes
appear on web, desktop, and mobile without requiring the originating browser to remain
open.

### Fold working threads (beta)

<!-- tempo: threads parked on background work fold into Waiting rather than Working. -->

Threads that are working move into a collapsed **Working** section below the active list.
Threads waiting on work they will resume from fold into their own collapsed **Waiting** section,
below Working. That includes subagents, watched pull requests, an
[agent's watcher](project-settings.md#agent-watchers), and background commands or monitors the
agent says it is waiting on. A dev server or other process an agent leaves running does not keep a
thread there, and a thread with a recurring scheduled task is not waiting between its runs. A
thread returns to the top of the active list when it finishes, fails, or needs an approval or
answer. A thread whose agent replied and is only watching something (a pull request or a watcher)
shows **Done** at the top of the active list until you read the reply, then moves to Waiting.
While a subagent of its own still runs, the agent is not done, so the thread stays in Waiting.
Both sections list the thread you last sent work to first. Pinned threads stay in the pinned
section.

This is on by default. Turn it off with **Settings → General → Working section** on web and desktop,
or **Settings → General → Working section** on iOS and Android. Each device keeps its own
choice.

While this is on, the active list is ordered by when each thread last came back to you, so you
cannot drag or move threads within it. Your saved order returns when you turn it off.

### Group threads by project (beta)

Turn on **Settings → Labs → Boring sidebar (group by project)** on web and desktop to put active
threads in a folder for each project. A project with no active threads has no folder until you
pick it in the project filter. Click a folder to open or close it. A closed folder shows how
many threads it holds, and a dot when one of them needs you. Use the pen button on a folder, or
right-click it, to start a thread in that project. Pinned threads stay above the folders, and
Snoozed and Settled stay below them. In this mode you cannot drag threads, and the Working section
is off. Each device keeps its own choice.

## Settle finished work

Choose **Settle thread** from its menu to move finished work out of the active list
without deleting the conversation. **Un-settle thread** restores it to active work
and prevents automatic settlement until new activity resumes the usual rules.
Settling a thread that is still working stops it first, as **Stop** does. Messages
you queued stay held in the queue until you resume them. A thread waiting on an
approval or a question asks you to answer it first.
Manually settling an idle thread dismisses unanswered async questions without
sending an answer or restarting the agent. Settling also closes the thread's
terminals that wait at an idle prompt, and keeps their output. A terminal that
runs a command, such as a dev server, stays open.

Settling a thread also deletes the scheduled tasks and watchers that post into it, so
a settled thread stays settled. **Un-settle thread** and **Undo** don't bring them
back. Automatic settling keeps them, and tasks that start a new thread on each run
keep running.

Settling a thread also settles every chat under it: the chats it delegated work to,
launched or created, and theirs in turn. Each one settles as if you had settled it,
so one that is still working stops first. A chat waiting on your answer stays active,
and so do the chats under it. **Un-settle thread** brings back the ones that settled
with it, as they were, so they settle automatically again; a chat you settled yourself
stays settled. Automatic settling never takes the chats under a thread along.

To reclaim disk space from settled work, turn on **Run in the thread's worktree when the
thread settles** for one of the project's actions, or set `"runOnSettle": true` on a
`t3.json` script, for example `cargo clean`. It runs each time a thread in its own
worktree settles, manually or automatically, even if a terminal there still runs a
command such as a dev server. Threads in the project's main checkout skip it. Its terminal
closes when the command succeeds and stays open when it fails.

On web and desktop, press a thread's **Settle** button and drag up or down to
settle every thread in that section between it and the one you release on.
The **Un-settle** and **Wake** buttons work the same way in their sections.
Press `Escape` while dragging to cancel.

By default, threads settle only when you settle them. In thread behavior settings,
environments can settle inactive threads after a number of days and settle threads
whose pull request merged. A closed pull request can also settle an idle thread.
An empty thread's inactivity counts from when it was created.
Work in progress, pending questions or approvals, and background work the agent
is waiting on prevent automatic settlement. An open pull request does not prevent inactivity
settlement unless you turn on **Keep threads with a PR** in **Settings → Threads**,
but an old closed or merged pull request does not settle work you
resumed after it closed. Only your own messages count as resuming. A turn that
finished background work or a pull request watch starts on its own does not.

To keep one thread out of the settled shelf no matter how long it sits idle, click its title
above the chat, choose **Auto-settle behavior**, and pick **Disabled**. The current option is checked. Pick
**Enabled** to return to the usual rules. Manual settle, snooze, and archive still work while it
is disabled.

Change these rules in **Settings → Threads**.
They continue to run when your apps are closed. On web and desktop, choose an environment at the
top to change only its rules, or **All environments** to update connected environments together.
Mixed values show where the selected environments disagree. Mobile applies these
rules to connected environments that support shared settings. Offline environments
and older servers keep their previous values. Changing a rule does not reopen
already settled threads.

## Link a pull request

The server finds the PR for each unsettled thread's saved branch, even when your
apps are closed. Settled threads keep their saved links. Update the server if
automatic branch links do not appear.

On web and desktop, right-click a pull request link in a thread and choose
**Link to thread** to select a different PR. Use **Unlink from thread** on the
same link to return to the branch PR, if one exists.
The linked pull request participates in automatic settlement.

## Find and reference work

On web and desktop, open the command palette with `Cmd/Ctrl+K`, or the search field in the title
bar, to search threads across connected environments by title, branch, pull request, or project.
Threads you open often or recently rank higher, and for three weeks the thread
you last picked for a query ranks higher when you type that query again.
Threads whose messages contain all your words appear below, under **In
messages**, and open at the matching message. Message search needs at least
one word of three or more letters, or two for Chinese, Japanese, and Korean.
On mobile, the thread list search also lists message matches and opens them at
the matching message; on an iPad with a keyboard, `Cmd+K` opens the same
palette.

Use **Settings → Keybindings** to find or customize shortcuts for searching files
and copying a thread reference. A copied reference uses the thread's pull request
link when available, otherwise the thread itself, which pastes into a composer as
a thread chip. To copy the thread even when it has a PR, choose **Copy → Thread**
from its context menu, or **Copy thread** from its long-press menu on mobile.
**Thread ID** copies the bare ID for scripts and the `t3` CLI. See
[keybindings](./keybindings.md) for custom configuration.

## Inspect agent work

**Limited** means the provider stopped on a usage or rate limit. The conversation
keeps the provider's explanation. Retry after the limit resets, or switch to
another provider instance.
On web and desktop, press **Resume** in an empty composer to continue a limited
or interrupted turn manually.
Queued messages stay saved while the limit blocks the thread. They run after
the continuation finishes. If the queue was held by a restart, resume it then.

When the provider reports a reset time, choose **Resume at reset** to schedule a
continuation. You can cancel it from the thread. Enable **Resume after
usage limits** in **Settings → Threads** to schedule limit stops by default.
The environment must be running when the reset arrives; it resumes overdue
continuations after a restart. Stopping the thread, sending a new message,
archiving, or settling it prevents a pending continuation from starting.

Choose **Snooze until reset** to hide the thread until its allowance returns.
Snooze and auto-resume are independent: snooze alone wakes the thread without
sending a message; enabling both wakes and continues it. **Wake now** cancels
the snooze. **Snooze until limits reset** and **Resume after usage limits** are on by default;
turn them off in thread behavior settings. Providers without a reset time offer manual
retry and the normal snooze choices.

On web and desktop, use **Agents** to follow work delegated to subagents.
Stop on a thread also stops the subagents it delegated to.

<!-- tempo: approvals from agents and sub chats show in the chat that started them. -->

Subagent threads started by the agent can't take messages; message the parent
thread instead. When an agent or sub chat a chat started needs an approval, the
approval shows in that chat, where you approve or deny it.

Expand a tool call in the conversation to see its full command and output.
Summaries shorten shell wrappers and can still describe the latest call after it
finishes; the call's own result shows its status.

On web and desktop, the thread details card lists the web servers that the
thread's terminals or its Claude agent started, with their ports. A server the
agent started stays listed after the agent's turn ends.
Select a server to open it in the browser panel. **Stop** ends the server's job
and keeps the agent, the terminal, and Tempo running. Stop needs terminal
access to the environment and is not available on Windows.

To choose what the thread details card shows, right-click the card or open
**Settings → Appearance → Thread details**. Hidden rows keep their keyboard
shortcuts, such as Open in editor and project scripts. **Reset to default** brings
back the standard rows.

## Snooze until later

To change the choices in the snooze menu, open **Settings → Threads → Snooze options**.
Each option is a duration, such as 3 hours, or a time on a day, such as 9:00 PM
tomorrow. A weekday means the next one after today. Menus list the options soonest
first and hide a today option after its time passes. Saved with **All environments**
selected, the options apply to every connected environment, and the mobile app uses them too.

Choose **Snooze → Custom…** from a thread's menu to pick a date and time in your
local time zone, or a duration in minutes, hours, or days. Durations start when
you confirm; one day means 24 hours. On web and desktop, you can also snooze
several selected threads together. Choose **Wake thread** to bring a thread back early.
A snoozed thread keeps working and stays hidden until its wake time, even while
its agent wakes itself for background work. It comes back early only when it needs
an approval or answer from you, when a run fails, or when you send it a message.

## Wait for production

Waiting for production is available only on machines whose Tempo server has
`TEMPO_PRODUCTION_REPOSITORY` set to a GitHub repository (`owner/name`). Elsewhere the menu
item does not appear and agents' `wait_for_production` calls are refused.

When a thread's work is merged to staging and the rest can only happen once it
is live, choose **Wait for production** from the thread's menu, or from the command
palette on web and desktop. The thread moves to **Waiting for Production**, under
**Snoozed** in the sidebar and in the mobile thread list. To keep waiting threads in your list
on web and desktop instead, turn off **Settings → General → Waiting for Production section**.
The next time staging is
promoted to production, Tempo sends the thread "Staging has been promoted to
production. Continue where you left off." and the agent carries on. Agents can park
their own thread the same way with the `wait_for_production` tool.

Each machine checks that repository every two minutes while one of its threads waits,
with the GitHub account it uses for pull requests (usually `gh auth login` on that
machine). A promotion is a deployment to the repository's `production` environment by
its deploy workflow, `.github/workflows/deploy.yml` unless `TEMPO_PRODUCTION_WORKFLOW` names
another; production deployments by other workflows do not count. A promotion counts once it succeeds; one already running when the thread
started waiting does not. A machine that was asleep during a promotion wakes its waiting
threads when it is back.

Choose **Stop waiting for production** to end the wait without a message. Settling or
archiving a thread also ends it, and a waiting thread never settles automatically.
Sending a message does not end the wait: the thread runs, then goes back to waiting.
While a waiting thread is running or needs your answer, it shows with your active work.
