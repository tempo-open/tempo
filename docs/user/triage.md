# Triage an issue

Triage lets your own coding agent investigate a Tempo problem. The agent
reads the logs and state of the machine and can draft a bug report. It asks
before it applies a fix or posts anything.

## In the app

Open the command palette and choose **Triage an issue**. A new thread with no
project opens, with the triage playbook linked in the message. Choose any
provider, describe what went wrong after the link, and send.

Triage runs on the machine of the thread or draft that you have open. With
nothing open, it uses your primary machine if that supports triage, or else the
first connected machine that does. The new thread shows the machine name. The
agent runs inside that Tempo server, so it gives you any restart steps and does not do them itself.

## In a terminal

If the app does not start, or triage does not work in the app, run this in a terminal (install the
`tempo` command first from **Settings → About**):

```sh
tempo triage
```

It starts Claude Code or Codex in your terminal with the same instructions.
