import { z } from 'zod'

/**
 * Auth & identity — protocol §3.1 / §3.2.
 *
 * `auth` is the first frame after the socket opens. `auth/ok` carries the
 * minted `sessionEpoch` (the global fencing token), heartbeat cadence, and the
 * resume verdict.
 */

export const AuthReq = z.object({
  // Long-lived, revocable API key — a bare opaque `<secret><crc>`, hashed at rest and looked up
  // by that unique hash (see docs/designs/daemon-api-key-auth.md). A daemon with no Kubernetes
  // identity carries this; an in-cluster one sends `serviceAccountToken` instead.
  apiKey: z.string().optional(),
  // Projected ServiceAccount token of an operator-provisioned daemon pod, audience-scoped to
  // CP_TOKEN_AUDIENCE and verified by TokenReview against the org's cluster (see "Daemon
  // identity" in docs/designs/agentconnect-org-operator.md). Takes precedence over `apiKey`.
  serviceAccountToken: z.string().optional(),
  // Optional echo of the daemonId. If present it must equal the daemonId the ApiKey row
  // resolves to; otherwise the daemon adopts the authoritative id from `auth/ok`.
  daemonId: z.string().uuid().optional(),
  machineId: z.string().uuid().optional(), // 🅼 machine identity (scope-attestation, §3.2) — NOT the auth credential
  attestation: z.string().optional(), // 🅼 signed proof (JWS), §3.2
  agentVersion: z.string(), // daemon build/version
  // Auth-time lifecycle support; optional for rolling compatibility.
  bootstrapProtocolVersion: z.literal(1).optional(),
  resume: z
    .object({
      lastEpoch: z.number().int() // sessionEpoch the daemon last held
    })
    .optional()
})
export type AuthReq = z.infer<typeof AuthReq>

export const BootstrapLifecycle = z.object({
  operationId: z.string(),
  action: z.literal('upgrade'),
  targetVersion: z.string()
})
export type BootstrapLifecycle = z.infer<typeof BootstrapLifecycle>

export const AuthOk = z.object({
  daemonId: z.string().uuid(),
  sessionEpoch: z.number().int(), // monotonic; bumped each successful (re)auth — fencing token
  heartbeatSec: z.number().int(), // cadence the daemon must emit heartbeat at
  // How long the CP keeps a duty lease alive past the last heartbeat it renewed from
  // (T_reassign). The member self-fences strictly earlier, so it must be told the CP's
  // own value rather than duplicate it. Optional: an older CP omits it.
  dutyLeaseMs: z.number().int().positive().optional(),
  serverTime: z.string().datetime(),
  // Single-org daemons inherit tenant context from auth; install-wide cloud daemons require
  // every org-scoped post-auth frame to carry `Envelope.orgId`.
  organizationMode: z.enum(['connection', 'frame']).default('connection'),
  // Base URL of the Web App console (the CP's own public origin), so the daemon can build
  // session deep links without local config. Omitted when the CP has no console URL
  // configured; a daemon-local `webAppUrl` overrides it.
  webAppUrl: z.string().optional(),
  // Slug of the org this daemon's api key belongs to. The console is org-scoped
  // (`<webAppUrl>/<orgSlug>/sessions/<id>`), so the daemon needs it to build a link that
  // resolves. Omitted when the CP can't resolve it; then the daemon drops the segment.
  orgSlug: z.string().optional(),
  // Durable upgrade intent returned only to bootstrap-capable callers.
  lifecycle: BootstrapLifecycle.optional(),
  resume: z
    .object({
      accepted: z.boolean() // false ⇒ daemon must do a full register reconcile
    })
    .optional()
})
export type AuthOk = z.infer<typeof AuthOk>
