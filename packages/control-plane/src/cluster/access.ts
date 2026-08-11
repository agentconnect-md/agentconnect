/**
 * Kubernetes API access for the cluster provisioner.
 *
 * Two credential sources, both producing the structural config
 * `@agentconnect.md/k8s-client` takes: the pod's projected ServiceAccount when
 * the control plane runs inside the cluster it provisions, or a kubeconfig file
 * for an out-of-cluster process (development, or a control plane deployed
 * beside the cluster). Bearer credentials only — `K8sHttp` authenticates with
 * `Authorization: Bearer`, so a client-certificate or `exec` kubeconfig user is
 * refused by name rather than half-working.
 */
import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { parse } from 'yaml'
import { loadInClusterConfig, type InClusterConfig } from '@agentconnect.md/k8s-client'

export class ClusterAccessError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClusterAccessError'
  }
}

interface KubeconfigNamedCluster {
  name?: string
  cluster?: { server?: string; 'certificate-authority'?: string; 'certificate-authority-data'?: string }
}

interface KubeconfigNamedUser {
  name?: string
  user?: { token?: string; tokenFile?: string; exec?: unknown; 'client-certificate-data'?: string }
}

interface KubeconfigNamedContext {
  name?: string
  context?: { cluster?: string; user?: string; namespace?: string }
}

interface Kubeconfig {
  'current-context'?: string
  clusters?: KubeconfigNamedCluster[]
  users?: KubeconfigNamedUser[]
  contexts?: KubeconfigNamedContext[]
}

/** Resolve a kubeconfig-relative path the way kubectl does — against the file's directory. */
function relativeToConfig(configPath: string, value: string): string {
  return isAbsolute(value) ? value : resolve(dirname(configPath), value)
}

/**
 * The current context of a kubeconfig, as a bearer-token client config. The
 * token is read per call, like the in-cluster loader, so a rotating `tokenFile`
 * is picked up without a restart; an inline `token` is a constant.
 */
export function loadKubeconfig(path: string): InClusterConfig {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    throw new ClusterAccessError(`cannot read kubeconfig at ${path}: ${(error as Error).message}`)
  }
  const config = parse(raw) as Kubeconfig | null
  const contextName = config?.['current-context']
  if (!contextName) throw new ClusterAccessError(`kubeconfig at ${path} has no current-context`)
  const context = config?.contexts?.find((entry) => entry.name === contextName)?.context
  if (!context) throw new ClusterAccessError(`kubeconfig at ${path} has no context named ${contextName}`)

  const cluster = config?.clusters?.find((entry) => entry.name === context.cluster)?.cluster
  if (!cluster?.server) throw new ClusterAccessError(`kubeconfig context ${contextName} has no cluster server`)

  const user = config?.users?.find((entry) => entry.name === context.user)?.user
  if (!user) throw new ClusterAccessError(`kubeconfig context ${contextName} has no user`)
  if (!user.token && !user.tokenFile) {
    const kind = user.exec
      ? 'an exec credential plugin'
      : user['client-certificate-data']
        ? 'a client certificate'
        : 'no bearer credential'
    throw new ClusterAccessError(
      `kubeconfig user for context ${contextName} uses ${kind}; the cluster provisioner needs a ServiceAccount token (token or tokenFile)`
    )
  }
  const tokenFile = user.tokenFile ? relativeToConfig(path, user.tokenFile) : undefined
  const caFile = cluster['certificate-authority'] ? relativeToConfig(path, cluster['certificate-authority']) : undefined
  const ca = cluster['certificate-authority-data']
    ? Buffer.from(cluster['certificate-authority-data'], 'base64').toString('utf8')
    : caFile
      ? readFileSync(caFile, 'utf8')
      : undefined

  return {
    server: cluster.server,
    namespace: context.namespace ?? 'default',
    ...(ca ? { ca } : {}),
    token: () => (tokenFile ? readFileSync(tokenFile, 'utf8').trim() : user.token!)
  }
}

export interface ClusterAccessConfig {
  CLUSTER_EXECUTION_MODE: 'off' | 'in-cluster' | 'kubeconfig'
  CLUSTER_KUBECONFIG_PATH?: string
  CLUSTER_CONTROL_NAMESPACE?: string
}

/**
 * The client config for the configured mode, or undefined when the feature is
 * off. Throws when the mode is on but its credentials are unusable — the
 * provisioner is opt-in, so a deployment that asked for it should fail loudly
 * rather than serve a cluster surface that can never write.
 */
export function loadClusterAccess(config: ClusterAccessConfig): InClusterConfig | undefined {
  if (config.CLUSTER_EXECUTION_MODE === 'off') return undefined
  const access =
    config.CLUSTER_EXECUTION_MODE === 'kubeconfig'
      ? loadKubeconfig(config.CLUSTER_KUBECONFIG_PATH!)
      : loadInClusterConfig()
  const namespace = config.CLUSTER_CONTROL_NAMESPACE ?? access.namespace
  return { ...access, namespace, token: access.token }
}
