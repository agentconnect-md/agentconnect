# Run a desktop container as a Computer

The `computer` image runs a Linux desktop (Xvfb, a lean Xfce and Firefox ESR) with the desktop daemon in a
container on any server with Docker. It registers with your AgentConnect deployment as a **Computer** that
your agents operate with the `computer_*` tools and that you watch and take over from the console. The console
lists it as kind `self-hosted`, isolation `container`, session `xvfb`. The design is
[computer-use.md §3.8](designs/computer-use.md#38-container-form-docker-implemented).

A desktop container suits work that needs a browser rather than your own machine: it starts in seconds, is
isolated from the server it runs on, and needs no OS permissions. It cannot reach the apps and sessions on your
own desktop; for that, add the desktop itself from **Computers → Add computer**.

## What the server needs

- Docker Engine with Compose v2, Docker Desktop or OrbStack, on `amd64` or `arm64`.
- About 1 GB of disk for the image and up to 1 GB of memory for the desktop. Firefox needs the 1 GB `/dev/shm`
  the examples set.
- **Outbound only.** The container dials out to the deployment and listens on nothing you have to publish:

| Connection                                                  | Purpose                                                                      |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------- |
| HTTPS / WSS to the Control Plane's public URL               | registration, then the Computer channel (status, policy, leases, audit)      |
| WSS to each relay's daemon address                          | agents' tool calls and the console viewer's signaling and screenshots        |
| HTTPS to `github.com`, on the first start                   | the pinned, sha256-checked ffmpeg build for the viewer's video (about 50 MB) |
| UDP or TCP to the TURN server, when the deployment runs one | viewer video when the browser cannot reach the desktop directly              |
| Inbound UDP on a small range, only if you choose it         | viewer video straight from the desktop to the browser                        |

These are the same addresses a daemon uses: `PUBLIC_CP_URL` on the Control Plane and the relay's
`DAEMON_DIAL_URL` (`AGENTCONNECT_PUBLIC_CP_URL` and `AGENTCONNECT_RELAY_DAEMON_URL` in the Compose stack). A
deployment that publishes them as `localhost` is reachable only from its own host; see
[Evaluate on the stack's own host](#evaluate-on-the-stacks-own-host).

## Start it from the console

In the console, open **Computers → Add computer**, give it a name if you like, and switch the
command to the **Docker** tab. Run the command on the server:

```sh
docker run -d --name agentconnect-computer --hostname agentconnect-computer --restart unless-stopped \
  --shm-size=1g -v agentconnect-computer:/home/computer -e LISTEN_HOST=127.0.0.1 \
  -e AGENTCONNECT_CP_URL="https://cp.example.com/v1/computers/register" \
  -e AGENTCONNECT_REGISTER_TOKEN="<one-time token>" ghcr.io/agentconnect-md/computer:v2.6.0
```

The image tag is the release your Control Plane runs (`latest` from a development build), and
`COMPUTER_IMAGE` on the Control Plane names another image or registry. Agents and the console come
through the relay, so the daemon listens on loopback only. The dialog shows the Computer once it is online. The token works once and expires after an hour. The volume
keeps the key the token bought, so keep the volume and the command can run again unchanged.

## Run it with Docker Compose

The Compose file keeps the settings in a file, adds the UDP range for direct video, and makes upgrades one
command. Fetch the example and its settings next to each other:

```sh
mkdir agentconnect-computer && cd agentconnect-computer
base=https://raw.githubusercontent.com/agentconnect-md/agentconnect/main/packages/computer/docker
curl -fsSLO "$base/compose.yaml"
curl -fsSL "$base/compose.env.example" -o .env
```

Create a token in the console as above, then fill in the two required settings in `.env`. Any of the
Control Plane URLs works: the exchange URL the command shows, or the bare public URL.

```sh
AGENTCONNECT_CP_URL=https://cp.example.com
AGENTCONNECT_REGISTER_TOKEN=<one-time token>
```

Start it and check it:

```sh
docker compose up -d
docker compose ps      # STATUS turns (healthy) once the daemon answers its own doctor
docker compose logs -f # "registered as computer …", "computer channel: connected as …", "relay …: attached"
```

The console lists the new Computer as online, with kind `self-hosted · container` and every check passing
once ffmpeg has downloaded, a few seconds after the first start.

| Setting                            | Meaning                                                                                                                |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `AGENTCONNECT_CP_URL`              | the Control Plane, as the console printed it                                                                           |
| `AGENTCONNECT_REGISTER_TOKEN`      | the one-time token; spent on the first start and never printed                                                         |
| `AGENTCONNECT_REGISTER_TOKEN_FILE` | a file holding the token instead (see [Keep the token out of the environment](#keep-the-token-out-of-the-environment)) |
| `AGENTCONNECT_COMPUTER_NAME`       | the name when the console gave none; otherwise the hostname, `AGENTCONNECT_COMPUTER_HOSTNAME`                          |
| `RTC_ADDRESS`                      | the public IP browsers reach this server on, for direct video                                                          |
| `AGENTCONNECT_COMPUTER_RTC_PORTS`  | the UDP range published for direct video, `7700-7709` by default                                                       |
| `AGENTCONNECT_COMPUTER_RESOLUTION` | the screen, `1600x900x24` by default                                                                                   |
| `AGENTCONNECT_COMPUTER_BROWSER`    | the browser kept open and maximized, `firefox-esr`; `none` for none. `BROWSER_URL` is the page it opens                |
| `AGENTCONNECT_COMPUTER_PORT`       | the daemon's own port, on loopback only, `7681` by default                                                             |
| `AGENTCONNECT_VERSION`             | the image tag; pin the version your Control Plane runs                                                                 |

## Let an agent use it

A new Computer belongs to whoever created its token, and no agent may use it until that owner says so:

1. On the Computer's page, add the agent under the policy's allowed agents. The policy also sets view or
   control, which actions ask for approval in the chat first, and the lease limits.
2. On the agent's **Tools** tab, turn on computer use and pick the Computer.

The agent's next session has the `computer_*` tools. `computer_list` reports the Computer with
`isolation: "container"` and `session: "xvfb"`, and Firefox is already open and maximized on it. The page's
activity lists what agents did, and a console **Stop** refuses every agent until you resume.

## Watch it from the console

**Watch** on the Computer's page opens the viewer. Its signaling, input and screenshots go from the browser
through a relay to the desktop's outbound link, so watching needs nothing published. The video takes the first
path that connects, and the badge names it:

1. **Direct.** The browser receives the video straight from the server over UDP. Set `RTC_ADDRESS` to the
   server's public IP and allow the UDP range (`7700-7709`, two ports per viewer) through its firewall. The
   Compose file publishes the range; with `docker run`, add `-p 7700-7709:7700-7709/udp -e RTC_PORTS=7700-7709
-e RTC_ADDRESS=<ip>`. Without `RTC_ADDRESS` the desktop offers its container address, which no browser
   outside the server reaches.

   When the relay runs STUN ([below](#run-stun-on-the-relay)) and the Computer's policy allows peer-to-peer
   viewing, this step is full ICE instead: both ends also learn their public address from the relay and
   hole-punch through their NATs, so the badge reads **Peer to peer** and the desktop needs nothing published.
   A peer-to-peer session that settles on a same-network pair still reads **Direct**.

2. **TURN relay.** When the first step does not connect within 6 s (8 s for peer to peer), both ends relay
   the video through the deployment's TURN server, if it runs one: the relay's own
   ([below](#run-turn-on-the-relay)) or an external coturn ([below](#run-an-external-turn-server-instead)), over
   UDP, or TCP and TLS where UDP is blocked. The desktop needs nothing published for this. A managed computer,
   whose pod has no UDP a browser can reach, starts here.
3. **Screenshots.** With neither, the page polls screenshots through the relay, about 5 frames a second.

Take control and Release work the same on every path: while you hold control, agents get
`human_in_control`.

### Run STUN on the relay

With STUN, video goes peer to peer between the browser and a desktop behind NAT, and the relay only helps them
find each other: it answers each peer's Binding request with the address it came from, keeps no state and never
sees the video. Hole punching usually fails when a side is behind a symmetric NAT (many carrier and corporate
networks); the viewer then moves on to TURN. The Compose stack ships `compose.stun.yaml`. Set these in
`compose.env`:

```sh
AGENTCONNECT_STUN_HOST=203.0.113.10 # the IP or DNS name browsers and desktops reach this host on
# AGENTCONNECT_STUN_PORT=3479       # the public UDP port; 3478 is left to compose.turn.yaml
```

```sh
docker compose --env-file compose.env -f compose.yaml -f compose.stun.yaml up -d
```

Open that UDP port on the host. The relay registers the address with the Control Plane, which names it in each
viewer grant. Peer to peer shows the desktop's public IP to the viewer's browser, so a Computer's policy decides
it: **Peer-to-peer viewing** is on by default while only the owner may watch, and off once other members may,
unless the owner turns it on. In the Helm chart, `relay.stun` does the same with one UDP Service per relay pod.

### Run TURN on the relay

TURN serves every desktop of the deployment that browsers cannot reach directly: containers behind NAT, desktops
without `RTC_ADDRESS`, symmetric NATs that defeat hole punching, and networks that drop UDP. The relay can be that
server, so the deployment needs no separate coturn. The Compose stack ships `compose.relay-turn.yaml`. Set these
in `compose.env`:

```sh
AGENTCONNECT_RELAY_TURN_HOST=203.0.113.10 # the IP or DNS name browsers and desktops reach this host on
# AGENTCONNECT_RELAY_TURN_PORT=3480       # the public UDP and TCP port
```

```sh
docker compose --env-file compose.env -f compose.yaml -f compose.relay-turn.yaml up -d
```

Open that port for UDP and TCP on the host; nothing else. Both ends of a viewing are relay-only, so the relay
forwards video only between its own allocations: their relayed addresses are virtual, no port range is opened,
and the relay never sends to any other address. The relay registers its `turn:` URLs with the Control Plane,
which mints credentials per viewer and per desktop (`<expiry>:viewer-<user>`, `<expiry>:computer-<id>`, valid for
`COMPUTER_TURN_TTL_SEC`, 6 h by default) and hands the relay the secret it checks them with over the relay's
authenticated link; there is no secret to set, and an expired credential can neither open nor refresh an
allocation. Each allocation sends at most `RELAY_TURN_MAX_BPS` (10 Mbps) and is deleted after
`RELAY_TURN_IDLE_TIMEOUT_SEC` (120 s) without traffic; a relay holds at most `RELAY_TURN_MAX_ALLOCATIONS` (400).
The relay logs the bytes each allocation relayed when it ends, and exports `agentconnect.relay.turn.relayed_bytes`
per Computer when OpenTelemetry metrics are on.

For networks that let only 443 out, serve TURN over TLS as well: mount a certificate for the TURN host into the
relay, set `RELAY_TURN_TLS_PORT`, `RELAY_TURN_TLS_CERT_FILE` and `RELAY_TURN_TLS_KEY_FILE`, publish the TLS port
on 443 of an address whose 443 is free, and add `turns:<host>:443?transport=tcp` to `RELAY_TURN_URLS`. In the Helm
chart, `relay.turn` does all of this with one Service per relay pod and `relay.turn.tls.secretName`.

### Run an external TURN server instead

An external coturn is the alternative, and takes precedence over the relay's TURN when both are configured. The
Compose stack ships `compose.turn.yaml`, which adds coturn and points the Control Plane at it. Set these in the
stack's `compose.env`:

```sh
AGENTCONNECT_TURN_SECRET=<openssl rand -hex 32>  # letters and digits only
AGENTCONNECT_TURN_EXTERNAL_IP=203.0.113.10       # the IP browsers and desktops reach this host on
# AGENTCONNECT_TURN_HOST=turn.example.com        # a DNS name for the TURN URLs instead
```

```sh
docker compose --env-file compose.env -f compose.yaml -f compose.turn.yaml up -d
```

Open UDP and TCP `3478` and UDP `49160-49199` on that host. Each viewing takes a few relay ports, so widen
`AGENTCONNECT_TURN_MIN_PORT` / `AGENTCONNECT_TURN_MAX_PORT` for many viewers at once. The Control Plane mints
credentials per viewer and per desktop from the shared secret (`COMPUTER_TURN_URLS`, `COMPUTER_TURN_SECRET`,
`COMPUTER_TURN_TTL_SEC`; one viewing lasts at most the TTL, 6 h by default) and never sends the secret out.
Because both ends always relay, the overlay refuses TCP relays and lets coturn send UDP only to
`AGENTCONNECT_TURN_EXTERNAL_IP` and its own container, so the TURN server cannot reach the rest of your network.
coturn cannot limit that allowance by port: anyone holding minted credentials can send UDP to any port on the
external IP, from the host itself. Run no other UDP service on that address, or have the host firewall drop UDP
from the coturn container to ports outside the relay range. The Helm chart sets the same three variables from
`computerViewer.turn`.

Without a host to run coturn on, use [Cloudflare Realtime TURN](https://developers.cloudflare.com/realtime/turn/)
instead: create a TURN key in Cloudflare and set `COMPUTER_TURN_CLOUDFLARE_KEY_ID` and
`COMPUTER_TURN_CLOUDFLARE_API_TOKEN` (and no `COMPUTER_TURN_URLS`) in `compose.env`, without `compose.turn.yaml`. The
Control Plane asks Cloudflare for each viewer's and desktop's credentials, and Cloudflare bills the relayed traffic.

## Keep the token out of the environment

`docker inspect` shows a container's environment, so a token passed as `AGENTCONNECT_REGISTER_TOKEN` stays
visible there after it is spent. It is useless by then, but a secret file avoids it. Uncomment the two
`secrets:` blocks in `compose.yaml`, and in `.env` replace the token with its path:

```sh
printf '%s' '<one-time token>' > register-token
sudo chown 1000 register-token && chmod 600 register-token # the image's user `computer` is uid 1000
```

```sh
AGENTCONNECT_REGISTER_TOKEN_FILE=/run/secrets/register-token
```

Either way the entrypoint hands the token to the daemon alone, and the daemon drops it before starting the
session, the browser or anything an agent launches. No log line names it.

## Operate it

- **Upgrade.** Set `AGENTCONNECT_VERSION`, then `docker compose pull && docker compose up -d`. The key, the
  browser profile and the audit log stay in the volume.
- **Restart.** `docker compose restart`. A started desktop keeps its key; the token is not spent again.
- **Revoke.** Revoke or delete the Computer in the console. The desktop refuses input, screenshots and viewers at
  once, forgets its key, and keeps running revoked instead of restarting in a loop; its health check fails.
- **Register again.** Create a new token, put it in `.env` and run `docker compose up -d`. A different token is
  spent and replaces the stored key.
- **Remove.** Delete the Computer in the console, then `docker compose down -v`. Removing the volume removes the
  key, so a removed desktop cannot come back by itself.
- **Several desktops on one server.** Give each its own directory: the Compose project, and so the volume, takes
  the directory's name. Each also needs its own token and its own `AGENTCONNECT_COMPUTER_RTC_PORTS` range.
- **Diagnose.** `docker compose exec computer sh -c 'agentconnect-computer doctor --port "$PORT"'` runs the checks
  the console shows.

## Evaluate on the stack's own host

The evaluation stack in `compose.yaml` publishes its URLs as `localhost`, which inside a container means the
container itself. To run a desktop on the same machine against it, give the desktop the host's network:
uncomment `network_mode: host` in `compose.yaml` and remove its `ports:` block, then use
`AGENTCONNECT_CP_URL=http://localhost:8080`. The daemon then listens on the host's loopback, so set
`AGENTCONNECT_COMPUTER_PORT` when `7681` is taken there (a desktop daemon of your own uses it), and give it a UDP
range nothing else uses. This works with Docker Engine on Linux, where the video is then direct, and with
OrbStack; Docker Desktop needs host networking turned on in its settings. For a desktop on another machine,
publish the stack under an address that machine reaches, as in [self-host-caddy-https.md](self-host-caddy-https.md).
