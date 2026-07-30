# Slack Integration Installation and Credential Distribution

**Status:** Implemented

The Control Plane is the durable source of integration metadata and credential
values stored through the configured `SecretCipher`. It distributes only the
credentials and configuration needed by the daemon or relay responsible for
that integration.

This document covers the common integration lifecycle. See
[slack-install-smoothing.md](slack-install-smoothing.md) for automatic Slack app
creation and [shared-bot-relay.md](shared-bot-relay.md) for HTTP Events API
ingress and multi-agent shared bots.

---

## 1. Resource model

A `Bot` is the durable platform identity. An `Integration` installs that bot
for one agent.

- `Bot` stores non-secret identity and transport metadata.
- `BotSecret` stores token material behind `BotSecretStore`.
- `Integration` stores `botId`, `agentId`, organization, platform, name, and
  status; it contains no credential fields.
- Removing an integration frees the bot for reuse.
- A non-shareable bot can have at most one active integration.
- A shareable HTTP bot can have one integration per member agent.
- An integration inherits the visibility of its parent agent.

The schema in `packages/control-plane/prisma/schema.prisma` is authoritative.
Metadata read paths such as `GET /bots` and `GET /integrations` never select
the secret table.

---

## 2. Secret boundary

`PgBotSecretStore` is the only persistence path for bot credentials. Every
value passes through the configured `SecretCipher` before it reaches Postgres
and is opened only when an authorized distribution path needs it.

The repository provides both an identity cipher for local development and a
Vault Transit cipher. Runtime configuration selects the cipher and its
supporting infrastructure.

Plaintext exists only at necessary runtime boundaries:

- during an authenticated create or rotation request;
- in Control Plane memory while sealing or assembling a targeted spec;
- inside a TLS-protected control frame to the authorized daemon or relay; and
- in the receiving process's memory while it connects to the platform.

For daemon-owned integrations, the daemon also persists the received
credential fields in the CP-owned entry in the target agent's local
`agent.json`. This is the same machine trust boundary as a hand-authored local
integration and allows the daemon to reconnect to the platform while the
Control Plane is unavailable. The file must be protected as secret-bearing
state.

Security requirements:

- Never log `BotSecret`, `IntegrationSpec`, `integration/upsert`,
  `register/ok.integrations`, or relay bot-assignment payloads.
- Decoder errors must not include frame bodies.
- DTOs and list/get routes must expose only metadata.
- Secrets sent to a daemon are filtered by daemon ownership.
- Slack signing secrets are sent only to relays that verify HTTP Events API
  requests; daemons do not receive them.
- HTTP-mode daemons receive only the bot token needed for outbound Slack API
  calls, not the app token or signing secret.
- Secret-bearing `agent.json` files must not be copied into diagnostics,
  examples, or source control.

---

## 3. Transport modes

Slack bots have an immutable ingress transport:

| Transport | Inbound owner | Daemon credential set              | Relay credential set                |
| --------- | ------------- | ---------------------------------- | ----------------------------------- |
| `socket`  | Owning daemon | bot token and app-level token      | none                                |
| `http`    | Relay pool    | bot token only, for outbound sends | signing secret and routing metadata |

`shareable` is independent of the transport selector:

- Socket bots are direct and single-agent.
- HTTP bots route inbound events through relays.
- A non-shareable HTTP bot still has one target agent.
- A shareable HTTP bot may fan out to multiple agent integrations.

The Control Plane is not on the message hot path. It distributes control
configuration and metadata but does not receive Slack message bodies.

---

## 4. Installation

The Console can create an integration by reusing an existing bot or by
supplying credentials for a new bot. The target agent must belong to the
organization, be visible to the caller, and be placed on a daemon.

For a new bot:

1. Validate the platform credentials and derive non-secret bot identity
   metadata.
2. Create the `Bot` row.
3. Seal and persist the credentials through `BotSecretStore`.
4. Create the `Integration` row that binds the bot to the agent.
5. Assemble the transport-specific distribution.
6. Push a live update when the target is connected; otherwise rely on its next
   full reconciliation snapshot.

Creation and mutation paths use the agent-mutation gate so a concurrent daemon
move cannot distribute credentials to stale ownership. A placement conflict
returns `409`.

The one-time credential input is never returned by subsequent read APIs.

---

## 5. Direct Socket Mode distribution

For a socket bot, the Control Plane builds an `IntegrationSpec` with:

- `mode = direct`;
- the bot token;
- the app-level token;
- optional bot user id;
- allowed users; and
- effective bind rules.

The spec is sent only to the daemon that owns the integration's agent through:

- live `integration/upsert` events; and
- the daemon-filtered `register/ok.integrations` snapshot.

The daemon's `CpIntegrationRegistry` writes the CP-owned spec into the matching
agent's local `agent.json`, marked with `origin = cp`, and triggers
reconciliation. Routing, tool injection, reply delivery, and Socket Mode
startup all consume that consolidated on-disk view.

Per-channel trigger metadata contributes channel-scoped rules. The defaults
respond to mentions and direct messages; channels configured for “any message”
add an `auto` rule.

---

## 6. HTTP and shared distribution

For an HTTP bot, inbound traffic belongs to the relay path described in
[shared-bot-relay.md](shared-bot-relay.md).

The daemon receives a send-only Slack spec:

- `mode = shared`;
- the bot token;
- no app-level token;
- no signing secret; and
- no inbound bind rules, because the relay has already selected the target.

The relay receives the signing secret and bodiless routing metadata through its
own control protocol. It verifies Slack signatures before parsing and routing
an event.

For a shareable bot, the Control Plane permits multiple integration rows and
maintains channel or thread affinity so an inbound event is delivered to the
selected agent's daemon.

---

## 7. Reconciliation and recovery

`IntegrationRepo.activeForDaemon(daemonId)` is the authoritative filter for
daemon-scoped integration delivery.

On daemon registration:

1. Load active integrations for that daemon.
2. Open each bot secret through `BotSecretStore`.
3. Build a direct or send-only spec from the bot transport.
4. Return the complete desired set in `register/ok.integrations`.
5. Persist each desired CP-owned integration into its agent file.
6. Explicitly drop stale Control Plane replicas that are not in the desired
   set, without deleting hand-authored local integrations.

This snapshot is the recovery backstop when:

- the daemon was offline during a live update;
- a connection was interrupted during mutation; or
- an agent moved between daemons.

A restarted daemon first reconstructs effective integrations from local
`agent.json` and can reconnect platform clients even while the Control Plane is
unavailable. A later snapshot repairs any missed update or ownership change
without asking the operator to enter credentials again.

---

## 8. Update and removal

Configuration changes emit `integration/upsert` to the current owner and are
included in future snapshots.

Removing an integration:

1. Deletes or revokes the integration row according to the route contract.
2. Emits `integration/remove` to the owning daemon.
3. Removes local routing immediately.
4. Closes the platform connection when no active pending work still owns it.
5. Retains the durable `Bot` and stored secret so the bot can be reused, unless
   the operator separately deletes the bot.

A bot cannot be deleted while active integrations reference it.

Agent moves use the mutation gate and transfer the desired integration set from
the old daemon to the new daemon. Reconciliation repairs any missed live event.

---

## 9. Channel metadata

Daemons report the full channel-membership snapshot through
`integration/channels`. The Control Plane stores only:

- channel id;
- optional display name;
- privacy flag;
- configured trigger; and
- optional owning agent for a shared bot.

This is control metadata, not message content. Latest-wins snapshots populate
the Console's per-channel configuration without moving Slack messages into the
Control Plane.

---

## 10. Compatibility

A standalone daemon using hand-authored local integrations remains supported.
Control Plane replicas are overlaid by `integrationId`; reconciliation prunes
only resources proven to be Control Plane-owned.

`IntegrationSpec` is a platform-discriminated union for Slack, Telegram,
Discord, and Lark / Feishu. Each platform receives only the credential fields needed
by its client.

---

## 11. Validation requirements

Tests cover:

- bot and integration ownership and visibility;
- secret-store sealing/opening and metadata-only reads;
- absence of credentials from DTOs and logs;
- CP-owned credential persistence only in the intended local agent file;
- daemon-scoped snapshot filtering;
- direct versus HTTP credential domaining;
- live upsert/remove behavior and reconnect recovery;
- agent-move races;
- classic bot single-install enforcement;
- shareable bot fan-out;
- per-channel trigger projection; and
- platform-specific spec decoding.
