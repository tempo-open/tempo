# Tempo docs

> Tempo follows these upstream T3 Code guides with its own names: the CLI is `tempo`, the data home
> is `~/.tempo`, the default server port is 3873, and app ids start with `local.tempo.app`. The
> [README](../README.md) has the full list. Tempo has no mobile app, so steps for the mobile app
> are upstream only. Upstream only, not used by Tempo: the Cursor and ACP guides, and the release,
> T3 Connect setup and relay observability runbooks.

## Using Tempo

- [Install Tempo](./user/install.md)
- [Messages and context](./user/composer.md)
- [Working with threads](./user/thread-sidebar.md)
- [Permission modes](./user/permission-modes.md)
- [Terminal history](./user/terminal.md)
- [Source control](./user/source-control.md)
- [Project settings](./user/project-settings.md)
- [Agent instructions (CLAUDE.md / AGENTS.md)](./user/agent-instructions.md)
- [Appearance and themes](./user/appearance.md)
- [Keyboard shortcuts](./user/keybindings.md)
- [SnapShots](./user/snap-shot.md)
- [Visual replies](./user/html-renders.md)
- [Import browser sessions](./user/browser-import.md)
- [Extensions, passkeys and passwords in the Tempo browser](./user/tempo-browser-extensions-passkeys.md)
- [Use Tempo as your default browser](./user/default-browser.md)
- [Devices](./user/devices.md)
- [Usage and limits](./user/usage.md)
- [Product usage data](./user/telemetry.md)
- [Remote access](./user/remote-access.md)
- [Guest links](./user/guest-links.md)
- [T3 Connect troubleshooting](./user/t3-connect-troubleshooting.md)
- [Laptop tools for remote threads](./user/laptop-tools.md)
- [Outside agents (MCP)](./user/outside-agents.md)
- [Service connections for agents](./user/service-connections.md)
- [Running in the background](./user/background-service.md)
- [Updating Tempo](./user/updating.md)
- [Triage an issue](./user/triage.md)
- [Claude and Codex in Tempo](./user/claude-and-codex.md)
- Provider guides: [Codex](./user/providers-codex.md) · [Claude](./user/providers-claude.md). Upstream only, not used by Tempo: [OpenCode](./user/providers-opencode.md) · [Antigravity](./user/providers-antigravity.md) · [Pi](./user/providers-pi.md) · [Muse Code](./user/providers-muse.md) · [fx](./user/providers-fx.md)

---

## Working on Tempo

Start with the [development runbook](./operations/development.md). Tempo takes no issues or pull
requests; see [CONTRIBUTING.md](../CONTRIBUTING.md).

Internal notes preserve architectural decisions, constraints, and implementation traps that the
source alone does not explain. Most code changes do not need an internal documentation update. Follow the
[documentation rules](../AGENTS.md#documentation) before adding one.

- [Architecture overview](./internals/overview.md)
- [Glossary](./internals/glossary.md)
- [Connection runtime](./internals/connection-runtime.md)
- [Providers](./internals/providers.md)
- [Adding a provider](./internals/adding-a-provider.md)
- [Pull request file revisions](./internals/pull-request-file-revisions.md)
- [Model classification](./internals/model-manifest.md)
- [Remote environments](./internals/remote.md)
- [Server updates](./internals/server-updates.md)
- [Resource telemetry](./internals/resource-telemetry.md)
- [Product analytics](./internals/product-analytics.md)
- [Environment auth](./internals/environment-auth.md)
- [T3 Connect](./internals/t3-connect.md)
- [Assistant citations](./internals/assistant-citations.md)
- [Terminal runtime](./internals/terminal-runtime.md)
- [Devices](./internals/devices.md)

### Runbooks

- [Development and local builds](./operations/development.md)
- [T3 Connect setup](./operations/connect-setup.md) (upstream only)
- [Release](./operations/release.md) (upstream only)
- [Pulling T3 Code stable releases](./operations/tempo-t3-stable-releases.md)
- [Observability](./operations/observability.md)
- [Relay observability](./operations/relay-observability.md) (upstream only)
