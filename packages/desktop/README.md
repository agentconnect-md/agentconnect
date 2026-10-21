# @agentconnect.md/desktop (prototype)

Prototype of the **desktop daemon** from the computer-use design
([`docs/designs/computer-use.md`](../../docs/designs/computer-use.md), tracked in [#3182](https://github.com/agentconnect-md/agentconnect/issues/3182)). It runs inside the
logged-in desktop session, embeds [Cua Driver](https://github.com/trycua/cua/tree/main/libs/cua-driver)
(MIT) for screenshots and input, and exposes the design's `computer_*` tools as an MCP
server that Claude Code (or any MCP client) can use.

It runs standalone with local client tokens, or registered with a Control Plane as a Computer
(see [Register with a Control Plane](#register-with-a-control-plane)). No relay or AgentConnect
daemon is involved yet.

## Status: M0 prototype

This package is the prototype merged as milestone M0 of the design's development plan (§14.3).
The npm package stays private and is not published to npm; the `desktop` container image built from it
is published with each AgentConnect release (see [Run in Docker](#run-in-docker)).

**What works today**

- The `computer_*` MCP tools over Streamable HTTP (bearer token per client) or stdio, with one
  control lease, human-activity arbitration, an owner pause, no-replay `uncertain` results, and a
  local audit log.
- The `/view` browser remote desktop: WebRTC video (ffmpeg + werift) with a screenshot-polling
  fallback, and human takeover.
- `setup` / `doctor` on macOS, Linux (X11 and GNOME Wayland) and Windows; a macOS LaunchAgent
  (`.app` mode) and a Linux systemd user unit; Windows logon autostart.
- A Docker image (Xvfb + Xfce + Firefox ESR) that registers from its environment, amd64 and arm64.

**Limits**

- Registration with a Control Plane and its Computer channel work (status, capabilities, `doctor`,
  revoke). `ComputerPolicy` is enforced only for the lease limits. Approvals, per-agent
  authorization, the data plane and object-store screenshots are still missing. Local client
  tokens stand in for them, and removing a token takes effect only after a restart.
- Plain HTTP with a bearer token. The daemon listens on `127.0.0.1` by default; other machines
  can reach it only when you pass `--host 0.0.0.0` (or another address) explicitly, and then the
  token is the only protection.
- One display, no audio, no clipboard sync; keyboard activity is not detected (only pointer
  movement); no tray icon, screen border, or global stop hotkey.
- Builds are unsigned (macOS `.app` is ad-hoc signed; no Windows installer), so OS grants do not
  survive a rebuild.
- CI covers X11 under Xvfb only (see [Development](#development)); the real-session matrix of design
  §13 is still run by hand. The `agentconnect desktop` CLI subcommand arrives with
  [#3185](https://github.com/agentconnect-md/agentconnect/issues/3185); `agentconnect-desktop` is a development bin.

```
Claude Code ──HTTP (Bearer token)──▶ agentconnect-desktop ──stdio MCP──▶ cua-driver mcp --direct ──▶ desktop
 (any machine)                        (user's logon session)              (pinned 0.35.2, sha256-checked)
Browser ─────WebRTC video + input───▶     │  ffmpeg screen capture → H.264 → werift (WebRTC)
```

It also serves a browser remote desktop at `/view` so a person can watch the screen
and take over from agents (see [Remote desktop viewer](#remote-desktop-viewer)).

## Install: `setup`, then `doctor`

Everything that needs a download or a person's approval happens once, in `setup`, run **on the
desktop itself** (not over SSH or RDP-from-a-service):

1. Config and a client token. The token is printed once, together with the `claude mcp add`
   command and the `/view` link.
2. Pinned Cua Driver and ffmpeg, both sha256-checked.
3. OS approvals:
   - **macOS**: requests Accessibility and Screen Recording for the app running setup (usually
     Terminal). It opens the matching System Settings pane and waits until each is switched on.
     Then a test ffmpeg capture raises the separate "bypass the private window picker" consent.
     Screen Recording takes effect after quitting Terminal (Cmd+Q) and reopening it.
   - **Windows**, only when listening beyond loopback (`--host 0.0.0.0`): adds the inbound
     firewall rule "AgentConnect Desktop (Node.js)" for this `node.exe`, covering all network
     profiles (Tailscale is often _Public_), after one administrator prompt. It disables any
     block rule that Windows created when someone pressed Cancel on its own prompt.
4. Runs `doctor`.

`doctor` is read-only and can be run any time. It exits 1 when a required check fails, and every
failure comes with its fix. It checks:

- config and tokens;
- the desktop session (SSH or Session 0 cannot capture; disconnecting RDP locks the session);
- that Cua Driver starts;
- the macOS permissions;
- a real screenshot;
- display sleep;
- ffmpeg and a real one-frame capture;
- the Windows Firewall rules for Node.js;
- whether a daemon is already running.

`run` also keeps the display awake while it runs (`"keepAwake": true`; macOS `caffeinate`, Windows
`SetThreadExecutionState`). A sleeping display cannot be captured: macOS even removes its capture
devices.

## Run on Windows

Requirements: Windows 10/11 x64 or arm64, a logged-in desktop session, Node.js ≥ 24.12
(`winget install OpenJS.NodeJS`).

1. Build the bundle on a dev machine (`pnpm --filter @agentconnect.md/desktop bundle`) and copy
   the `bundle/` directory (`agentconnect-desktop.mjs`, `install.ps1`, `README.md`) to the
   Windows machine.
2. In a normal (non-admin) PowerShell on the Windows desktop, run:

   ```powershell
   .\install.ps1            # copies to %LOCALAPPDATA%\AgentConnect\desktop\app and runs setup
   node "$env:LOCALAPPDATA\AgentConnect\desktop\app\agentconnect-desktop.mjs" run
   ```

   The daemon then listens on `127.0.0.1` only. To reach it from another machine, run
   `.\install.ps1 -ListenHost 0.0.0.0` instead: `setup` saves the address and adds the inbound
   firewall rule, which a loopback-only install skips.

   `run` is a plain foreground process: `Ctrl+C` stops it and closes the port. Keep the console
   window open: it is the indicator and emergency stop. Running `node agentconnect-desktop.mjs run`
   straight from the copied `bundle/` folder also works; it does the downloads itself but skips the
   firewall step.

Nothing is installed as a service. With `-Autostart`, `install.ps1` also adds a per-user
`HKCU\...\Run` entry that opens the daemon console at logon (`autostart disable` removes it). A real
Windows service would not work anyway: services live in Session 0 and cannot see the user desktop.

To start over (new token), delete `%LOCALAPPDATA%\AgentConnect\desktop\config.json`, or run
`node agentconnect-desktop.mjs token add claude` to rotate the token.

## Run on macOS

Requirements: Node.js ≥ 24.12. No Homebrew or sudo is needed: the official tarball unpacked to
`~/.local/node` works. In **Terminal on the Mac** (not over SSH: macOS grants the permissions to
the app that starts the daemon), copy the `bundle/` directory to the Mac and run:

```sh
./install.sh                                                    # copies to ~/.agentconnect/desktop/app, runs setup (permission dialogs), then doctor
open ~/.agentconnect/desktop/app/"AgentConnect Desktop.command" # starts the daemon in Terminal
```

On macOS 27, Accessibility is named _Device Control and Data Access_. Being listed there is not
enough: the switch must be on. Without it, clicks and keys are silently dropped, though pointer
moves still work. Cmd shortcuts are allowed on macOS; only lock screen, log out, and force quit are
refused. ffmpeg is a pinned static 6.0 build (eugeneware/ffmpeg-static b6.1.1).

### macOS app mode (prototype): the app holds the permissions, not Terminal

`pnpm bundle:macos` builds `AgentConnect Desktop.app` (`md.agentconnect.desktop`): the daemon as a
Node single executable app on the official, pinned Node.js, ad-hoc signed. Install it and run
`setup` from the app's binary. This works from Terminal or over SSH:

```sh
ditto -x -k AgentConnect-Desktop-macos-arm64.zip ~/Applications/
~/Applications/"AgentConnect Desktop.app"/Contents/MacOS/agentconnect-desktop setup
```

- `setup` installs a per-user LaunchAgent (`~/Library/LaunchAgents/md.agentconnect.desktop.plist`,
  Aqua session, starts at login, restarts on crash) and starts it. launchd starts the app itself,
  so macOS attributes Accessibility and Screen Recording to **AgentConnect Desktop**. Cua Driver
  and ffmpeg run as its children and inherit the grants. The app raises the dialogs itself.
  `setup` opens the System Settings panes, waits, and restarts the service until a new Screen
  Recording grant takes effect. Then it runs `doctor` inside the service.
- `doctor` asks the running service to run the checks as its own child (`/control/doctor`, loopback
  only), so the result reflects the app's grants. `--here` checks the calling process instead.
- `service start | stop | restart | status | uninstall` manage the LaunchAgent. The log is
  `~/.agentconnect/desktop/daemon.log`.
- Ad-hoc signing ties the grants to this exact build: each rebuild must be granted again.
  Distribution needs a Developer ID signature plus notarization (`CODESIGN_IDENTITY=...`; the
  hardened runtime then needs the JIT entitlements for Node). Unsigned zips downloaded through a
  browser are quarantined and blocked by Gatekeeper.

## Run on Linux

**One-line install** (what the console's **Computers → Add Computer** shows for Linux): run it in a
terminal inside the desktop session, as the desktop user, not root.

```bash
wget -nv -O- https://<control plane>/v1/computers/install.sh | sh -s -- --register <token>
```

The Control Plane serves `install.sh` with its own URL and the bundle's sha256 filled in. The
script downloads the pinned official Node.js 24.12.0 (x64 or arm64, sha256-checked) into
`~/.agentconnect/desktop/runtime`, the daemon bundle into `~/.agentconnect/desktop/app`, puts an
`agentconnect-desktop` launcher in `~/.local/bin`, then runs `setup --register`. Running it again
upgrades in place and keeps an existing registration when the token is already spent; `--name`,
`--cp-url` and `--no-service` pass through to `setup`. Run over SSH, it installs the service, which
then starts at the next desktop login. The Control Plane image ships the bundle; elsewhere build it
with `pnpm --filter @agentconnect.md/desktop bundle` or point `COMPUTER_DESKTOP_BUNDLE_DIR` at it.

Requirements for running from source: Node.js ≥ 24.12 (the official tarball in `~/.local/node` works), a logged-in
graphical session, and `setup` run inside it. Over SSH, export the session's `WAYLAND_DISPLAY`,
`XDG_RUNTIME_DIR`, and `DBUS_SESSION_BUS_ADDRESS` first. `setup` downloads Cua Driver and a pinned
static ffmpeg (6.0, libx264).

- **X11**: Cua Driver captures and injects through X11/XTest, and the viewer uses ffmpeg `x11grab`.
  Nothing needs approving.
- **GNOME Wayland**, tested on Ubuntu 26.04 / GNOME 50. X11 grabbers only see Xwayland clients
  there, so:
  - Cua Driver runs in its Wayland mode (`CUA_DRIVER_RS_ENABLE_WAYLAND=1`, set by the daemon). It
    needs its GNOME Shell helper extension `winrects@cua` for pixel geometry, capture, and safe
    input. `setup` installs it; **log out and back in once** so GNOME loads it.
  - Input goes through the xdg-desktop-portal **RemoteDesktop** portal plus libei. `setup` presses
    Shift once so GNOME asks; switch on _Allow Remote Interaction_ and keep _Remember This
    Selection_. The grant is kept in `~/.config/cua-driver/libei-persistent.token`.
  - Video uses the **ScreenCast** portal plus PipeWire. A small Python helper (`python3-gi`) holds
    the portal session and runs GStreamer (`pipewiresrc ! videorate ! y4menc`) into the pinned
    ffmpeg, because distro GStreamer often has no H.264 encoder. `setup` asks once; the restore
    token is kept in `screencast.token`.
  - GNOME shows its screen-sharing indicator in the top bar while either session is active, and
    `run` holds an idle inhibitor (`gnome-session-inhibit`) so the screen does not blank or lock.
  - Known limits: libei types key codes, so text that needs an input method (e.g. Chinese) is
    dropped. KDE Plasma Wayland lacks Cua Driver's activation adapter.
- **Background service**: `setup` installs and starts a systemd user unit
  (`~/.config/systemd/user/agentconnect-desktop.service`). It is wanted by
  `graphical-session.target` (GNOME, KDE) and also started by an XDG autostart entry
  (`~/.config/autostart/agentconnect-desktop.desktop`). That entry imports the session's display
  variables first, for desktops such as Xfce that never activate the target.
  - The unit runs a copy of the bundle from the data dir, restarts on failure, and stops with the
    session. Xfce never stops `graphical-session.target`, so the autostart entry also records the
    logind session id and the daemon exits when that session closes; the next login starts it
    again with the new display.
  - `ExecCondition` skips it when there is no display, so it never crash-loops outside a session.
  - Cua Driver runs in its own `systemd-run --scope`, so apps an agent launched survive service
    restarts and upgrades.
  - Commands: `service status | restart | stop | uninstall`; logs with
    `journalctl --user -u agentconnect-desktop`. `setup --no-service` skips the unit.
- X11 types characters missing from the keymap by remapping a spare keycode. On real Xorg,
  back-to-back remaps raced (`你好` became `好好`), so non-ASCII text is sent one character at a
  time. Desktops other than GNOME get `xset s off -dpms` instead of an idle inhibitor.
- Tested: Ubuntu 26.04 arm64 with GNOME 50 Wayland, and with Xfce 4.20 on Xorg (LightDM, because
  GDM 50 no longer starts X11 sessions) and on Xvfb.

## Run in Docker

The `desktop` image (`ghcr.io/agentconnect-md/desktop`, amd64 and arm64, published with each release) is a
Debian trixie desktop with Xvfb, a lean Xfce, Firefox ESR, Noto CJK fonts, the pinned Node.js, and the daemon
with Cua Driver preinstalled. ffmpeg (GPL) is not in the image: the daemon downloads the pinned, sha256-checked
build on first start into the volume, and the viewer polls screenshots until it is there. The entrypoint starts Xvfb on `:1` (`RESOLUTION`, default
`1600x900x24`), a session D-Bus, Xfce and a maximized browser, then runs `run` in the foreground as user
`desktop`. The browser is restarted when it exits or crashes (`BROWSER`, default `firefox-esr`; `none` turns it
off; `BROWSER_URL` opens a page). `docker stop` stops the daemon, closes the browser, then the session, with exit
code 0. `/home/desktop` is a volume: the Computer key, config, audit log, and the browser profile survive a new
container. A `HEALTHCHECK` runs `doctor --json --daemon` inside the running daemon.

Register it as a Computer: create a token in the console under **Computers → Add Computer**, then

```sh
docker run -d --name desktop --hostname desktop-1 --shm-size=1g --restart unless-stopped \
  -v desktop-home:/home/desktop \
  -e AGENTCONNECT_CP_URL='https://<control plane>' -e AGENTCONNECT_REGISTER_TOKEN='<token>' \
  ghcr.io/agentconnect-md/desktop:latest
```

| Variable                            | Meaning                                                                                                                                                               |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENTCONNECT_REGISTER_TOKEN`       | the one-time registration token; the session, browser and driver never see it, and it is never printed (`docker inspect` and `docker exec` still do: prefer the file) |
| `AGENTCONNECT_REGISTER_TOKEN_FILE`  | a file holding the token instead, such as a Docker or Kubernetes secret under `/run/secrets`                                                                          |
| `AGENTCONNECT_CP_URL`               | the Control Plane URL the console prints with the token                                                                                                               |
| `AGENTCONNECT_COMPUTER_NAME`        | the name to register with when the console gave none; defaults to the container hostname                                                                              |
| `PUBLIC_URL`                        | how clients outside reach the published port, printed instead of the container address                                                                                |
| `RTC_ADDRESS`, `RTC_PORTS`          | the public IP offered as the only WebRTC candidate (defaults to `PUBLIC_URL`'s host), and a fixed UDP range                                                           |
| `RESOLUTION`, `LISTEN_HOST`, `PORT` | the screen, and where the daemon listens inside the container (`0.0.0.0:7681`)                                                                                        |

The token is spent on the first start; the stored key remembers its sha256, so later starts with the same token
and Control Plane leave it unused (keep the volume). A different token, such as a new one after a revoke or for
another org, is spent and replaces the stored key. Without a token the
daemon runs in local mode and writes its first client token to `~/.agentconnect/desktop/client-token` instead of
the log (`docker exec desktop cat /home/desktop/.agentconnect/desktop/client-token`).

The console's viewer reaches a registered container through the relay and needs no published port. For a viewer
or MCP client that connects directly, publish the port and the UDP range and say where they are:

```sh
docker run -d --name desktop --shm-size=1g -v desktop-home:/home/desktop \
  -p 7681:7681 -p 7700-7709:7700-7709/udp \
  -e PUBLIC_URL="http://$HOST_IP:7681" -e RTC_PORTS=7700-7709 ghcr.io/agentconnect-md/desktop:latest
```

WebRTC behind NAT: by default the daemon offers the address the browser reached it on, which in bridge
networking is the container IP. `--rtc-address` (`rtcAddress`) replaces it as the only host candidate,
and `--rtc-ports MIN-MAX` (`rtcPortRange`) pins the UDP ports so they can be published. Each viewer uses
up to two ports from the range, so publish at least 8. With `--network host` on a Linux host neither is
needed.

Build it locally from the repository root, and smoke-test it the way CI does:

```sh
docker build -f packages/desktop/docker/Dockerfile -t agentconnect-desktop .
packages/desktop/docker/smoke.sh agentconnect-desktop
```

## Connect Claude Code

The first `run` (or `init`) prints the exact command, for example:

```text
claude mcp add --transport http computer http://127.0.0.1:7681/mcp --header "Authorization: Bearer acd_..."
```

The daemon listens on `127.0.0.1` unless you ask otherwise, so by default only clients on the
same machine (or through an `ssh -L` tunnel) reach it. `--host 0.0.0.0` on `setup`, `init`, or
`run` listens on every interface; `setup` and `init` save it in `config.json` (`"host"`) for the
service. Traffic is plain HTTP and the token is the only protection, so do that on a trusted
network only. A `config.json` written by an earlier prototype build may still say `"0.0.0.0"`.

If Claude Code runs on the same Windows machine you can use stdio instead:
`claude mcp add computer -- node <path>\agentconnect-desktop.mjs stdio`.

## Remote desktop viewer

Open `http://<host>:7681/view` in any modern browser and sign in with a client token.
The first `run` prints a ready link of the form `/view#token=...`. The token is in the URL fragment,
so it never reaches the server or proxy logs, and the page keeps it in `localStorage`.

- **Video**: ffmpeg captures the primary display (Windows: `ddagrab`, falling back to
  `gdigrab`; macOS: `avfoundation`; Linux: `x11grab`). It encodes H.264 constrained baseline
  (`libx264 ultrafast/zerolatency`, `streamFps` 30, `streamMaxWidth` 1920,
  `streamBitrateKbps` 2500, 1 s keyframe interval, keyframes capped by a small VBV buffer), and [werift](https://github.com/shinyoshiaki/werift-webrtc)
  (MIT, pure TypeScript) sends it over WebRTC. One capture is shared by every viewer and stops
  when the last viewer leaves. Packets are paced at 1.5x the bitrate, because an unpaced keyframe
  burst overflows thin links (e.g. Tailscale over the internet) and is lost whole. On slow links,
  lower `streamBitrateKbps` / `streamMaxWidth`.
- **Signaling** uses the same port and token (`POST /view/api/rtc/offer` / `answer`). The
  daemon is ICE-lite with host candidates only: no STUN/TURN and no external server. It
  advertises the address the browser reached it on, so Tailscale and LAN both work. Media runs
  over UDP on random ports, so the Windows firewall must allow Node.js (accept the prompt).
- **ffmpeg**: on Windows, the first `run` downloads the pinned gyan.dev build
  (9.0.2 essentials, GPL, ~110 MB, sha256-checked) in the background, or run `install-ffmpeg`
  ahead of time. Elsewhere it uses `ffmpeg` from PATH. `ffmpegPath` overrides it, and
  `"webrtc": false` disables it.
- **Fallback**: without ffmpeg, or when WebRTC cannot connect, the page polls
  screenshots (2–5 fps). It switches to WebRTC once that is ready.
- **Control**: watching never blocks agents. _Take control_ blocks agents with
  `human_in_control` (like an owner pause) until _Release_. Control is also released 15 s after
  the browser goes away. Mouse, wheel, keyboard, double-click, drag, and right-click go over a
  WebRTC DataChannel to Cua Driver's desktop-scope input. A Mac's Cmd shortcuts map to Ctrl on
  Windows. Use the text box for IME / pasted text. Viewer actions are audited as `viewer_*`
  (pointer moves are not).
- Limits: the UAC secure desktop and the lock screen cannot be captured or controlled from
  the user session. `gdigrab` captures the whole virtual desktop, so with several monitors input
  mapping is only right when `ddagrab` (primary display) works. There is no audio and no
  clipboard sync.

## Tools

| Tool                                    | Lease | Notes                                                                                                       |
| --------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------- |
| `computer_list`                         | no    | OS, status, lease holder, display size                                                                      |
| `computer_screenshot`                   | no    | full primary display, long edge `maxImageDimension` (1280)                                                  |
| `computer_cursor_position`              | no    | in screenshot pixels                                                                                        |
| `computer_click`                        | yes   | `{x, y, button?, count?, modifiers?}`                                                                       |
| `computer_move` / `computer_drag`       | yes   | `{x, y}` / `{from, to}`                                                                                     |
| `computer_scroll`                       | yes   | `{x, y, direction, amount?}`                                                                                |
| `computer_type`                         | yes   | `{text}` ≤ 4096 characters, into the frontmost app                                                          |
| `computer_key`                          | yes   | `{keys}` e.g. `["ctrl","s"]`; Windows: Win and Ctrl+Alt+Del refused; macOS: lock/log out/force quit refused |
| `computer_launch`                       | yes   | `{app}` name, or `.exe` path on Windows                                                                     |
| `computer_wait`                         | no    | `{ms}` ≤ 10000, then screenshot                                                                             |
| `computer_acquire` / `computer_release` | —     | explicit lease control                                                                                      |

Coordinates are pixels of the latest screenshot; Cua Driver maps them back to the
screen. Input tools return a screenshot taken `actionSettleMs` after the action.

`--expose-driver-tools` additionally exposes Cua Driver's own tools as `cua_*`
(window-scoped background input, accessibility `element_token`s, `get_window_state`, ...).
Read-only ones skip the lease; the rest need it. Script, config, extension, recording,
process-kill, clipboard, and file-transfer tools are never exposed.

## Safety behavior

- **Control lease**: one client (token name) controls input at a time; others get
  `computer_busy`. The lease is taken on first input, expires after `leaseIdleSeconds`
  (120) idle or `leaseMaxSeconds` (1800), and is freed by `computer_release`.
- **Human first**: pointer movement the agent did not cause blocks input for
  `humanIdleSeconds` (5) with `human_active`. Keyboard activity is not detected yet.
- **Emergency stop**: press `p` in the daemon console, or run `agentconnect-desktop pause`.
  Input then returns `human_in_control` until `r` / `agentconnect-desktop resume`;
  screenshots keep working.
- **No replay**: a timeout, driver crash, or cancellation returns `uncertain` with a fresh
  screenshot. The action is never retried automatically.
- **Audit**: every call is appended to `audit.log` in the data dir; typed text is
  recorded by length only. Screenshots are not stored.

## Register with a Control Plane

In the console, create a Computer registration. It gives you a one-time token and an exchange URL.
Then run this on the desktop:

```
agentconnect-desktop setup --register TOKEN --cp-url URL [--name NAME]
```

This runs the whole `setup` and also exchanges the token for this desktop's Computer key. The key
is stored in `computer-key.json` in the data dir with mode 0600. The keychain or credential
manager comes later. No local client token is minted. `register TOKEN --cp-url URL` does only the
exchange, and you restart the daemon afterwards.

A registered daemon dials the Computer channel and reports its status, capabilities and `doctor`
results there. The design
([computer-use.md §3.6, §8.2](../../docs/designs/computer-use.md#36-registration-and-pairing-design))
describes this. The daemon acts only while it holds a channel key that the Control Plane renews,
and this applies to local-token MCP clients and `/view` too. If it loses the Control Plane, it keeps
working until that key expires (5 minutes by default) and then refuses with `unavailable` until it
reconnects. If the Computer is revoked or deleted, the daemon refuses input, screenshots and
viewers at once. It also forgets the key and stays refused after restarts, until you register it
again. `doctor` shows the registration as the `control plane` check. `stdio` mode has no channel,
so a registered desktop refuses it.

## Commands

```
agentconnect-desktop setup [--client NAME] [--host H] [--port P]   (once, on the desktop: downloads + OS approvals + doctor)
agentconnect-desktop setup --register TOKEN --cp-url URL [--name NAME]   (the same, registered as a Computer)
agentconnect-desktop register TOKEN --cp-url URL [--name NAME]   (only the registration; restart the daemon after)
agentconnect-desktop init [--client NAME] [--host H] [--port P]    (non-interactive part: config + token + driver)
agentconnect-desktop install-ffmpeg                          (Windows; run does it in the background)
agentconnect-desktop run [--host H] [--port P] [--expose-driver-tools] [--rtc-address A] [--rtc-ports MIN-MAX]
agentconnect-desktop stdio [--expose-driver-tools]
agentconnect-desktop token add NAME | token list | token remove NAME
agentconnect-desktop status | pause | resume
agentconnect-desktop doctor [--here] [--json]                       (read-only checks; exit 1 on failure)
agentconnect-desktop service install|uninstall|start|stop|restart|status   (macOS .app LaunchAgent, Linux systemd user unit)
agentconnect-desktop autostart enable | disable | start      (Windows)
```

With the AgentConnect CLI installed, every command also runs as `agentconnect desktop <command>`
(for example `agentconnect desktop doctor`). The CLI runs `AgentConnect Desktop.app` when it is in
`~/Applications` or `/Applications` (macOS), otherwise `app/agentconnect-desktop.mjs` in the data
dir, where the install scripts and the Linux service put it; `AGENTCONNECT_DESKTOP_ENTRY` points it
at a development build instead. See
[cli-daemon-split.md §1.2](../../docs/designs/cli-daemon-split.md#12-desktop-daemon).

Data dir: `%LOCALAPPDATA%\AgentConnect\desktop` on Windows, `~/.agentconnect/desktop`
elsewhere (`AGENTCONNECT_DESKTOP_HOME` overrides). `config.json` also holds
`maxImageDimension`, `leaseIdleSeconds`, `leaseMaxSeconds`, `humanIdleSeconds`,
`actionScreenshot`, `actionSettleMs`, `allowSystemKeys`, `exposeDriverTools`,
`driverPath`, `driverCallTimeoutMs`, `keepAwake`, and the viewer's `webrtc`, `ffmpegPath`, `streamFps`,
`streamMaxWidth`, `streamBitrateKbps`, `rtcAddress`, and `rtcPortRange`.

## Development

```bash
pnpm --filter @agentconnect.md/desktop test # fake driver, no desktop needed
pnpm --filter @agentconnect.md/desktop typecheck
pnpm --filter @agentconnect.md/desktop dev          # tsx src/cli.ts run
pnpm --filter @agentconnect.md/desktop test:xvfb    # bundle, then the Xvfb suite (needs DISPLAY, xterm, xdotool)
pnpm --filter @agentconnect.md/desktop license-scan # scan bundle/ after `bundle` (and `bundle:macos`)
```

CI runs two more jobs on pull requests that touch this package (`.github/workflows/test.yaml`):

- **Desktop (Xvfb)**: `xvfb-run` at 1600x900, then `test/xvfb.test.ts` against the bundled daemon. `init` and
  `install-ffmpeg` download the pinned, sha256-checked Cua Driver and ffmpeg; the suite checks a screenshot, a pointer
  move against X's own pointer, a click plus typing into an `xterm`, a `/view` screenshot frame, and one H.264 keyframe
  received over WebRTC and decoded by ffmpeg.
- **Desktop licenses**: `scripts/license-scan.ts` reads the esbuild metafiles `bundle` and `bundle:macos` write to
  `bundle/.meta/`, attributes every bundled input to its npm package, and fails on AGPL / FSL / BSL (Business Source) /
  SSPL / GPL, on a license missing from its allowlist, on forbidden licenses in the extracted `*.LEGAL.txt`, on
  ffmpeg or Cua Driver inside an artifact, and on any undeclared executable or archive. The macOS app is scanned the
  same way when built (CI builds only the Linux bundle). The Docker image carries Debian packages under their own
  licenses but no ffmpeg, which it downloads on first start while the distribution question of design §11 is open
  with counsel.

macOS and Linux also work for local development (`init` installs the matching driver
build). On macOS, `--direct` attributes Accessibility and Screen Recording to the terminal
that starts the daemon.

## Differences from the design (deliberate for M0)

- One Computer per daemon. Registration and the Computer channel exist, but the data plane,
  `ComputerPolicy` beyond the lease limits, approvals, object-store screenshots and per-agent
  authorization do not, so agents still connect with local client tokens.
- `computer_screenshot` has no `display`, `window`, `region`, or `maxDimension`
  parameters: the image size is fixed per daemon so the driver's capture mapping stays
  consistent. Window-level capture is available through `cua_get_window_state`.
- `computer_scroll` uses Cua Driver's `direction` + `amount` instead of `dx/dy`.
- `computer_*` input uses Cua Driver's desktop scope, which moves the real pointer.
  Background, window-scoped input (design §6) is reachable through the `cua_*` tools.
- No tray icon, screen-border indicator, or global hotkey: the console window and its
  title serve as indicator and stop control.
- The human takeover path is the built-in `/view` page (WebRTC). The design does not specify
  this part.
- Cua Driver runs as a `cua-driver mcp --direct` child process (design open question 2),
  which isolates driver crashes and keeps MCP as the boundary.
