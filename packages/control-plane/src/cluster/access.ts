/**
 * Kubernetes API access for the cluster provisioner.
 *
 * One switch and no credentials to configure: enabling managed execution
 * asserts that this control plane runs INSIDE the cluster it provisions, so the
 * pod's projected ServiceAccount is the credential and the pod's own namespace
 * is the control namespace every `AgentConnectOrg` lands in. The switch stays
 * explicit — a control plane that merely happens to run on Kubernetes must not
 * start claiming an operator install — but nothing beyond it is a knob.
 *
 * There is deliberately no out-of-cluster mode. An API server plus a token, or
 * a kubeconfig, would each be a second deployment shape to keep correct, and
 * the operator this writes for is installed in the same namespace anyway; a
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
 * when it is on and this process is not in a pod: the provisioner is opt-in, so
 * a deployment that asked for it should fail loudly at boot rather than mount a
 * cluster surface whose every write fails at the API server.
 */
export function loadClusterAccess(config: ClusterAccessConfig): InClusterConfig | undefined {
  return config.CLUSTER_EXECUTION_ENABLED ? loadInClusterConfig() : undefined
}
