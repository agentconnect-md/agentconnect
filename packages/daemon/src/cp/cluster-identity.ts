/**
 * The daemon's own Kubernetes identity — the credential an in-cluster daemon presents to the
 * control plane instead of an API key
 * (docs/designs/k8s-daemon-pool.md §3, "Identity is per Pod, not per org").
 *
 * The mirror of what the shim does one hop down: the kubelet projects an audience-scoped
 * ServiceAccount token into the pod, and presenting it proves which Pod — and so which pool
 * member — this daemon is. The file is read at every connect rather than once
 * at startup: the kubelet rewrites it roughly hourly, and a token cached for the process
 * lifetime is a token that expires mid-life and reconnects with a credential the control
 * plane refuses.
 */
import { readFileSync } from 'node:fs'
import { CP_IDENTITY_TOKEN_PATH } from '@agentconnect.md/protocol'

export { CP_IDENTITY_TOKEN_PATH }

/** The projected token, or undefined when this daemon has no Kubernetes identity — which is
 *  every daemon outside a cluster, and the reason the API-key path stays exactly as it is. */
export function readClusterIdentityToken(path: string = CP_IDENTITY_TOKEN_PATH): string | undefined {
  try {
    const token = readFileSync(path, 'utf8').trim()
    return token || undefined
  } catch {
    return undefined
  }
}
