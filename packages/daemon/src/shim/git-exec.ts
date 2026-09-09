import { CommandGitRunner, GitExecResultSchema, type GitExecPayload } from '../workspace/command-git-runner.js'
import { GitTransportError } from '../workspace/git-runner.js'
import { ShimChannelLostError, type ShimRequester } from './channels.js'

export {
  GitExecPayloadSchema,
  GitExecResultSchema,
  GitExecError,
  parsePorcelainV2,
  parseShortstat
} from '../workspace/command-git-runner.js'
export type { GitExecPayload, GitExecResult } from '../workspace/command-git-runner.js'

// Only reads may be repeated after a lost channel; mutations may already have committed.
const REPEATABLE_SUBCOMMANDS = new Set([
  'check-ref-format',
  'diff',
  'log',
  'ls-files',
  'remote',
  'rev-list',
  'rev-parse',
  'status',
  'symbolic-ref'
])

// The pool transport keeps its own retry and request-margin semantics.
export class ShimGitRunner extends CommandGitRunner {
  constructor(requester: ShimRequester, cwd?: string, env?: Record<string, string>, abort?: AbortSignal) {
    super(
      async (payload: GitExecPayload) => {
        const options = { timeoutMs: payload.timeoutMs! + 15_000, ...(abort ? { abort } : {}) }
        const request = () => requester.request('exec', payload, options)
        let reply
        try {
          reply = await request()
        } catch (error) {
          if (!(error instanceof ShimChannelLostError)) throw error
          if (!REPEATABLE_SUBCOMMANDS.has(payload.args[0] ?? '')) {
            throw new GitTransportError(
              `git ${payload.args[0] ?? ''} lost its sandbox channel: ${error.message}`,
              error
            )
          }
          try {
            reply = await request()
          } catch (retry) {
            throw new GitTransportError(
              `git ${payload.args[0] ?? ''} lost its sandbox channel: ${(retry as Error).message}`,
              retry
            )
          }
        }
        return GitExecResultSchema.parse(reply)
      },
      cwd,
      env
    )
  }
}
