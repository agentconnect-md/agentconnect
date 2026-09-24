import { SANDBOX_LAUNCH_GENERATION, type Sandbox, type SandboxFence } from '../src/k8s/sandbox-api.js'

// Fake API fixtures persist the same ownership annotation as the Kubernetes server.
export function fenceFakeSandbox(sandbox: Sandbox, fence: SandboxFence): void {
  if (sandbox.metadata?.uid !== fence.sandboxUid) throw new Error('sandbox was replaced')
  const annotations = sandbox.metadata.annotations ?? {}
  if (Number(annotations[SANDBOX_LAUNCH_GENERATION] ?? 0) > fence.generation)
    throw new Error('newer launch owns sandbox')
  sandbox.metadata.annotations = { ...annotations, [SANDBOX_LAUNCH_GENERATION]: String(fence.generation) }
}
