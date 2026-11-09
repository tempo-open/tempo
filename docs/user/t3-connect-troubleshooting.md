# T3 Connect troubleshooting

<!-- tempo: Tempo on the host runs its tunnel, so Details shows no separate tunnel part. -->

T3 Connect is upstream T3 Code's relay. It is off in Tempo unless the build is configured for a
relay; without that configuration none of this page applies.

A T3 Connect connection goes through three parts, in this order:

1. **This device** reaches T3 Connect over the internet.
2. **T3 Connect** checks your sign-in and the host's link.
3. **Tempo on the host** answers. While it runs, it keeps the host's tunnel
   (cloudflared) connected to T3 Connect.

When a connection fails, open **Settings > Environments**, find the environment,
and select **Details**. The first part marked as failed is the cause. Find its
section below.

The commands below are subcommands of the `tempo` CLI on the host. To see the host's
side, run `connect status` on the host, or open **Settings > Environments** on the
host. Both check the host's T3 Connect address from the host, and say why it
fails. `connect` runs the same check when it finishes setup. This check cannot
test another device's network. For a problem on one device, use **Details** on
that device.

## The host's tunnel is offline

T3 Connect could not reach the host's tunnel. This means one of these:

- The host is asleep, turned off, or offline.
- Tempo is not running on the host.
- The host's network blocks the tunnel. See
  [Port 7844 is blocked on the host](#port-7844-is-blocked-on-the-host).

Fix:

1. Make sure the host is awake and Tempo runs on it.
2. On the host, run `connect status`. It names the problem on the host's side.
3. If the host was offline for a long time, T3 Connect removes its tunnel. Start
   Tempo on the host and update it to the latest version. It gets a new tunnel.

## Port 7844 is blocked on the host

The tunnel on the host connects out to Cloudflare on port 7844, with TCP and
UDP. Both tunnel protocols (QUIC and HTTP/2) use this port. When the host's
network blocks it, the tunnel cannot start, but normal web traffic still works.
The host looks online, so this problem is easy to miss.

Common causes:

- **A Tailscale exit node on the host.** All of the host's internet traffic goes
  through the exit node, and that network blocks port 7844. Turn off the exit
  node on the host with `tailscale set --exit-node=`, or allow outbound port
  7844 on the exit node's network.
- **A VPN on the host.** Work VPNs often block unknown ports. Ask for port 7844
  to be allowed, or use a direct route instead (see below).
- **A firewall or strict network.** Allow outbound TCP and UDP port 7844.

If you cannot unblock the port, you can connect without T3 Connect. When the
host and this device are on the same Tailscale network, add the host's
Tailscale address as a direct route. See
[Reach one machine several ways](./remote-access.md#reach-one-machine-several-ways).

<a id="the-tunnel-works-but-t3-code-does-not-answer"></a>

## The tunnel works, but Tempo does not answer

The host's tunnel is up, but it cannot reach Tempo on the host. Common causes:

- Tempo on the host stopped, crashed, or is still starting.
- Tempo restarted on a different port, for example after an update, and the
  tunnel still points at the old port.
- The server binds only one network address with `T3CODE_HOST`. The tunnel
  sends requests to `127.0.0.1`, so the server must also listen there.

Fix: restart Tempo on the host. For the background service, run
`tempo service restart`. Then run `connect status` on the host.

<a id="the-t3-connect-address-does-not-resolve-or-answer"></a>

## The T3 Connect address does not resolve or answer

The host's T3 Connect address did not resolve, refused the connection, failed a
secure (TLS) connection, or did not answer in time.

Fix:

1. Make sure the host is awake and online.
2. On the host, run `connect status`.
3. If the check fails only on the host, check the host's DNS, VPN, or proxy.

<a id="this-device-cant-reach-t3-connect"></a>

## This device can't reach T3 Connect

The problem is on this device's network, not on the host. This device could
not reach T3 Connect, or it reached T3 Connect but not the host's tunnel
address.

Fix:

1. Check this device's internet connection. On a captive or dead Wi-Fi network,
   the device can look online but cannot reach anything.
2. A VPN, firewall, ad blocker, or DNS filter on this device can block T3
   Connect. Turn it off for a moment to test.
3. Try another network, or add a direct route to the host, such as its
   Tailscale address. See
   [Reach one machine several ways](./remote-access.md#reach-one-machine-several-ways).

## Sign-in, account, or link problems

T3 Connect does not have an active link between your account and the host.

- **The host is linked to a different account.** Sign in to the same T3 Connect
  account on this device and on the host. On the host, run `connect logout`,
  then `connect`.
- **T3 Connect is off on the host, or the host only publishes agent activity.**
  On the host, open **Settings > Environments** and turn **T3 Connect** on, or
  run `connect`.
- **The host was linked, but the server did not apply the link yet.** Run
  `tempo service restart` on the host, or restart `tempo serve`.
- **This device's sign-in expired, or the host no longer accepts this
  device.** Sign out of T3 Connect and sign in again.
- **Your account reached its tunnel limit.** Remove an environment you do not
  use from T3 Connect, then restart Tempo on the host.

## The clock is off

T3 Connect signs requests with short-lived proofs. When the clock on this
device or the host is a few minutes wrong, T3 Connect rejects them. Turn on
automatic date and time on both devices, then retry.

<a id="the-host-runs-an-older-t3-code"></a>

## The host runs an older version of Tempo

This app needs a newer Tempo on the host. Update Tempo on the host. See
[Updating Tempo](./updating.md).

<a id="t3-connect-returned-an-error"></a>

## T3 Connect returned an error

| Error                                                     | Fix                                                                                                                                |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `environment_link_limit_exceeded` or managed tunnel limit | Remove an unused environment, then restart Tempo on the host.                                                                      |
| `auth_invalid` or `invalid_bearer`                        | Run `connect login`. If credentials were revoked, run `connect logout`, then `connect` again. Restart the server after signing in. |
| Expired or invalid link proof                             | Check the host's date and time, update Tempo, then restart it.                                                                     |
| HTTP 403 without a recognized error                       | Check relay access, proxies, and firewall rules. Keep any Cloudflare Ray ID for a bug report.                                      |
| HTTP 408, 429, or 5xx                                     | Wait a few minutes. Tempo retries temporary failures on its own.                                                                   |

After you fix a permanent rejection, restart the host's server with
`tempo service restart`. For a foreground server, stop it and run `tempo serve` again.

If Tempo on the host disappears when SSH closes, see
[background-service troubleshooting](./background-service.md#troubleshooting).

## Report a problem

Tempo does not take issues. T3 Connect runs only on a deployment that a build names itself, so if
none of this helps, send the problem to whoever runs that deployment. Include:

- The text from **Copy diagnostics** in the environment's **Details**.
- The output of `connect status` on the host.
- The trace ID, if one is shown.
