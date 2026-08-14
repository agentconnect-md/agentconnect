/**
 * Kubernetes API access for the control plane's cluster surface — today the
 * TokenReview call that authenticates an in-cluster daemon.
 *
 * One switch and no credentials to configure: enabling cluster execution
 * asserts that this control plane runs INSIDE the cluster, so the pod's
 * projected ServiceAccount is the credential and the pod's own namespace is the
 * control namespace. The switch stays explicit — a control plane that merely
 * happens to run on Kubernetes must not start claiming cluster access — but
 * nothing beyond it is a knob.
 *
 * There is deliberately no out-of-cluster mode. An API server plus a token, or
 * a kubeconfig, would each be a second deployment shape to keep correct; a
 * control plane that cannot reach its own ServiceAccount is misconfigured, not
 * differently configured.
 */
import { loadInClusterConfig, type InClusterConfig } from '@agentconnect.md/k8s-client'

export interface ClusterAccessConfig {
  /** The whole feature's switch; there is nothing else to set. */
  CLUSTER_EXECUTION_ENABLED: boolean
}

/**
 * The in-cluster client config, or undefined when the feature is off. Throws
 * when it is on and this process is not in a pod: the surface is opt-in, so a
 * deployment that asked for it should fail loudly at boot rather than mount a
 * cluster surface whose every call fails at the API server.
 */
export function loadClusterAccess(config: ClusterAccessConfig): InClusterConfig | undefined {
  return config.CLUSTER_EXECUTION_ENABLED ? loadInClusterConfig() : undefined
}
