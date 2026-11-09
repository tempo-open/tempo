# Extensions, passkeys and passwords in the Tempo browser

Server browser tabs (the browser that runs on an environment, such as another Mac, and streams to
your laptop) can load Chrome extensions and keep passkeys, and every tab saves the
passwords you sign in with. All of them belong to a browser profile on that environment, so a
profile's extensions, passkeys and passwords follow its tabs to every device you drive them from.

Open **Settings → Browser → Browser profiles**, open a profile's menu, and choose
**Extensions, passkeys and passwords**. If you have more than one environment with a server
browser, pick the environment at the top. Changing extensions, passkey or password access needs a
connection that can change settings.

## Extensions

Every profile starts with **uBlock Origin Lite**, which blocks ads, trackers, and malware sites
with its own default filter lists. An environment adds it once, the first time the profile opens a
server tab there; turn it off or remove it like any other extension, and it stays that way.

Paste a Chrome Web Store link or a 32-letter extension id and choose **Add**. The environment
downloads the extension from the Web Store, checks its signature, and reloads the profile's open
server tabs with it. To load an extension you are developing, enter the absolute path of its
folder on the environment instead; **Check for updates** reloads it from that folder and fetches
new versions of Web Store extensions.

Use the switch to turn an extension off without removing it. In the browser panel, the **More**
menu's **Extensions** submenu opens an extension's popup or options page as a tab. Pages an
extension opens by itself, such as a password manager's pop-out window, open as tabs in the thread
you last used that profile in. Agents cannot drive an extension's own pages, except uBlock Origin
Lite's warning before a site it blocks outright: they can read it, go back or proceed, or leave it.

If **Check for updates** cannot reach one extension (for example, it left the Web Store or its
folder moved), it updates the others and names the one it could not check.

Extensions need Manifest V3. The first extension in a profile makes the environment download the
full Chrome for Testing build (about 200 MB, once), because the lighter headless browser cannot run
extensions. **Extensions and passkeys** says when it is still downloading. Until then the profile's
tabs open without their extensions, and they reload with them once it is done.

When the environment runs inside the desktop app, the desktop app draws that environment's tabs
itself whenever it shows them, and those tabs load neither these extensions nor saved passkeys.
Electron, which draws them, lacks the Chrome features password managers rely on; passkeys there
work as in the desktop app's own browser tabs. Extensions and saved passkeys work in tabs an
environment runs without the desktop app, such as a server started with `tempo serve`.

## Passkeys

There are three ways to use passkeys in server tabs:

- **Your password manager.** 1Password, Bitwarden, and similar extensions keep their own passkeys.
  Add the extension to the profile and sign in to it. Windows it opens, such as its passkey
  prompts, open as tabs in the thread you last used the profile in.
- **Saved passkeys.** With **Save passkeys in this browser** on (the default), passkeys you create
  in a profile's server tabs are kept on the environment and work in every tab of that profile.
  The list shows each passkey's site, account, and when it was created and last used; delete one
  there. A site keeps one saved passkey per account: registering the account again replaces it.
- **iCloud Keychain on your Mac.** Set **Passkeys from** to **iCloud Keychain (your Mac)**, and
  sign-ins in that profile's server tabs use the passkeys on the Mac you drive the tab from:
  iCloud Keychain, the Passwords app, and password managers that offer passkeys to macOS, such as
  1Password, as well as your phone or a security key.

### iCloud Keychain from your Mac

Open the server tab in the desktop app on your Mac and sign in as usual. Your
Mac shows its passkey sheet for the site; that sheet is where you approve each sign-in or new
passkey. The first request for each site from each machine since the desktop app opened asks you
first, naming the thread and machine: deny it if you did not just start that sign-in. While it is open, the sidebar shows which site, thread and machine asked. The passkey
stays in your Mac's keychain, so the environment never sees it, and it works on your other Apple
devices like any iCloud Keychain passkey.

The status under **Passkeys from** says whether this Mac can answer:

- **Available**: sign-ins from tabs you drive on this Mac use its passkey sheet.
- **Waiting for Apple approval**: this build of the desktop app is not allowed to use your
  Mac's passkeys.
- **Turned off**: **Answer passkey requests** is off in the desktop app's **Settings →
  Devices → Laptop tools**. Turn it back on there.
- **Needs macOS 15 or later**, or **needs the desktop app on a Mac**: the device you are on
  cannot answer.
- **Did not load**: the desktop app could not load macOS passkeys. Update or reinstall it.

When no Mac can answer (you drive the tab from the web, the desktop app is not
connected to that environment, or it is waiting for approval), the tab uses the profile's saved
passkeys instead if **Save passkeys in this browser** is on, and the sign-in fails if it is off.
Saved passkeys also answer passkey autofill, sign-ins inside embedded frames, and pages on the
environment's own `localhost`, which is that machine and not your Mac. Tabs already open follow a
change of **Passkeys from** right away.

If nobody holds the tab, a sign-in the page starts by itself goes to the Mac only when exactly one
Mac is connected to the environment, and that Mac asks first, naming the thread and machine.
**Deny** stops that thread asking again for a minute.

Tabs on the desktop app's own environment are drawn by the desktop app itself, and neither the
profile's provider and saved passkeys nor **Let agents use passkeys** apply to them. Once this build
is approved they use your Mac's passkey sheet directly. If an agent opened such a tab or acted in
it, the first passkey request for each site since the desktop app opened asks you first: deny it
if you did not just start that sign-in. **Deny** stops that site asking again for a minute.

## Agents and passkeys

**Let agents use passkeys** is off by default. While it is off, a passkey sign-in fails in any
server tab an agent opened or worked in, and in pop-ups opened from such a page, whichever provider
the profile uses. Anything the agent left running on the page could otherwise sign in once you look
away, so the page stays locked until you load a new one yourself: reload the tab or enter an
address. Following a link does not count, because the agent's script could do
that too. A pop-up and the tab that opened it can reach each other, so they share the lock: close a
pop-up the agent used before you reload the other tab. Pages only you have used keep their passkeys.
Turn the setting on only for profiles whose accounts you are happy for agents to sign in to. With
iCloud Keychain, an agent's sign-in still needs you: your Mac first asks whether to continue, naming
the thread and machine, and then shows its passkey sheet. If no Mac answers, the agent's sign-in
fails; in an iCloud Keychain profile, saved passkeys never answer for an agent. Password-manager
extensions follow their own rules.

## Passwords

With **Save passwords** on (the default), each sign-in, sign-up or password change you submit in a
profile's tabs is saved for that site, with no prompt. Signing in again with a new password
replaces the old one. A site that asks for your username on one page and your password on the next
is saved as one account. Turning it off stops saving new passwords; saved ones still fill in.

When a page shows a sign-in form, the browser fills in the username and password saved for that
exact site, picking the account you signed in with last when there are several. A page on any other
site gets none of them, even inside a frame of a site you saved. Sign-up and change-password forms
are left for you to fill. This works in every tab of the profile, including the tabs the desktop
app draws for its own environment. The list shows each saved password's site and username, and
when it was saved and last used; remove one there.

**Let agents use passwords** is on by default, so pages agents open or work in are filled in too,
and agents can sign in to the sites you saved. Turn it off for a profile whose accounts agents
should not use. Then nothing is filled in a page an agent opened or worked in, and anything filled
in a page is emptied before an agent acts there. As with passkeys, reload the page yourself to have
it filled again; in a tab the desktop app draws for its own environment, open a new tab instead.
What an agent signs in with is still saved.

## Privacy

Saved passkeys stay on the environment, in its secret store, and their private keys never reach
your devices. Saved passwords stay there too: your devices only see their sites, usernames and
dates. iCloud Keychain passkeys stay on your Mac: the environment only passes the site's
request to it and the signed answer back. Anyone who can change settings on that environment can
manage a profile's extensions, passkeys and passwords. Clearing a profile's cookies and cache leaves its
extensions, saved passkeys and saved passwords in place; remove them in **Extensions, passkeys and
passwords**. Removing the profile deletes its extensions, saved passkeys and saved passwords from
every connected environment. Incognito tabs keep none of them.
