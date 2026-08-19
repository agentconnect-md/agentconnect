// Codex's live base-URL surface is CODEX_CONFIG (codex-acp projects it into each session's
// config over app-server); the OPENAI_BASE_URL env var is routing-inert to the pinned runtime.
// The override must be the top-level `openai_base_url` key: Codex merges configured
// `model_providers` with entry().or_insert(), so a `model_providers.openai` entry can never
// replace the built-in provider and its base_url is discarded.
// This module is import-free on purpose: the sandbox shim bundle must not drag the daemon's
// credential paths into the runtime image (see tsdown.shim.config.ts).

/** The runtime's own default endpoint — the third layer of the sanctioned injection precedence
 *  (issued base > deployment base > this), so an endpoint-less key still rides the gateway
 *  method against exactly the URL codex's built-in provider would have used. */
export const CODEX_DEFAULT_ENDPOINT = 'https://api.openai.com/v1'

/** The gateway auth request: codex-acp holds the grant as an in-process provider (base URL +
 *  auth header, responses wire), authRequired() short-circuits before account/read, and nothing
 *  touches the shared auth.json — so a persisted account of any shape cannot override the grant
 *  and concurrently launching hosts share no credential state. */
export function codexGatewayAuthRequest(baseUrl: string, key: string): string {
  return JSON.stringify({
    methodId: 'gateway',
    _meta: {
      gateway: {
        baseUrl,
        headers: { Authorization: `Bearer ${key}` },
        providerName: 'AgentConnect model egress'
      }
    }
  })
}

export function objectFromJson(raw: string | undefined, label: string): Record<string, unknown> {
  if (!raw?.trim()) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`${label} must be a valid JSON object`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`)
  }
  return parsed as Record<string, unknown>
}

export function record(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a JSON object`)
  return value as Record<string, unknown>
}

/** The one merge shape aiming codex at a base URL; throws on a malformed CODEX_CONFIG. */
export function codexConfigWithBaseUrl(raw: string | undefined, baseUrl: string): string {
  const config = objectFromJson(raw, 'CODEX_CONFIG')
  return JSON.stringify({ ...config, model_provider: 'openai', openai_base_url: baseUrl })
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Deployment floor for the sandbox shim: pod-asserted config keys sit under any daemon-sent key.
 *  A table both sides carry merges one level deep — the daemon always sends `features` (account
 *  apps off), and replacing the whole table would silently drop the floor's other entries. */
export function codexConfigWithFloor(raw: string | undefined, floorRaw: string): string | undefined {
  const floor = objectFromJson(floorRaw, 'AC_CODEX_CONFIG')
  if (Object.keys(floor).length === 0) return undefined
  const config = objectFromJson(raw, 'CODEX_CONFIG')
  const merged: Record<string, unknown> = { ...floor, ...config }
  for (const [key, floorValue] of Object.entries(floor)) {
    const configValue = config[key]
    if (isPlainObject(floorValue) && isPlainObject(configValue)) merged[key] = { ...floorValue, ...configValue }
  }
  return JSON.stringify(merged)
}

/** Fill-in variant for the sandbox shim: undefined when the daemon already aimed codex somewhere. */
export function codexConfigWithBaseUrlFillIn(raw: string | undefined, baseUrl: string): string | undefined {
  const config = objectFromJson(raw, 'CODEX_CONFIG')
  const provider = config.model_provider
  if (typeof provider === 'string' && provider !== 'openai') return undefined
  if (typeof config.openai_base_url === 'string' && config.openai_base_url.trim()) return undefined
  return codexConfigWithBaseUrl(raw, baseUrl)
}
