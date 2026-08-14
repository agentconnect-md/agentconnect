/**
 * Kubernetes API access for the control plane's cluster surface — the whole of
 * which is now the TokenReview call that authenticates an in-cluster daemon.
 *
 * One switch and no credentials to configure: enabling in-cluster daemon
 * identity asserts that this control plane runs INSIDE the cluster, so the pod's
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
  CLUSTER_DAEMON_IDENTITY_ENABLED: boolean
  /** Deprecated alias, honored so a deployment can roll the control plane before its chart. */
  CLUSTER_EXECUTION_ENABLED?: boolean
}

/**
 * The in-cluster client config, or undefined when the feature is off. Throws
 * when it is on and this process is not in a pod: the surface is opt-in, so a
 * deployment that asked for it should fail loudly at boot rather than mount a
 * cluster surface whose every call fails at the API server.
 *
 * Either key turns it on, folded here in the one place that gates the surface so
 * nothing downstream learns that a legacy spelling exists.
 */
export function loadClusterAccess(config: ClusterAccessConfig): InClusterConfig | undefined {
  const enabled = config.CLUSTER_DAEMON_IDENTITY_ENABLED || config.CLUSTER_EXECUTION_ENABLED === true
  return enabled ? loadInClusterConfig() : undefined
}
