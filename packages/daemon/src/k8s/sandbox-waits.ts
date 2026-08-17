import { Backoff, type Clock } from '@agentconnect.md/connection'
import { K8sApiError } from '@agentconnect.md/k8s-client'
import { isSandboxReady, type SandboxApi } from './sandbox-api.js'
import { LaunchTimeoutError, resolvePodIp, resolvePodName } from './sandbox-identity.js'

export interface SandboxWaitDeps {
  api: SandboxApi
  clock: Clock
  /** How long a claim may take to bind and its pod to come up; one ceiling for both waits. */
  timeoutMs: number
}

/** Read an object that may legitimately not exist yet; anything but a 404 is still an error. */
export async function readIfPresent<T>(read: () => Promise<T>): Promise<T | undefined> {
  return await read().catch((err: unknown) => {
    if (err instanceof K8sApiError && err.isNotFound) return undefined
    throw err
  })
}

/** Wait for the claim to name a Sandbox. Bound is enough; readiness is the wait that follows. */
export async function awaitBoundSandbox(claimName: string, deps: SandboxWaitDeps): Promise<string> {
  const poll = poller(deps)
  for (;;) {
    const claim = await readIfPresent(() => deps.api.getClaim(claimName))
    const name = claim?.status?.sandbox?.name
    if (name) return name
    if (!(await poll())) throw new LaunchTimeoutError(`claim ${claimName} did not bind a sandbox in time`)
  }
}

/** Wait for the Sandbox to report Ready, after something has asked it to run. */
// Pod identity and address are resolved only after readiness so a resumed launch cannot reuse the
// previous incarnation's annotation or IP.
export async function awaitReady(
  sandboxName: string,
  deps: SandboxWaitDeps
): Promise<{ podName: string; podIp: string }> {
  const poll = poller(deps)
  for (;;) {
    const sandbox = await deps.api.getSandbox(sandboxName).catch(() => undefined)
    const ready = sandbox !== undefined && isSandboxReady(sandbox)
    const podName = sandbox ? resolvePodName(sandbox) : undefined
    const podIp = sandbox ? resolvePodIp(sandbox) : undefined
    if (ready && podName && podIp) return { podName, podIp }
    if (await poll()) continue
    if (ready && !podName) throw new LaunchTimeoutError(`sandbox ${sandboxName} became ready but never named its pod`)
    if (ready) throw new LaunchTimeoutError(`sandbox ${sandboxName} became ready but never reported a pod IP`)
    throw new LaunchTimeoutError(`sandbox ${sandboxName} did not become ready in time`)
  }
}

/** One backoff-and-deadline pass: resolves false once the wait may no longer be retried. */
function poller(deps: SandboxWaitDeps): () => Promise<boolean> {
  const backoff = new Backoff({ baseMs: 250, capMs: 2_000, jitter: () => 0 })
  const deadline = deps.clock.now() + deps.timeoutMs
  return async () => {
    if (deps.clock.now() >= deadline) return false
    await new Promise<void>((resolve) => deps.clock.setTimeout(resolve, backoff.next()))
    return true
  }
}
