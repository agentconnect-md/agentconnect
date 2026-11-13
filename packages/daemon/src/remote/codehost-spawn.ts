// A VM's or executor's launch switch to the credential proxy, made once its shim has reported a `codehost` or `provider` listener.
import { posix, win32 } from 'node:path'
import type { SpawnFile, SpawnRequest } from '../acp/spawn-driver.js'
import { proxyTrustEnv } from '../credential-proxy/ca.js'
import { CODEX_CA_ENV, SESSION_TRUST_ENV, sessionAuthorityFiles } from '../credential-proxy/trust-bundle.js'
import type { TunnelListening } from '../shim/tunnel.js'
import { mergeGitConfigEnv, proxyCredentialResetLines } from '../workspace/git-injection.js'

export type CodehostListener = NonNullable<TunnelListening['proxy']>

/** The listeners a bound shim reported, one loopback proxy serving both tunnels when it reports both. */
export interface SpawnListeners {
  codehost?: CodehostListener
  provider?: CodehostListener
}

/** The `HTTPS_PROXY` URL naming a shim's proxy listener, with its proxy credential. */
export function codehostProxyUrl(listener: Pick<CodehostListener, 'port' | 'token'>): string {
  return `http://codehost:${listener.token}@127.0.0.1:${listener.port}`
}

/** The launch's files with the listener's helper reset appended to the session gitconfig `GIT_CONFIG_GLOBAL` names, read by every git in the runtime's tree. */
function withProxyCredentialReset(files: SpawnFile[] | undefined, gitconfig: string | undefined, url: string) {
  if (!files || !gitconfig) return files
  // The target's own path rules, which a Windows executor's differ from a pod's.
  const named = (file: SpawnFile): boolean =>
    [posix, win32].some((rules) => rules.join(file.root, ...file.relPath) === gitconfig)
  return files.map((file) =>
    named(file) ? { ...file, content: `${file.content}${proxyCredentialResetLines(url).join('\n')}\n` } : file
  )
}

/** The session trust request already in `env`, whose files a later switch keeps. */
function requestedTrustFiles(env: Record<string, string>): string[] {
  try {
    const files = (JSON.parse(env[SESSION_TRUST_ENV] ?? '{}') as { files?: unknown }).files
    return Array.isArray(files) ? files.filter((file): file is string => typeof file === 'string') : []
  } catch {
    return []
  }
}

/** Apply each available proxy route, refusing a required code-host route before files or the runtime are created. */
export function applyProxySpawn(request: SpawnRequest, listeners: SpawnListeners): SpawnRequest {
  const { codehost, provider, ...launch } = request
  const own = launch.env.HTTPS_PROXY || launch.env.https_proxy
  const usable = (listener: CodehostListener | undefined): listener is CodehostListener =>
    listener !== undefined && (!own || own === codehostProxyUrl(listener))
  const withCodehost = codehost && usable(listeners.codehost) ? listeners.codehost : undefined
  if (
    codehost?.required &&
    (!withCodehost ||
      [launch.env.HTTPS_PROXY, launch.env.https_proxy].some(
        (value) => value && value !== codehostProxyUrl(withCodehost)
      ))
  ) {
    const reason = listeners.codehost
      ? 'the runtime names a different HTTPS proxy'
      : 'the bound environment reported no code-host proxy listener'
    throw new Error(`code-host proxy required: ${reason}`)
  }
  const listener = withCodehost ?? (provider && usable(listeners.provider) ? listeners.provider : undefined)
  if (!listener) return launch
  const url = codehostProxyUrl(listener)
  // Provider routes ride the same listener; a shim that reported another one is not pointed at twice.
  const withProvider = provider && listeners.provider && codehostProxyUrl(listeners.provider) === url
  // The launch already routed through this listener (an executor session's codehost env) keeps that route and its trust request.
  const routed = own === url
  const noProxy = [
    'localhost',
    '127.0.0.1',
    '::1',
    (withCodehost ? (codehost!.env.NO_PROXY ?? codehost!.env.no_proxy) : undefined) ??
      launch.env.NO_PROXY ??
      launch.env.no_proxy
  ]
    .filter((entry) => entry)
    .join(',')
  const codexCa = withProvider && launch.env[CODEX_CA_ENV] !== listener.trustBundle ? launch.env[CODEX_CA_ENV] : ''
  // The files the launch's trust variables named (a VM's microsandbox authority, a session's own), which the shim merges where they are.
  const authorities = [
    ...new Set([
      ...requestedTrustFiles(launch.env),
      ...(routed ? [] : sessionAuthorityFiles(launch.env, {})),
      ...(codexCa ? [codexCa] : [])
    ])
  ].filter((file) => file !== listener.trustBundle)
  // A hosted VM's seed names its executor's trust files, which only its shim can name.
  const guest = withCodehost !== undefined && codehost?.guestTrust === true && !routed
  const files = withCodehost ? withProxyCredentialReset(launch.files, launch.env.GIT_CONFIG_GLOBAL, url) : launch.files
  return {
    ...launch,
    ...(files ? { files } : {}),
    env: {
      ...launch.env,
      ...(withCodehost
        ? {
            ...codehost!.env,
            // The codehost's command-scope helper is read after any pairs the launch already carries.
            ...mergeGitConfigEnv(launch.env, codehost!.env)
          }
        : {}),
      ...(withProvider ? { ...provider!.env, [CODEX_CA_ENV]: listener.trustBundle } : {}),
      ...(routed
        ? {}
        : {
            ...proxyTrustEnv({ bundlePath: listener.trustBundle }),
            HTTPS_PROXY: url,
            https_proxy: url,
            NO_PROXY: noProxy,
            no_proxy: noProxy,
            NODE_USE_ENV_PROXY: '1'
          }),
      ...(authorities.length > 0 || guest
        ? {
            [SESSION_TRUST_ENV]: JSON.stringify({
              bundle: listener.trustBundle,
              files: authorities,
              ...(guest ? { guest: true } : {})
            })
          }
        : {})
    }
  }
}
