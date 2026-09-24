import { GITCRED_SOCKET_ENV } from '../gitcred/env.js'
import { ShimGitRunner, type GitExecPayload } from '../shim/git-exec.js'
import { GitTransportError, type GitRunner } from '../workspace/git-runner.js'
import type { MicrosandboxEnvironment, MicrosandboxManager } from './driver.js'

// A caller's replacement env names this host's HOME and PATH; the guest's own come from the launch.
const guestOwned = (name: string) =>
  name === 'HOME' || name === 'PATH' || name.startsWith('XDG_') || name === GITCRED_SOCKET_ENV

/** Git in a VM over its shim's exec channel, as on the pool; only a request the shim received can have run Git. */
export function microsandboxGitRunner(options: {
  manager: Pick<MicrosandboxManager, 'withShim'>
  environment: MicrosandboxEnvironment
  cwd: string
  env: Record<string, string>
  abort?: AbortSignal
}): GitRunner {
  const guest = Object.fromEntries(Object.entries(options.env).filter(([name]) => guestOwned(name)))
  return new ShimGitRunner(
    {
      request: async (capability, payload, requestOptions) => {
        const { env } = payload as GitExecPayload
        const mapped = env === undefined ? payload : { ...(payload as GitExecPayload), env: { ...env, ...guest } }
        let reached = false
        try {
          return await options.manager.withShim(options.environment, (shim) => {
            reached = true
            return shim.session.request(capability, mapped, requestOptions)
          })
        } catch (error) {
          if (reached) throw error
          throw new GitTransportError(error instanceof Error ? error.message : String(error), error)
        }
      }
    },
    options.cwd,
    options.env,
    options.abort
  )
}
