# Service connections for agents

> **Tempo:** agents get these tools once a local connection is saved on this Mac.

Agents in Tempo can call services such as OpenRouter and Cloudflare through Tempo
instead of holding the keys themselves. The agent names a connection, Tempo sends
the request with the key attached, and hands back the answer with any key
redacted. Keys never appear in tool calls or results.

## Adding a connection

Connections are saved on one environment. Add them in
**Settings → Integrations → Service connections** with **+**: pick OpenRouter,
Cloudflare, or a custom HTTP API, then enter the base URL, the header the key
goes in, and the key. Use **Test** to check it. The key is write-only: you can
replace it, but no client ever reads it back.

The key is stored in the environment's data directory, readable by your user
account. Tools never show it, but an agent that can run shell commands on that
machine could read the file.

Agents see each connection as `local/<name>`.

## What a local connection allows

- **Methods.** Only GET unless you tick more. Anything but GET and HEAD is a
  write. The OpenRouter key tools need POST, PATCH, and DELETE; the Cloudflare
  DNS tool needs POST and PATCH.
- **Path prefixes.** One per line, such as `/keys`. Empty allows every path
  under the base URL.
- **Host.** Requests never leave the base URL's host and path, and redirects
  are returned to the agent instead of followed. Changing a connection's host
  asks for the key again.

## What agents get

`services_list` shows the connections. `service_request` sends one request
through any of them. OpenRouter connections also get tools to list, create,
update, and delete API keys and to read credits and activity; Cloudflare
connections get tools to list zones, DNS records, and Workers, and to create or
update a DNS record. OpenRouter key management needs a management key.

A key an agent creates with `openrouter_key_create` is written to a new file the
agent names, readable only by your user account, and the result shows the file's
path instead of the key. That keeps the key out of the thread's history.

Responses are cut at 1 MB, and only ordinary headers (content type, rate
limits, and similar) are passed on.

## Approvals

Reads, like listing keys or zones or a `service_request` with GET or HEAD, run
without asking.

In **Full access**, writes to Cloudflare and OpenRouter run without asking, for Claude and Codex
alike. A write to a path that sends mail, and any write through a custom HTTP API, still asks,
because those can reach people.

In every other mode, every write asks you first. That covers creating, updating or deleting an
OpenRouter key, writing a Cloudflare DNS record, and any other `service_request`. The
approval card names the tool, the connection and what it changes. Your saved
connection secrets and Tempo's own keys show as `[redacted]` when sent as
they are, and so does any field whose name looks secret. An encoded or split
copy, or another secret under a plain field name, shows as sent. The card
offers **Allow once** and **Deny**, so the next write asks again.

The write runs only on **Allow once**. If you deny it, stop the turn, or leave
it for 10 minutes, nothing is sent and the agent is told why. Agents can't
answer these cards through Tempo's tools, not even ones they started. In
**Supervised**, the agent's own approval may come first, so you can see two
asks for one write.

To let agents write without the card, turn off **Ask before service writes** in
**Settings → Integrations**, under the environment's service connections. It applies to every agent on that
environment from the next write, needs permission to manage its providers, and
leaves reads and Agent service access as they are.

The card guards Tempo's tools, not the shell: an agent in **Full access** can
still reach a service directly, through its secret files or
`tempo auth session issue`.

## Who can use them

Only agents Tempo starts get the service tools. MCP clients signed in from
outside Tempo (see [Outside agents](./outside-agents.md)) cannot call them.

## Turning it off

**Settings → Browser → Agent service access** turns the tools off for the
environment, and a project can override it. The change applies when an agent
session next starts. **Restore defaults** turns it back on.
