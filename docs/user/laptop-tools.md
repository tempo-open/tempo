# Laptop tools for remote threads

When a thread runs on another machine, such as a desktop in the office, its
agent can ask to use tools on the laptop you are driving it from: computer use
(screenshots, mouse and keyboard on your Mac) and a browser on your laptop,
which reaches your laptop's `localhost` and the sites you are signed in to
there. Nothing runs until you turn a tool on in the desktop app on the laptop.
Computer use, on the laptop or on a thread's own machine, never controls
Tempo itself, so its window stays where you left it.

## Turn it on

1. In the desktop app on your laptop, open **Settings → Devices → Laptop
   tools** and turn on the tools you want to offer. Each needs its command
   installed on the laptop; the row says whether it was found. Turning a tool
   on starts it once to list its tools, which is what agents see.
   - **Computer use** runs `open-computer-use mcp`. Install it with
     `npm i -g open-computer-use`, then grant **Open Computer Use** Screen
     Recording and Accessibility in System Settings.
   - **Laptop browser** runs `npx -y chrome-devtools-mcp@1.10.1`, which needs
     Node and Chrome.
2. Turn on **Agent laptop access** for the environment (the same page, with the
   environment or a project selected in the header). It applies when a
   thread's agent session next starts.
3. Keep a desktop app window open and connected to that environment. It
   offers your tools to every environment it is connected to with operate
   access. Closing the window, even with the app still in the Dock, stops
   offering them.

Agents then see `laptop_tools_list` and `laptop_tool_call`, and can use them
while their thread's run is active. Listing never starts a tool. With several
laptops connected, an agent picks one by its name.

## Computer use on the thread's own machine

Laptop tools reach the laptop you drive a thread from. To let an agent use the
screen, mouse and keyboard of the machine its thread runs on, leave **Agent
computer use on this machine** on, on the same settings page with that
environment selected. It is on by default. A change applies when a thread's agent
session next starts. Agents see `computer_use_tools` and `computer_use`, use them
without asking, and try APIs and the command line first. They still refuse to
control Tempo itself.

- The machine needs macOS. The first call installs Open Computer Use into the
  environment's tools folder, which takes about a minute.
- Grant **Open Computer Use** Screen Recording and Accessibility in System
  Settings on that machine once. Until then, the first call opens its
  permission window there, and the agent tells you what to allow. On a machine
  with no monitor, use Screen Sharing to reach it.
- A machine with no monitor gets a virtual display while agents use it, so apps
  still have a screen. It needs the Command Line Tools
  (`xcode-select --install`).
- Calls run one at a time, since every thread on that machine shares its
  screen. After ten idle minutes, Open Computer Use and the virtual display
  stop.

## Allowing a thread

Tools you turned on work as soon as an agent calls them. To approve each
thread first, turn on **Ask before an agent uses a laptop tool** on the same
settings page. Then the first time a thread's run uses a tool, the app window
on your laptop asks **Allow for this thread** or **Deny**. It does not take
focus: the Dock bounces and a notification opens the window. Deny is the
default button. Denying or leaving the question unanswered until the agent
gives up refuses that tool to the thread for the rest of its run; its next run
asks again. If a tool's command or the laptop browser profile setting changes,
the next call asks again. Turning asking on ends the access threads already
have, so their next call asks.

Whether or not you are asked, pressing Stop refuses that tool to the thread
for the rest of its run. A thread may use a tool until its run ends, it goes
unused for 30 minutes, or you stop it. While any thread is allowed, a laptop
item in the menu bar (and the Dock menu) lists the threads with **Stop**, so
you can stop them while another app is in front; the sidebar shows the same. **Stop all laptop
tools** ends every grant and cancels calls in progress. **Settings →
Devices → Laptop tools → Allowed threads** stops one at a time.

An agent waits at most four and a half minutes for one call, including your
answer.

## The laptop browser and your logins

By default the laptop browser keeps its own Chrome profile, so agents only see
sites you sign in to in that window. To let agents use the Chrome you already
have open, with all of its logins, turn on **Use my own Chrome for the laptop
browser**, then turn on remote debugging at `chrome://inspect/#remote-debugging`.
Chrome asks you to allow each connection.

## Which `localhost`

- Browser tabs in the Browser panel run on the environment, so `localhost`
  there is the machine the agent works on, and the agent can drive the tabs
  you open. Use **Open on this computer** in a tab's menu when only your laptop can
  reach the page. An environment that cannot run a browser opens tabs on this
  computer instead, where `localhost` is your laptop.
- The laptop browser runs on your laptop, so `localhost` there is your laptop.

## Other tools

**Add a laptop tool** offers any MCP server that speaks stdio. It runs on the
laptop without a shell: give a command on PATH or an absolute path, then its
arguments. New tools start turned off.

## Passkeys

Server tabs whose browser profile takes passkeys from iCloud Keychain sign in
with your Mac's passkey sheet ([Extensions and passkeys in the Tempo
browser](./tempo-browser-extensions-passkeys.md)). Your Mac asks first when an
agent, or a tab nobody is driving, wants to sign in. **Answer passkey
requests** in **Settings → Devices → Laptop tools** says whether this Mac
can answer, and turning it off sends those tabs to their profile's saved
passkeys instead.
