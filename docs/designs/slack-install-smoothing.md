# Streamlined Slack Installation

**Status:** Implemented

The automatic Slack installation funnel creates an app from a manifest,
completes OAuth server-side, and turns the result into a durable `Bot` plus
`Integration`. The browser never receives the OAuth-obtained bot token.

This flow complements the manual credential path described in
[slack-integration-install.md](slack-integration-install.md). HTTP Events API
ingress and shared-bot routing are described in
[shared-bot-relay.md](shared-bot-relay.md).

---

## 1. User configuration

Automatic installation uses a Slack App Configuration token owned by the user
who starts the install. The token is scoped by organization and user because
the created Slack app belongs to that person.

The organization-scoped routes are:

| Endpoint               | Behavior                                                   |
| ---------------------- | ---------------------------------------------------------- |
| `GET /slack/config`    | Returns availability and timestamps only.                  |
| `PUT /slack/config`    | Validates, normalizes, and stores the caller's token pair. |
| `DELETE /slack/config` | Removes the caller's stored configuration.                 |

No read response returns either the access token or refresh token.

`PgSlackUserConfigStore` seals every token through `SecretCipher`. The
repository supports multiple cipher implementations; runtime configuration
selects which one is active.

Slack configuration access tokens are short-lived. Before creating an app, the
Control Plane rotates a stored token when it is close to expiry and persists
the replacement pair. Because refresh rotation is single-use, a failed rotate
reloads the row once in case another request already rotated and saved a fresh
pair.

---

## 2. Availability and mode selection

Automatic installation is available only when:

- the Slack configuration API is enabled;
- the caller has stored a valid App Configuration token; and
- a public HTTPS Control Plane callback base is configured.

`GET /slack/config` reports this as metadata such as `configured`,
`funnelEnabled`, and `autoAvailable`.

HTTP-mode installation additionally requires:

- a configured public relay base; and
- at least one connected relay able to receive Slack Events API requests.

The Console chooses one available path:

- automatic installation when `autoAvailable` is true;
- otherwise the manual credential flow.

It never renders stored secret values.

---

## 3. Start the installation

`POST /integrations/slack/app` accepts:

```ts
{
  agentId: string
  name?: string
  transport?: 'socket' | 'http'
}
```

The route:

1. Verifies the caller can edit the target agent.
2. Requires the agent to be placed on a daemon that supports Slack.
3. Resolves a usable configuration access token for the caller.
4. Builds a server-owned manifest; clients cannot supply redirect URLs.
5. Calls Slack's manifest API to create the app.
6. Creates a random pending-install id used as OAuth `state`.
7. Seals the app client secret and any signing secret into a short-lived
   `slack_install` row.
8. Returns the install id, non-secret app id, OAuth URL, and transport.

For socket transport, the manifest enables the daemon-owned Socket Mode path.
For HTTP transport, it sets the relay Events API URL and requires Slack to
return a signing secret at app creation.

The response contains no bot token, client secret, signing secret, or
configuration token.

---

## 4. OAuth callback

Slack redirects to the public API callback:

```text
/v1/integrations/slack/oauth/callback
```

The route is intentionally outside organization-scoped authentication because
Slack's browser redirect does not carry the Console bearer token. Authorization
comes from the unguessable pending-install id in `state`.

The callback:

1. Rejects missing, denied, unknown, expired, or already-finalized state.
2. Loads the sealed client credentials from the pending row.
3. Exchanges the OAuth code server-side.
4. Seals the resulting bot token into the same pending row.
5. Returns a small self-closing page with no credential in the URL or HTML.

The Console polls the pending status. The callback never redirects
with a token and never sends token material to browser JavaScript.

---

## 5. Polling

`GET /integrations/slack/app/:id` returns only:

```ts
{
  installId: string
  appId: string
  status: 'awaiting_oauth' | 'bot_ready'
  transport: 'socket' | 'http'
}
```

`bot_ready` means the server-side OAuth exchange stored the bot token. The
endpoint never returns the token or pending client credentials.

---

## 6. Finalization

`POST /integrations/slack/app/:id/finalize` completes the install.

For socket transport:

- `appToken` is required because Slack does not expose a public API for minting
  an app-level Socket Mode token;
- the app id encoded by the token must match the created app; and
- the token is validated before persistence.

For HTTP transport:

- no app-level token is required;
- the signing secret captured during app creation is mandatory; and
- `shareable` may opt the bot into multi-agent routing.

Before writing durable resources, finalization rechecks:

- the pending row belongs to the caller's organization;
- OAuth has completed;
- the caller can still edit the agent;
- the agent is still placed on a compatible daemon; and
- an agent move is not in progress.

The mutation gate is acquired and placement is re-read after external
validation, preventing credentials from being distributed to stale ownership.

On success, `installNewSlackBot`:

1. Creates the durable `Bot`.
2. Seals credentials through `BotSecretStore`.
3. Creates the `Integration`.
4. Distributes transport-specific configuration.
5. Deletes the pending row so no intermediate copy remains.

The response is an `IntegrationDto` containing metadata only.

---

## 7. Pending-install storage

`slack_install` is a short-lived bridge between app creation, OAuth, and
finalization. It contains:

- random install id and organization/agent references;
- non-secret Slack app and client ids;
- sealed client secret;
- optional sealed bot token;
- transport;
- optional sealed signing secret;
- optional display name and creator; and
- creation time.

`PgSlackInstallStore` is the only persistence path. `clientSecret`,
`botToken`, and `signingSecret` pass through `SecretCipher`, are never returned
in DTOs, and must never be logged.

Successful finalization deletes the row. A reaper removes abandoned rows after
the configured short retention window.

---

## 8. Manifest ownership

The server builds the complete manifest so a caller cannot inject an
untrusted OAuth redirect or Events API endpoint.

The generated manifest includes:

- requested Slack scopes and events;
- the configured public OAuth callback;
- the selected ingress transport;
- the server-derived Events API URL for HTTP transport; and
- non-secret app presentation metadata.

The manifest generator reads interface endpoints from runtime configuration; it
does not hard-code infrastructure addresses or routing topology.

---

## 9. Failure handling

The API returns explicit failures for:

- absent or invalid stored configuration;
- Slack API unavailability;
- Slack manifest rejection;
- missing relay capacity for HTTP mode;
- missing signing secret for HTTP mode;
- OAuth denial or expired state;
- OAuth not yet complete;
- app-level token mismatch or rejection;
- deleted, moved, unplaced, or unsupported agents; and
- concurrent agent mutation.

No failure response includes secret values. Logs may include the pending
install id and a normalized error code, but not Slack tokens, OAuth codes,
client secrets, signing secrets, or token-bearing upstream responses.

---

## 10. Security invariants

- Bot tokens obtained from OAuth remain server-side.
- The OAuth callback uses unguessable, single-purpose state.
- Redirect URLs and relay request URLs are server-controlled.
- Pending and durable credentials pass through the common secret-cipher seam.
- Secret-bearing rows are not joined into metadata list/read APIs.
- Socket daemons receive bot and app-level tokens but no signing secret.
- HTTP daemons receive only the bot token needed for outbound sends.
- Relays receive the signing secret needed for inbound HMAC verification but
  not unrelated bot credentials.
- Token-bearing control frames and snapshots are never logged.
- Pending credential copies are deleted after finalization or expiry.

---

## 11. Validation requirements

Tests cover:

- configuration-token storage without secret readback;
- refresh rotation and concurrent-rotation recovery;
- automatic/manual availability;
- agent visibility, placement, capability, and mutation gates;
- server-owned callback and Events API URLs;
- state validation and server-side OAuth exchange;
- metadata-only polling;
- socket app-token validation;
- HTTP signing-secret and connected-relay requirements;
- secret sealing in pending and durable stores;
- pending-row deletion and reaping; and
- absence of credentials from DTOs and logs.
