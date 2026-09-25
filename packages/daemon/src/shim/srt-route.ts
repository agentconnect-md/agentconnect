// SRT's route out for what a shim inside its boundary starts (session-executors.md §5): inside the network namespace SRT's proxy bridge is the only one, so it is composed from the shim's own environment, which SRT set.

/** What SRT sets for its proxy bridge, and the variable that makes Node honor it. */
export const SRT_PROXY_ENV = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'NODE_USE_ENV_PROXY'
] as const

// A proxy pin: the holder's empty value means "no proxy" for that URL or remote.
const PROXY_PIN = /^(?:http(?:\..+)?|remote\..+)\.proxy$/i

/** SRT's bridge when this shim runs inside SRT (it marks every command it wraps); undefined elsewhere, where nothing changes. */
function srtBridge(shimEnv: Record<string, string | undefined>): { url: string; authenticated: boolean } | undefined {
  if (shimEnv.SANDBOX_RUNTIME !== '1') return undefined
  const url = shimEnv.HTTPS_PROXY ?? shimEnv.HTTP_PROXY
  if (!url) return undefined
  try {
    return { url, authenticated: new URL(url).username !== '' }
  } catch {
    return undefined
  }
}

/** Append command-scope Git config to whatever `GIT_CONFIG_*` pairs the env already carries. */
export function appendGitConfig(env: Record<string, string>, pairs: ReadonlyArray<readonly [string, string]>): void {
  const count = Number(env.GIT_CONFIG_COUNT)
  let next = Number.isSafeInteger(count) && count > 0 ? count : 0
  for (const [key, value] of pairs) {
    env[`GIT_CONFIG_KEY_${next}`] = key
    env[`GIT_CONFIG_VALUE_${next}`] = value
    next += 1
  }
  env.GIT_CONFIG_COUNT = String(next)
}

/** A runtime's env inside SRT: the bridge's variables over the launch's, and Basic proxy auth so Git never asks its credential helper for the proxy. */
export function applySrtProxyEnv(env: Record<string, string>, shimEnv: Record<string, string | undefined>): void {
  const bridge = srtBridge(shimEnv)
  if (!bridge) return
  for (const name of SRT_PROXY_ENV) {
    const value = shimEnv[name]
    if (value) env[name] = value
  }
  if (bridge.authenticated) appendGitConfig(env, [['http.proxyAuthMethod', 'basic']])
}

/** A holder's Git env inside SRT: its empty proxy pins name the bridge instead, and every other setting it sent stays as sent. */
export function srtGitEnv(
  env: Record<string, string> | undefined,
  shimEnv: Record<string, string | undefined>
): Record<string, string> | undefined {
  const bridge = srtBridge(shimEnv)
  if (!bridge) return env
  const composed: Record<string, string> = {}
  for (const [name, value] of Object.entries(env ?? shimEnv)) if (value !== undefined) composed[name] = value
  const count = Number(composed.GIT_CONFIG_COUNT)
  for (let index = 0; Number.isSafeInteger(count) && index < count; index += 1) {
    const key = composed[`GIT_CONFIG_KEY_${index}`]
    // The pins exist so nothing a checkout or the host configures reroutes this egress; the boundary's own bridge is no such route.
    if (key && PROXY_PIN.test(key) && composed[`GIT_CONFIG_VALUE_${index}`] === '')
      composed[`GIT_CONFIG_VALUE_${index}`] = bridge.url
  }
  applySrtProxyEnv(composed, shimEnv)
  return composed
}
