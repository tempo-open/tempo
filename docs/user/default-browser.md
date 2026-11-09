# Use Tempo as your default browser

On macOS, the desktop app can be your default web browser. Links you open from other apps then
open in Tempo. When the thread on screen shows its browser panel, the link opens there as a new
tab. Otherwise it starts a new thread without a project, with the browser panel maximized on the
page, so you can ask an agent about it right away.

Choose **Tempo** under **System Settings → Desktop & Dock → Default web browser**. To go back,
choose another browser there.

Pull request links for a connected project open in the pull request view when opening pull
request links in the app is enabled. Other links still open in the browser panel.

HTML files you open from Finder open the same way. [Prompt links](prompt-links.md) to
app.t3.codes open in the app as a draft.

A link that launches Tempo waits until the app has connected to its environment, then opens.

## Links you click in Tempo

**Settings → Browser → Open links in** chooses where a link you click in the chat or the terminal
opens:

- **Side panel for your work**, the default: the pages a thread opens and anything served from
  this Mac, such as a dev server, open in a tab in the thread's side panel.
  Every other link opens in your default browser.
- **Your default browser**: every link opens in your default browser.
- **Side panel**: every link opens in a tab in the thread's side panel.

A page you click in the side panel's Deliverables tab, and a link you click in a file shown in the
side panel, open in the side panel whatever this setting says. Hold ⌘ while you click a link to
open it in your default browser.
