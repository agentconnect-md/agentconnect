/**
 * `http/version.ts` — the single source of truth for the REST API version prefix.
 *
 * Every public REST route is mounted under this prefix (`/api/v1/orgs`,
 * `/api/v1/me`, `/api/v1/orgs/:orgId/…`) so the surface is externally versioned
 * from day one: a future breaking change ships as `/api/v2/…` alongside `v1`
 * instead of mutating live URLs. Two surfaces stay UNVERSIONED by design:
 *
 *   - `GET /health` — an infra liveness/readiness probe hit at a stable path by
 *     the deployment (k8s/ingress); versioning a probe is an anti-pattern.
 *   - `/daemon/ws` — the internal daemon↔CP control channel, versioned in-band by
 *     the `@agentconnect.md/protocol` frames (subprotocol `agentconnect.v1`), not
 *     by URL.
 *   - `/api/v1/relays/ws` — the relay↔CP control channel (`rc/*`), likewise
 *     versioned in-band by its subprotocol (`agentconnect.rc.v1`).
 *
 * Browser webchat is NOT a CP WebSocket surface: the console mints
 * a token at `POST /api/v1/orgs/:orgId/agents/:agentId/webchat/token` and dials the
 * RELAY pool — content never touches the CP.
 *
 * Deploying the CP behind a dedicated `api.example.com/v1` host is an INGRESS
 * concern (a rewrite from `api.example.com/v1/*` to the CP's `/api/v1/*`) managed
 * outside this repository. See `docs/designs/api-versioning.md`.
 */

/** The REST API version prefix. Mirrored in `packages/web/src/lib/api.ts`. */
export const API_V1_PREFIX = '/api/v1'
