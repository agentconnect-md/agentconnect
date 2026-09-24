import { GITCRED_SOCKET_ENV } from '../gitcred/env.js'
import type { ShimRequester } from '../shim/channels.js'
import { ShimGitRunner, type GitExecPayload } from '../shim/git-exec.js'
import { GitTransportError, type GitRunner } from '../workspace/git-runner.js'

// A caller's replacement env names this host's HOME and PATH; the guest's own come from the launch.
const guestOwned = (name: string) =>
  name === 'HOME' || name === 'PATH' || name.startsWith('XDG_') || name === GITCRED_SOCKET_ENV

/** Git in a VM over its shim's exec channel, as on the pool; only a request the shim received can have run Git. */
export function microsandboxGitRunner(options: {
  /** One request over the VM's bound shim, the environment held for it: the local executor's `withEnvironment`. */
  run: <T>(work: (session: ShimRequester) => Promise<T>) => Promise<T>
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
          return await options.run((session) => {
            reached = true
            return session.request(capability, mapped, requestOptions)
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
