# Product usage data

Tempo does not collect usage data. No build carries a PostHog project, so the server sends no
product usage events unless its environment sets `T3CODE_POSTHOG_KEY` when it starts. Tempo has no
endpoints of its own. With a key, the server sends events straight to PostHog at `us.i.posthog.com`, associated
with a hashed account or installation identifier. To count how many installations one person uses,
the server also sends hashed account identifiers: your T3 Connect account, the OpenAI and Claude
accounts that Codex and Claude Code on that machine are signed in to outside Tempo, and a random
identifier for each device that connects. Events include the provider, model, reasoning effort,
permission mode, turn result, duration, release channel, and main-agent token totals when
available.

Events do not include prompts, responses, file contents, authentication tokens, conversation IDs,
raw provider events, or child-agent output. Child-agent token use is excluded from the totals.

Tempo sends no relay connection traces.

To disable product events, set `T3CODE_TELEMETRY_ENABLED=false` in the server's environment
before starting it. This stops product events from being recorded or sent.

The desktop app reads `T3CODE_TELEMETRY_ENABLED` from your shell profile (for example `~/.zshrc`) on macOS and
Linux, so export it there and restart the app. On Windows, set it as a user environment variable.

## Export diagnostics to your own receiver

To send traces, metrics, or logs to an OpenTelemetry receiver, open
**Settings > Maintenance > Diagnostics**, select an environment, and enter each signal's OTLP HTTP
endpoint under **OpenTelemetry export** (for example `http://localhost:4318/v1/traces`). Save, then
restart that environment's server. The receiver must be reachable from the server's machine.
**Test** sends an empty export from the server to check an endpoint before or after you save it;
saved endpoints are checked when the section opens. Checks send authentication headers only to
the signal's currently running endpoint and do not follow redirects. To check a new endpoint
that requires authentication, save it and restart the server first.

`T3CODE_OTLP_*_URL` and standard `OTEL_EXPORTER_OTLP_*` environment variables override the saved
settings. An overridden signal shows **Set by environment** and names the variable that set it, and its
**Test** checks the running endpoint instead of the field. For endpoints saved here or set with `T3CODE_OTLP_*_URL`, set `T3CODE_OTLP_HEADERS` for
receivers that need authentication and `T3CODE_OTLP_PROTOCOL=http/protobuf` for receivers that do
not accept JSON. An endpoint set with `OTEL_EXPORTER_OTLP_*` takes its headers and protocol from
`OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_EXPORTER_OTLP_PROTOCOL` instead.
