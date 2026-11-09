# Install Tempo

Tempo is a desktop app for Macs with Apple silicon. It runs coding agents on your Mac.

## Desktop app

1. Download `Tempo-<version>-arm64.dmg` from the latest release on the repository's Releases page.
2. Open the disk image and drag Tempo to Applications.
3. The app is not signed or notarized, so the first time you open it macOS says it cannot verify
   the developer. Open System Settings, then Privacy & Security, and press **Open Anyway** next to
   Tempo.

Each release lists the disk image's SHA-256 in `SHA256SUMS.txt`. To check a download, run
`shasum -a 256 Tempo-<version>-arm64.dmg` and compare.

Tempo does not update itself. To update, download the newer disk image and replace the app. To
build the app yourself, see [Development and local builds](../operations/development.md#desktop-artifacts).

## Requirements

You need an installed, signed-in agent before starting a thread. You can open Tempo and set up the
agents afterwards.

## Providers

Tempo runs Claude and Codex on this Mac's own Claude Code and Codex sign-ins: see
[Claude and Codex in Tempo](./claude-and-codex.md).

| Provider | Install and sign in                                                                          |
| -------- | -------------------------------------------------------------------------------------------- |
| Claude   | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`. |
| Codex    | Install [Codex CLI](https://developers.openai.com/codex/cli), then run `codex login`.        |

Provider CLIs must be on your `PATH`. If Tempo cannot find one, set its **Binary path** in
**Settings → Providers**, especially when you use a version manager.

When a provider CLI is behind its latest release, its provider card shows the available version.
**Update now** runs the installer that owns the CLI (Homebrew, or a global npm, pnpm, Yarn, Bun,
Volta, or Vite+ install), or the CLI's own update command when Tempo cannot tell.

## The `tempo` command

The desktop app includes the `tempo` command-line tool. To run it from any terminal, open
**Settings → About** and choose **Install** next to **tempo command**. It adds a `tempo` link to a
folder on your `PATH`; open a new terminal afterwards. **Remove** takes it off again. Tempo never
installs T3 Code's `t3` command.

With the desktop app running, `tempo app` opens a new thread for the current directory, adding the
project if needed. Pass a path, such as `tempo app ../my-project`, to open another directory.

## T3 Code

Tempo is built on [T3 Code](https://github.com/pingdotgg/t3code). To install T3 Code itself, follow
its own documentation.

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Running in the background](./background-service.md): keep a Mac host available.
- [Updating Tempo](./updating.md): update the app and connected servers.
