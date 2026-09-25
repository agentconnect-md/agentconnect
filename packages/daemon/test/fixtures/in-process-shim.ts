import { vi } from 'vitest'
import type { EnvironmentDescriptor } from '../../src/execution/strategies.js'
import type { ShimRequester } from '../../src/shim/channels.js'
import { createExecHandler } from '../../src/shim/exec-handler.js'
import { applyMemoryFsPayload, isMemoryFsPayload } from '../../src/shim/memory-fs-channel.js'
import { pathExecutor } from './memory-fs-pod.js'

/** A local executor's `withEnvironment` over the handlers a shim ships, served in process on this disk: no shim process and no boundary. */
export function inProcessShimExecutor() {
  const seen: { environment: EnvironmentDescriptor; capability: string; payload: unknown }[] = []
  const handlers = new Map<string, ReturnType<typeof createExecHandler>>()
  const withEnvironment = vi.fn(
    async (environment: EnvironmentDescriptor, work: (session: ShimRequester) => Promise<unknown>) => {
      const root = environment.workspaceRoot
      let handle = handlers.get(root)
      if (!handle) {
        handle = createExecHandler({ workspaceRoot: root, log: { info: () => {}, warn: () => {} } })
        handlers.set(root, handle)
      }
      const served = handle
      return work({
        request: async (capability, payload) => {
          seen.push({ environment, capability, payload })
          return isMemoryFsPayload(payload)
            ? applyMemoryFsPayload(payload, root, pathExecutor())
            : served(capability, payload)
        }
      })
    }
  )
  return { withEnvironment, seen, stop: async () => {} }
}
