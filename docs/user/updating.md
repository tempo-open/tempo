# Updating Tempo

## Desktop updates

Tempo does not update itself: the update button's tooltip and **Settings → About → Version** say
"This build does not get updates." To update, download the newer disk image from the latest release
on the repository's Releases page and replace Tempo in Applications. If you built the app yourself,
pull the repository and rebuild it.

## Before you update

Replacing the app restarts its server, which can interrupt active agents and terminal commands.
Saved threads, settings, and project files remain.

**Settings → Maintenance → Continue threads after restarts** is on by default. It resumes
supported active threads after an update, crash, or machine restart. Tempo must start again on that
machine; the setting does not enable automatic startup. Terminal commands may still be interrupted,
and threads without saved provider resume state need a new message. A thread that finished its turn
to wait on a subagent, a background task, or a command or monitor the agent said it was waiting on
is woken and told that this work stopped. Other background shells and monitors, such as a dev
server and its watchdog, do not wake it; the thread learns about them with your next message. A
thread is not resumed while it waits for your approval, answer, or secret, or while it is archived,
snoozed, or settled. After three automatic resumes in a row, the thread waits for your next message.

Updates from the previous orchestration system preserve conversation transcripts but cannot carry
every kind of runtime history forward. Read [Threads from older Tempo versions](./thread-migration.md)
before continuing an important older thread.

## When versions don't match

A client and server must speak the same orchestration protocol. If they do not, the connection is
refused rather than running half-upgraded:

- An app newer than the server is blocked before connecting, with a notice telling you to update
  Tempo on the machine named in the notice.
- A server newer than your app refuses the connection with an update message.

Install the same Tempo release on the machine the notice names, then reconnect.

## If the desktop app does not start

If the desktop app's server keeps failing at startup, Tempo shows a "Tempo could not start" window
instead of the app. Download the latest release and replace the app, or go back to the release that
last worked. **Copy details** copies the error.

Only one server can use a Tempo home directory at a time. If startup reports that another server
owns it, stop that server before retrying.

## Update providers

Each environment keeps its providers current by itself, even with no app connected. When
Claude Code falls behind its latest version, the environment updates it once no chat is using
it, so running chats are not interrupted. Codex moves to the version your Tempo release ships with.
A failed update is tried again the next day, or as soon as a newer version is out. Provider
update checks find the new versions, so with them off only Codex updates. To update by hand
instead, turn off **Update automatically** in **Settings → Providers**.

**Settings → Providers** shows provider updates for the selected environment.
**Update all** updates every outdated provider on every connected environment
at once. Hover it to see which providers it will update. Providers that only
offer a manual update command are not included.

After a successful provider CLI update, Tempo refreshes model discovery for
every enabled instance of that provider using its own configuration. Connected
clients receive the refreshed catalogs automatically. Provider update checks
must be enabled to download the latest model catalog.

Provider updates do not restart running chats. An existing session can keep
using the previous CLI until it ends. If discovery fails, check the provider
status and refresh it again.

Provider update checks and restart continuation preferences are in
**Settings → Maintenance**. If provider update checks are disabled, enable them
there before refreshing to find newer versions. The same setting controls whether
Tempo downloads model catalog updates, so with it off new models may not appear
until you enable it and refresh provider status.
