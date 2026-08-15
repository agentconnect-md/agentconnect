/**
 * Kubernetes API access for the control plane's cluster surface (daemon pool
 * member identity via TokenReview).
 *
 * Enabling the daemon pool is the switch, and there are no credentials to
 * configure: it asserts that this control plane runs INSIDE the cluster, so the
 * pod's projected ServiceAccount is both the credential and the namespace pool
 * members are trusted from. A control plane that merely happens to run on
 * Kubernetes must not start claiming cluster access, which is why this is an
 * explicit key and not sniffed from the environment.
 *
 * There is deliberately no out-of-cluster mode. An API server plus a token, or
 * a kubeconfig, would each be a second deployment shape to keep correct; a
 * control plane that cannot reach its own ServiceAccount is misconfigured, not
 * differently configured.
 */
import { loadInClusterConfig, type InClusterConfig } from '@agentconnect.md/k8s-client'

export interface ClusterAccessConfig {
  /** true ⇒ the cluster surface is on, and the daemon pool runs in this pod's namespace. */
  DAEMON_POOL_ENABLED?: boolean
}

/**
 * The in-cluster client config, or undefined when the daemon pool is off. Throws
 * when it is on and this process is not in a pod: a deployment that asked for
 * cluster access should fail loudly at boot rather than mount a surface whose
 * every call fails at the API server.
 */
export function loadClusterAccess(config: ClusterAccessConfig): InClusterConfig | undefined {
  if (!config.DAEMON_POOL_ENABLED) return undefined
  return loadInClusterConfig()
}
