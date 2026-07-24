# Icon uploads (agent + org)

Status: implemented.

## Goal

1. **Agent icon** can be a user-**uploaded image**. Drop the two weak picker options:
   the **runtime mark** and the **paste-an-external-URL** input. The picker becomes:
   _glyph + color plate_ (the create-time random default) **or** _uploaded image_.
2. **Org** gains an icon too, and it can be uploaded the same way (full picker reuse).
3. Decide **where the uploaded bytes live**. ← the crux of this doc.

## Storage: a neutral S3-compatible object store (config-gated)

This document defines the **application contract**. The object store, bucket,
public origin, and credentials are operator-supplied runtime configuration; the
CP has no blob store of its own to fall back on. The contract here is:

- **A neutral S3-compatible store.** The CP speaks the plain S3 REST subset
  (`PutObject` / `DeleteObject`, SigV4 via `aws4fetch`), so any S3-compatible backend
  (a cloud object store in prod, a local one in dev/CI) works by pointing `S3_ENDPOINT` at
  it. Nothing is vendor-bound.
- **Config-gated / opt-in.** The store is assembled only when the full `S3_*` group is
  present; **absent ⇒ the upload routes aren't mounted and the console hides the Upload
  button** (icons stay glyph-only — i.e. today's behavior). This mirrors how every other
  optional CP capability is wired (OIDC / GitHub App / relay). The gate is deliberately
  **forgiving, not fail-fast**: secret keys and non-secret config may roll out
  independently, so a partial group leaves the feature off rather than crash-looping the CP.

### Why an object store, not the CP DB

An agent/org **display icon is control-plane configuration metadata**, authored in the
console, in the same category as the org name or the agent `displayName`. It never touches
a conversation, so where its bytes live is orthogonal to the "CP is never on the message
hot path" principle. Served image bytes belong in an object store rather than on the CP's
one Postgres connection; the cost is one dependency (`aws4fetch`) and a local S3 for dev/CI.

## Config (`S3_*`, all neutral names)

```
S3_ENDPOINT           full S3 API origin (a host, NOT an account id)
S3_ACCESS_KEY_ID      secret
S3_SECRET_ACCESS_KEY  secret
S3_BUCKET
S3_PUBLIC_BASE_URL    the origin objects are served from (a custom domain / CDN)
S3_REGION             "auto" for stores that ignore region (default)
```

The non-secret values and the two secret keys are supplied through runtime
configuration. Objects are stored under an `icon/` prefix:
`icon/agents/<id>`, `icon/orgs/<id>`.

## Failure consistency (object store ↔ DB descriptor)

The blob write and the owner-row `icon` update are two systems, so ordering is chosen so a
transient failure **never leaves a broken avatar** — at worst an orphaned object, which the
next upload to the same (stable) key overwrites:

- **Upload (PUT):** write the object **first**, then flip the descriptor to `{kind:'image'}`.
  - store OK, DB fails → descriptor unchanged (still the old glyph); the fresh object is
    orphaned but harmless. The user keeps a working icon; a retry re-runs cleanly.
  - store fails → return the error before any DB write; nothing changed.
- **Delete (DELETE):** flip the descriptor to a fresh glyph **first**, then best-effort
  delete the object.
  - DB OK, store delete fails → descriptor already renders the glyph; the object is
    orphaned (never referenced) and logged, not fatal.
- **Idempotent / overwrite:** the key is stable per owner (`icon/agents/<id>`), so a PUT
  overwrites in place and a repeated PUT/DELETE converges — no per-upload keys to leak.
- Orphaned objects are bounded (≤1 stale object per owner) and swept implicitly by the next
  overwrite; no outbox/2-phase machinery is warranted for a cosmetic asset at this scale.

## Descriptor (`protocol/frames/agent.ts` `AgentIcon`)

The wire union stays a discriminated union on `kind`, with two changes:

- `image` **carries no URL**. `{ kind: 'image' }` means "an uploaded icon in the object
  store". The display/serve URL is resolved separately (the store's public URL for the
  owner's key) and surfaced as the DTO `iconUrl` / the daemon-facing `AgentSpec.iconUrl`.
  It is set **only** by the upload route (it carries bytes), never a create/update body —
  so the create/update DTO (`AgentIconBody`) omits `image`; the output DTO
  (`AgentIconDto`) includes it.
- `runtime` **stays in the union and the renderer** as the meaning of a null/legacy icon
  and the render fallback — but it is **removed from the picker**. (Dropping the union
  member would break every legacy agent whose icon is null or `runtime`.)

The same union is reused for `Org.icon` (`icon Json?`, additive migration; org just never
feeds Slack). A legacy org with a null icon renders a deterministic glyph keyed off its id.

## Upload transport (browser → CP → store)

The CP **proxies** the upload so it can validate before storing (no `@fastify/multipart`
— a plugin-scoped `image/*` content-type parser buffers the body):

```
PUT    /orgs/:orgId/agents/:agentId/icon   image/png|jpeg|webp   (agent-edit authz)
DELETE /orgs/:orgId/agents/:agentId/icon                          → reset to a random glyph
PUT    /orgs/:orgId/icon                    image/png|jpeg|webp   (owner-only)
DELETE /orgs/:orgId/icon                                          → reset to a random glyph
```

These routes are mounted **only when the store is configured**. `PUT` writes the object,
sets the owner's `icon = { kind: 'image' }`, and bumps `lastModifiedAt`/`updatedAt`
(cache-bust). **`PUT`/`DELETE` then perform the same best-effort `agent/upsert` to the
owning daemon that the spec PATCH route does** — a placed daemon caches `iconUrl` in its
local agent replica and uses it for the Slack per-message avatar, so without this push it
would keep serving the old `?v=` URL until some unrelated edit; the reconnect roster is
the fallback. (Org icons are console-only and need no daemon push.)

**Client UX** (`AgentIconPicker`, reused for org): an _Upload_ button → file input
(`accept="image/png,image/jpeg,image/webp"`) → **client-side square crop + resize to
≤256×256** on a `<canvas>` → `canvas.toBlob('image/webp')` → `fetch(url, {method:'PUT',
body: blob})`. Resizing client-side means the server never needs `sharp`.

**Server validation / security (client resizing is untrusted).** A caller can POST
arbitrary bytes straight at the API, so the CP re-validates independently:

- `bodyLimit` ~512 KB.
- **Magic bytes** → PNG / JPEG / WebP only (the caller `Content-Type` is ignored);
  **SVG rejected** (script vector). The sniffed type is what's stored + served.
- **Decoded dimensions** → parse the header (`image-size`) and reject anything past a small
  cap (512²) — a valid signature says nothing about pixel size, and a tiny compressed
  payload can declare an enormous canvas (a decompression bomb the browser/Slack would
  allocate when decoding from the store).
- **Content sniffing:** each object is stored with (and served as) its server-sniffed image
  `Content-Type`, pinning its type. `X-Content-Type-Options: nosniff` is set on the
  CP-**rendered** responses (glyph/runtime PNG); on the **direct store path** the CP can't
  set response headers via PutObject, so `nosniff` for `icon/*` is enforced at the
  configured CDN/bucket edge.

## Serving

- **Agent** — `GET /v1/agents/:id/icon`: `image` → 302 to the store's public URL (cache-
  busted by `?v=<lastModified>`); glyph/runtime → rasterized PNG via `@resvg/resvg-js`.
  For an `image` icon the resolved `iconUrl` is the store URL directly, so Slack/browsers
  normally fetch the store and never hit this endpoint; the redirect is the fallback.
- **Org** — `GET /v1/orgs/:id/icon`, mirroring the agent endpoint (public, unauth,
  version-root + `/v1` alias — an `<img src>` can't send a bearer, and a logo isn't
  sensitive). `image` → store URL; glyph → rasterized; null → deterministic default glyph.
- `resolveAgentIconUrl` / `resolveOrgIconUrl` take both bases (`cp` = CP endpoint,
  `store` = `S3_PUBLIC_BASE_URL`): `image` resolves to the store URL, everything else to
  the CP endpoint.

## Authz

- Agent icon: same guard as `PATCH` agent (org member with edit rights, `canEdit`).
- Org icon: owner-only (`denyNonOwner`, same as `PATCH /orgs/:orgId`).

## Back-compat

- A stored `image` variant that still carries `url` degrades gracefully to the
  runtime/glyph fallback. `Org.icon` is additive; existing orgs read null → the
  deterministic default.
- The `AGENT_ICON_GLYPHS` / `AGENT_ICON_COLORS` vocab stays hand-mirrored across
  `protocol`, CP `agent-icon.ts`, and web `lib/agent-icon.ts` (unchanged here).
