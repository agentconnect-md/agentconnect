# OAuth-authorized MCP providers

**Status**: P1 implemented
**Scope**: control-plane + relay + web
**Depends on**: [centralized-tool-management.md](centralized-tool-management.md)

> **Architecture**: the **CP is the OAuth client**. It runs the authorization funnel in the
> console, holds the grant sealed in Postgres, refreshes it, and projects the **current
> access token** as the upstream `Authorization` header the relay injects. The daemon and
> the agent are untouched: they still see only
> `https://<relay>/mcp/<providerId>` and a grant key, and those never change when the
> token rotates.
>
> The alternative — letting the agent's MCP client do OAuth against the proxy URL — is not
> merely harder, it is incoherent with the proxy model. The relay strips the caller's
> `Authorization` (that slot carries the grant key), the agent runs in a daemon with no
> browser, and the upstream's identity is exactly what the proxy exists to hide. §7 records
> the failure mode that was already reachable before this change.

## 1. Background

A custom MCP provider was `url` + a set of static headers: enough for an API-key server,
useless for one implementing
[MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization).
Such a server answers an unauthenticated call with
`401 WWW-Authenticate: Bearer resource_metadata="…"` and requires a full OAuth 2.1
authorization-code exchange before it will answer anything.

Nothing in the repository was an outbound OAuth client. `http/oauth/*` is the CP acting as
an authorization **server** for inbound MCP clients; the open-connector integration
delegates OAuth wholesale to an external service. So the capability had to be built, and
the only two questions that mattered were where the grant lives and who refreshes it.

## 2. Goals / Non-goals

**Goals.** Let an organization add an OAuth-protected MCP server from the console with no
manual client registration. Keep the existing invariant that upstream credentials are
stored only by the CP and used only by relays. Change nothing on the daemon. Survive token
rotation without disturbing any agent's provider selection.

**Non-goals (P1).** Client ID Metadata Documents — the spec's new preferred registration,
but deployed authorization servers supporting it are still rare; the selection order in
`mcp-oauth/registration.ts` has the slot for it. Per-user and per-agent upstream identities
(one org-level connection, consistent with centralized-tool-management.md §10). Runtime
step-up on `403 insufficient_scope`. A reverse channel letting the relay report an upstream
401 to the CP. Non-Streamable-HTTP upstreams. Several authorization servers per provider.
CP replicas > 1 (§8).

## 3. The shape

```
console “Connect”
  └─ POST /api/v1/orgs/:orgId/mcp-providers/:id/oauth/start      (authenticated, canEdit)
       ├─ probe the upstream → WWW-Authenticate / .well-known protected-resource metadata
       ├─ protected-resource metadata → authorization-server metadata (validated issuer)
       ├─ client identity: operator-supplied, else RFC 7591 dynamic registration
       └─ record it + a one-shot state row (sealed PKCE verifier, recorded issuer)
          → returns <PUBLIC_CP_URL>/v1/mcp-providers/oauth/begin?state=…   (popup)
  └─ GET /v1/mcp-providers/oauth/begin        (unauthenticated, top-level navigation)
       └─ stamp the browser-binding cookie once → 302 to the authorization endpoint
          (PKCE S256, state, scope, resource)
  └─ GET /v1/mcp-providers/oauth/callback     (unauthenticated)
       ├─ consume the state once; require the same browser; validate RFC 9207 `iss`
       ├─ redeem the code (verifier + resource); refuse a grant with no refresh token
       ├─ commit status + expiry + sealed pair in ONE transaction
       └─ push rc/mcp-assign carrying `Authorization: Bearer <access token>`
          → 302 back to the console with ?mcpOauth=<outcome>

thereafter: McpOauthRefresher renews before expiry → CAS commit → re-push rc/mcp-assign
```

## 4. Discovery (`mcp-oauth/discovery.ts`)

Three steps, each a spec MUST, each a place where being slightly wrong fails much later.

1. **Probe** the MCP endpoint with an unauthenticated `initialize` **POST**. A GET misses
   most servers. The challenge's `scope`, when present, is authoritative for this resource.
2. **Protected-resource metadata** from the challenge's `resource_metadata`, else the
   well-known fallback in the spec's order (path-inserted, then root).
3. **Authorization-server metadata** by the spec's exact URL priority — path-inserted RFC
   8414, path-inserted OIDC, path-appended OIDC for an issuer with a path; the first two
   otherwise — and the document's `issuer` must be **byte-identical** to the issuer the URL
   was built from, or it is rejected outright rather than retried.

### 4.1 `resource` canonicalization cuts both ways

This is the easiest thing in the feature to get backwards.

- **Outbound** (the RFC 8707 `resource` parameter on both the authorization and the token
  request): send the protected-resource document's own string, byte for byte. The
  authorization server matches the string it published.
- **Inbound** (deciding whether a document describes the URL the operator registered):
  accept a resource that **covers** the registered URL — the URL itself ignoring a single
  trailing slash, or a same-scheme, same-host prefix of it at a path-segment boundary (the
  origin, or a parent path). Hosted servers commonly publish the origin as their resource
  identifier while serving the endpoint under `/mcp` (Front: `https://mcp.frontapp.com` for
  `https://mcp.frontapp.com/mcp`). Covering is an interoperability choice, not something RFC
  9728 prescribes — §3.1 only defines how the well-known URL is built from the resource
  identifier. Another host, scheme or port, a sibling path, or a
  resource carrying a query is still `resource_mismatch` (`resourceCovers` in
  `mcp-oauth/discovery.ts`). The outbound `resource` is then the advertised string, which is
  the audience the server verifies.

A strict inbound comparison means a server publishing `https://mcp.example.test/mcp/`
against an operator who typed it without the slash never connects — and a
re-canonicalized outbound value means authorization completes and the token is then never
accepted. `http/oauth/base.ts` records the same trap from the resource-server side.

The published string is stored in its own column, separate from `McpProvider.url`.

## 5. Client registration (`mcp-oauth/registration.ts`)

Operator-supplied credentials win when present — someone who registered an app means it,
and pre-registration is the only mechanism every authorization server supports. Otherwise
RFC 7591 dynamic registration, with `application_type: "web"` stated explicitly and
`refresh_token` in `grant_types`.

A client identity belongs to the authorization server that issued it. When
protected-resource metadata later names a **different** issuer, the stored credentials are
not reusable and the funnel re-registers rather than retrying — the spec's
authorization-server binding rule. Re-preparing a provider advances its `tokenVersion`, so
any refresh already in flight against the old identity loses its CAS.

## 6. Custody (`mcp-oauth/token-service.ts`, `persistence/repositories/mcp-oauth.repo.ts`)

The `LinearTokenService` / `GitlabConnection` shape, because the hazard is the same:
refreshing may rotate the refresh token, and a rotated refresh token spent twice leaves the
organization holding a credential the server has already invalidated.

- **Single-flight per provider** collapses concurrent callers into one upstream refresh.
- **A database lease plus a `tokenVersion` CAS** elects the one durable writer. The
  in-process flight is not enough: a refresh token outlives the process.
- **Persist before reply.** The rotated pair is durable before any caller sees it.
- Every write that publishes a pair commits it in the same transaction as the version it
  was minted against; every write that changes user intent advances that version.
- A **lost CAS** takes the peer's write. A **definitive refusal** (4xx) means the grant is
  dead: `reauth_required`, repairable only by re-authorizing. An **unreachable**
  authorization server or a 5xx means we learned nothing, and the status is left alone — a
  blip is not proof a grant is dead.
- The **refresh margin scales with the token's own lifetime** (half of it, floored at a
  minute). A fixed skew tuned for a two-hour token is useless for a five-minute one, and
  short-lived tokens are common among MCP servers.

The callback commit is **fenced on the generation the funnel started at**, exactly like a
refresh. A token exchange takes real time, and a disconnect or a second authorization attempt
can complete inside it; without the fence, a late response would resurrect a grant the operator
had just revoked or replaced. `prepare` and `disconnect` both advance that generation, and the
state row records the one its funnel owns.

The retained refresh token is **re-sealed**, not written back as read. The secret store opens
everything it returns, so a server that declines to rotate hands back a plaintext value; writing
it straight through would silently strip its at-rest encryption on the first such refresh.

A grant arriving with **no refresh token is refused** at the callback rather than stored. It
would work for an hour and then fail with nothing able to repair it, and the operator would
have no way to distinguish that from the server being down.

## 7. Relay: containing an upstream auth failure

The MCP proxy relayed an upstream `401` verbatim — `www-authenticate` was never in
`STRIP_RESPONSE_HEADERS`. That hands the agent's MCP client the **upstream's** RFC 9728
challenge, so a spec-conformant client runs the upstream's discovery against the proxy URL:
it learns the upstream identity the proxy exists to hide, blocks on a browser authorization
it cannot perform, and any token it did obtain would be stripped by the proxy's own
`Authorization` replacement — taking the grant key with it and killing the provider for that
session. This was already reachable with a wrong API key on a `headers` provider.

An upstream `401`/`403` is now **contained** the same way an upstream 3xx already was:
`www-authenticate` and `proxy-authenticate` are stripped and the caller gets an opaque
`502 upstream authorization failed`. The injected credential is the binding's, so a
rejection is the CP's to repair and never the caller's. The relay's own grant-key 401s stay
401, so the two remain distinguishable. That is the **only** relay change this feature
needs.

## 8. Projection, ordering, and the honest cost

A relay binding changes only when the CP pushes it, so `auth: oauth2` works exactly to the
extent that the CP keeps pushing.

**One resolver** (`orchestrator/mcpUpstreamHeaders.ts`) decides a provider's injected
headers, so neither the live push nor the replay knows about OAuth.

**Replay is cached-only.** `replayMcpTo` is awaited inside relay registration; resolving with
the network enabled would turn one relay reconnect into N serial round-trips to third-party
authorization servers and couple relay convergence to their availability.

**The refresher refreshes outside the provider's serialization chain and pushes inside it**,
re-reading the provider row and its active grants there. A push that skips the chain can
land after a concurrent `DELETE` and **resurrect a binding for a provider that no longer
exists** — callable pool-wide, holding a live grant hash, with nothing left that would ever
unassign it. That is a revocation bypass, not a cosmetic ordering problem. The chain moved
to `http/provider-chain.ts` for this second consumer.

The sweep selects a **candidate window** and then applies the same `refreshDue` predicate the
resolve path uses. Selecting only already-expired rows would renew strictly too late — every
provider would serve 502s from expiry until the next sweep and exchange finished — and the
margin is per-token, so it cannot be expressed as one SQL bound.

**Every** live publication resolves the injected header through that one resolver, not just
replay and the refresher. A grant rotation or a `PATCH` that read the static header set would
republish an OAuth provider's binding with no `Authorization` at all; an unauthorized provider
publishes its daemon definition and **no** binding, because a binding with an empty credential
is worse than none.

**Disconnect runs inside the chain too**, both halves as one critical section. A refresher
rebind re-reads the provider inside that chain; with the disconnect outside it, a rebind that
had already read a live credential could publish its binding after the unbind, leaving a
callable binding for a grant the database has revoked.

**Disconnect drops the relay binding only.** The daemon definition is the agent-facing proxy url
and grant key, neither of which a disconnect changes — and since a later reconnect republishes
only the binding, removing the definition would leave every enabling daemon without the server
until some unrelated definition sync happened to run.

A refresh re-pushes the **relay binding only**, carrying **every** active grant hash.
Re-pushing the daemon def would be churn (the proxy URL and grant key do not change), and
pushing only the current grant would retire the other one inside a rotation's grace window.

**The cost, stated plainly.** While the CP is up, an OAuth provider never serves an expired
token. While the CP is **down**, one expires after its remaining lifetime and calls start
failing — as a clean 502, per §7. `headers` providers are unaffected. This is a real
narrowing of the graceful-degradation guarantee and it is the price of holding the grant in
the CP. The reverse channel that would close it (the relay reporting an upstream 401 so the
CP force-refreshes) needs a new R→C frame, a feature-negotiation bit, and a defence against
a looping relay; `linearcred/request` is the precedent when it is built.

`controlPlane.replicas` is 1, so the in-process chain is sufficient today. The **token**
single-writer is durable regardless, because a refresh token is a cross-restart resource.

## 9. Console

An authentication choice on the create dialog. Choosing OAuth hides the header editor
(there is no credential to type) and goes straight into the authorization popup after
creating, because an unconnected `oauth2` provider is a tile that silently does nothing. An
existing OAuth app can be supplied through an Advanced disclosure.

A tile shows **Not connected** or **Reconnect needed** and offers the action inline: whether
a provider can reach its upstream at all is the one thing a reader must not have to open a
dialog to discover. Editing an OAuth provider edits its **connection** — Reconnect re-runs
the funnel, Disconnect drops the grant while leaving the provider and its grant key in
place, so no agent has to re-select it.

## 10. Security

- Access tokens, refresh tokens, client secrets and PKCE verifiers all pass through
  `SecretCipher` under `orgScope(orgId)`, live in a side-table no DTO read can reach, and
  are never logged.
- CP egress is now a thing that exists, so it is guarded: every outbound call (probe,
  protected-resource metadata, authorization-server metadata, registration, token, refresh)
  refuses a name resolving to any non-public address, pins the socket to the address it
  validated, and never follows a redirect. `CP_ALLOWED_OUTBOUND_HOSTS` is the CP's own
  permission and is deliberately **not** the relay's `RELAY_MCP_ALLOWED_UPSTREAMS`.
- `begin` and `callback` are unauthenticated by necessity, and defended by a once-only state
  row, a browser-binding cookie stamped exactly once, and a `returnPath` restricted to local
  console paths.
- RFC 9207 `iss` validation is byte-exact and gates **error** responses too, so a mismatched
  error is never displayed or acted on.
- `PUBLIC_CP_URL` is required rather than derived from request headers: the `redirect_uri`
  is registered with the authorization server once and cannot change afterwards. The
  begin/callback plugin therefore mounts at both `/api/v1` and the public `/v1`.
- Failures surface as a closed set of reason codes that never carry a host or a secret.

## 11. Tests

`test:unit` covers `WWW-Authenticate` parsing (quoted commas, several challenges), the
well-known fallback order, the five authorization-server metadata URLs in priority order,
byte-exact issuer validation, scope selection, the RFC 9207 truth table in full, the token
endpoint's refusal-versus-unreachable split, single-flight, lost-CAS, lease hand-off, the
refresh margin, the three-hop funnel with its refusals, and the refresher's push discipline.
`test:int` covers the repo's transactions against real Postgres: the CAS, the lease,
the org fence through the parent provider, and once-only state binding and consumption.
`packages/relay` covers the §7 containment.
