/**
 * Kubernetes API access for the control plane's cluster surface (pool member
 * identity via TokenReview).
 *
 * Naming the pool namespace is the switch, and there are no credentials to
 * configure: it asserts that this control plane runs INSIDE the cluster, so
 * the pod's projected ServiceAccount is the credential. A control plane that
 * merely happens to run on Kubernetes must not start claiming cluster access,
 * which is why this is an explicit key and not sniffed from the environment.
 *
 * There is deliberately no out-of-cluster mode. An API server plus a token, or
 * a kubeconfig, would each be a second deployment shape to keep correct; a
 * control plane that cannot reach its own ServiceAccount is misconfigured, not
 * differently configured.
 */
import { loadInClusterConfig, type InClusterConfig } from '@agentconnect.md/k8s-client'

export interface ClusterAccessConfig {
  /** Namespace of this install's pool members; set ⇒ the cluster surface is on. */
  POOL_NAMESPACE?: string
}

export interface ClusterAccess {
  cluster: InClusterConfig
  poolNamespace: string
}

/**
 * The in-cluster client config plus the pool namespace, or undefined when no
 * pool namespace is named. Throws when one is named and this process is not in
 * a pod: a deployment that asked for cluster access should fail loudly at boot
 * rather than mount a surface whose every call fails at the API server.
 */
export function loadClusterAccess(config: ClusterAccessConfig): ClusterAccess | undefined {
  if (!config.POOL_NAMESPACE) return undefined
  return { cluster: loadInClusterConfig(), poolNamespace: config.POOL_NAMESPACE }
}
