// Codex's live base-URL surface is CODEX_CONFIG (codex-acp projects it into each session's
// config over app-server); the OPENAI_BASE_URL env var is routing-inert to the pinned runtime.
// This module is import-free on purpose: the sandbox shim bundle must not drag the daemon's
// credential paths into the runtime image (see tsdown.shim.config.ts).

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
  const providers = record(config.model_providers, 'CODEX_CONFIG.model_providers')
  const openai = record(providers.openai, 'CODEX_CONFIG.model_providers.openai')
  return JSON.stringify({
    ...config,
    model_provider: 'openai',
    model_providers: {
      ...providers,
      openai: { name: 'OpenAI', ...openai, base_url: baseUrl, env_key: 'OPENAI_API_KEY' }
    }
  })
}

/** Fill-in variant for the sandbox shim: undefined when the daemon already aimed codex somewhere. */
export function codexConfigWithBaseUrlFillIn(raw: string | undefined, baseUrl: string): string | undefined {
  const config = objectFromJson(raw, 'CODEX_CONFIG')
  const provider = config.model_provider
  if (typeof provider === 'string' && provider !== 'openai') return undefined
  const providers = record(config.model_providers, 'CODEX_CONFIG.model_providers')
  const openai = record(providers.openai, 'CODEX_CONFIG.model_providers.openai')
  if (typeof openai.base_url === 'string' && openai.base_url.trim()) return undefined
  return codexConfigWithBaseUrl(raw, baseUrl)
}
