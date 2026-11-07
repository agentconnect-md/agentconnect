// A VM or pod launch's switch from the credential helper to the credential proxy, made once its shim has reported a `codehost` listener.
import type { SpawnRequest } from '../acp/spawn-driver.js'
import { proxyTrustEnv } from '../credential-proxy/ca.js'
import { SESSION_TRUST_ENV, sessionAuthorityFiles } from '../credential-proxy/trust-bundle.js'
import type { TunnelListening } from '../shim/tunnel.js'
import { mergeGitConfigEnv, proxyCredentialResetEnv } from '../workspace/git-injection.js'

export type CodehostListener = NonNullable<TunnelListening['proxy']>

/** The `HTTPS_PROXY` URL naming a shim's codehost listener, with its proxy credential. */
export function codehostProxyUrl(listener: Pick<CodehostListener, 'port' | 'token'>): string {
  return `http://codehost:${listener.token}@127.0.0.1:${listener.port}`
}

/** The launch as the runtime receives it: its codehost env applied when the shim serves a listener and the launch names no proxy of its own, else the helper path untouched. */
export function applyCodehostSpawn(request: SpawnRequest, listener: CodehostListener | undefined): SpawnRequest {
  const { codehost, ...launch } = request
  if (!codehost || !listener || launch.env.HTTPS_PROXY || launch.env.https_proxy) return launch
  const url = codehostProxyUrl(listener)
  const noProxy = ['localhost', '127.0.0.1', '::1', launch.env.NO_PROXY ?? launch.env.no_proxy]
    .filter((entry) => entry)
    .join(',')
  // The files the launch's trust variables named (a VM's microsandbox authority, a session's own), which the shim merges where they are.
  const authorities = sessionAuthorityFiles(launch.env, {}).filter((file) => file !== listener.trustBundle)
  const files = [...(launch.files ?? []), ...(codehost.files ?? [])]
  return {
    ...launch,
    env: {
      ...launch.env,
      ...codehost.env,
      // The codehost's command-scope helper is read after any pairs the launch already carries, then the listener's own helper reset.
      ...mergeGitConfigEnv(mergeGitConfigEnv(launch.env, codehost.env), proxyCredentialResetEnv(url)),
      ...proxyTrustEnv({ bundlePath: listener.trustBundle }),
      ...(authorities.length > 0
        ? { [SESSION_TRUST_ENV]: JSON.stringify({ bundle: listener.trustBundle, files: authorities }) }
        : {}),
      HTTPS_PROXY: url,
      https_proxy: url,
      NO_PROXY: noProxy,
      no_proxy: noProxy,
      NODE_USE_ENV_PROXY: '1'
    },
    ...(files.length > 0 ? { files } : {})
  }
}
