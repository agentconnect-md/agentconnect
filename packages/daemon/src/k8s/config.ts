import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Where the kubelet projects a pod's ServiceAccount credentials. */
export const SERVICE_ACCOUNT_DIR = '/var/run/secrets/kubernetes.io/serviceaccount'

export interface InClusterConfig {
  /** API server base, e.g. `https://10.96.0.1:443`. */
  server: string
  /** The pod's namespace, from the projected `namespace` file. */
  namespace: string
  /** PEM bundle for the API server, or undefined when the CA file is absent. */
  ca?: string
  /** The current bearer token, read per call: the kubelet rotates the projected token in
   *  place, so a value cached at boot expires under a long-lived daemon. */
  token(): string
}

export class InClusterConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InClusterConfigError'
  }
}

/** Discover in-cluster API access from the pod env and projected ServiceAccount volume.
 *  Throws with the missing piece named rather than returning a half-configured client. */
export function loadInClusterConfig(
  env: NodeJS.ProcessEnv = process.env,
  dir: string = SERVICE_ACCOUNT_DIR
): InClusterConfig {
  const host = env.KUBERNETES_SERVICE_HOST?.trim()
  const port = env.KUBERNETES_SERVICE_PORT?.trim() || '443'
  if (!host) {
    throw new InClusterConfigError('KUBERNETES_SERVICE_HOST is not set — not running inside a Kubernetes pod')
  }
  const tokenPath = join(dir, 'token')
  const namespacePath = join(dir, 'namespace')
  const caPath = join(dir, 'ca.crt')
  if (!existsSync(tokenPath)) {
    throw new InClusterConfigError(`service account token not found at ${tokenPath}`)
  }
  if (!existsSync(namespacePath)) {
    throw new InClusterConfigError(`service account namespace not found at ${namespacePath}`)
  }
  // IPv6 literals must stay bracketed in the URL authority.
  const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return {
    server: `https://${authority}:${port}`,
    namespace: readFileSync(namespacePath, 'utf8').trim(),
    ...(existsSync(caPath) ? { ca: readFileSync(caPath, 'utf8') } : {}),
    token: () => readFileSync(tokenPath, 'utf8').trim()
  }
}
