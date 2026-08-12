/**
 * Kubernetes API access for the cluster provisioner.
 *
 * One switch (`CLUSTER_EXECUTION_ENABLED`) and three credential sources, all
 * producing the structural config `@agentconnect.md/k8s-client` takes. The
 * source is DERIVED from what the deployment set rather than named, most
 * explicit first: an API server + token, then a kubeconfig file, and finally
 * the pod's own projected ServiceAccount — the zero-config case for a control
 * plane running inside the cluster it provisions. Bearer credentials only —
 * `K8sHttp` authenticates with `Authorization: Bearer`, so a client-certificate
 * or `exec` kubeconfig user is refused by name rather than half-working.
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

/** A CA bundle given inline: PEM as-is, or the base64 of one (what kubeconfig
 *  and Secret values carry), so an operator can paste either form. */
function decodeCaBundle(value: string): string {
  const trimmed = value.trim()
  if (trimmed.includes('-----BEGIN')) return trimmed
  return Buffer.from(trimmed, 'base64').toString('utf8')
}

function readCredentialFile(path: string, what: string): string {
  try {
    return readFileSync(path, 'utf8').trim()
  } catch (error) {
    throw new ClusterAccessError(`cannot read ${what} at ${path}: ${(error as Error).message}`)
  }
}

/**
 * A directly configured API server: the out-of-cluster path that needs no file
 * on disk, which is what a control plane deployed beside its cluster (or one
 * pointed at a different cluster than its own) can actually supply. The token
 * is read per call when it comes from a file, so a mounted Secret that rotates
 * in place is picked up without a restart.
 */
function loadApiServerAccess(config: ClusterAccessConfig): InClusterConfig {
  const server = config.CLUSTER_API_SERVER!.trim()
  const tokenFile = config.CLUSTER_API_TOKEN_FILE?.trim()
  const inlineToken = config.CLUSTER_API_TOKEN?.trim()
  if (!tokenFile && !inlineToken) {
    throw new ClusterAccessError('CLUSTER_API_SERVER needs CLUSTER_API_TOKEN or CLUSTER_API_TOKEN_FILE')
  }
  // No pod to borrow a namespace from out here, so the control namespace is the
  // deployment's to name; guessing one would provision into the wrong place.
  const namespace = config.CLUSTER_CONTROL_NAMESPACE?.trim()
  if (!namespace) throw new ClusterAccessError('CLUSTER_API_SERVER needs CLUSTER_CONTROL_NAMESPACE')
  const caFile = config.CLUSTER_CA_CERT_FILE?.trim()
  const ca = config.CLUSTER_CA_CERT?.trim()
    ? decodeCaBundle(config.CLUSTER_CA_CERT)
    : caFile
      ? readCredentialFile(caFile, 'the cluster CA bundle')
      : undefined
  return {
    server,
    namespace,
    ...(ca ? { ca } : {}),
    token: () => (tokenFile ? readCredentialFile(tokenFile, 'the cluster API token') : inlineToken!)
  }
}

export interface ClusterAccessConfig {
  /** The whole feature's switch; everything below is optional refinement. */
  CLUSTER_EXECUTION_ENABLED: boolean
  CLUSTER_API_SERVER?: string
  CLUSTER_API_TOKEN?: string
  CLUSTER_API_TOKEN_FILE?: string
  CLUSTER_CA_CERT?: string
  CLUSTER_CA_CERT_FILE?: string
  CLUSTER_KUBECONFIG_PATH?: string
  CLUSTER_CONTROL_NAMESPACE?: string
}

/**
 * The client config for whichever credential source the deployment configured,
 * or undefined when the feature is off. Throws when it is on but the
 * credentials are unusable — the provisioner is opt-in, so a deployment that
 * asked for it should fail loudly rather than serve a cluster surface that can
 * never write. Setting nothing but the switch means "this pod is in the cluster
 * it provisions", and the CRs land in the pod's own namespace.
 */
export function loadClusterAccess(config: ClusterAccessConfig): InClusterConfig | undefined {
  if (!config.CLUSTER_EXECUTION_ENABLED) return undefined
  const access = config.CLUSTER_API_SERVER?.trim()
    ? loadApiServerAccess(config)
    : config.CLUSTER_KUBECONFIG_PATH?.trim()
      ? loadKubeconfig(config.CLUSTER_KUBECONFIG_PATH.trim())
      : loadInClusterConfig()
  const namespace = config.CLUSTER_CONTROL_NAMESPACE?.trim() || access.namespace
  return { ...access, namespace, token: access.token }
}
