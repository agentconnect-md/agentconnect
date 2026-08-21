import { MAX_AUTO_MERGE_DETAIL } from '@agentconnect.md/protocol'
import type { AutoMergeSandbox, SandboxCall, SandboxState } from '../github/auto-merge/watcher.js'
import { AutoMergeViolationError } from '../github/auto-merge/watcher.js'
import { AUTO_MERGE_UNSUPPORTED_IMAGE } from './auto-merge-handler.js'
import { ShimChannelLostError, type ShimRequester } from './channels.js'

/** The daemon side of the `automerge` channel: three ops on one bound shim, keyed by the pull
 *  request the caller names. Lives beside the handler it talks to, like the git runner does. */
export class ShimAutoMergeClient implements AutoMergeSandbox {
  constructor(private readonly requester: ShimRequester) {}

  arm(call: SandboxCall): Promise<SandboxState> {
    return this.request({ ...call, op: 'arm' })
  }

  disarm(call: SandboxCall): Promise<SandboxState> {
    return this.request({ ...call, op: 'disarm' })
  }

  state(call: SandboxCall): Promise<SandboxState> {
    return this.request({ ...call, op: 'state' })
  }

  /** Whether ANY watcher is armed in this pod — the sandbox keep-alive's question, asked of the
   *  registry that owns the answer rather than of a daemon-side index a restart would empty. */
  async anyArmed(agentId: string): Promise<boolean> {
    const answer = await this.request({ agentId, op: 'list' })
    return answer.armed
  }

  private async request(payload: Record<string, unknown>): Promise<SandboxState> {
    try {
      const answer = (await this.requester.request('automerge', payload)) as SandboxState
      return { armed: answer?.armed === true, ...pick(answer) }
    } catch (err) {
      // A lost channel is a pod that went away mid-request, which for this feature IS the answer:
      // nothing is watching any more. An image that ships no watcher is a refusal the console shows.
      if (err instanceof ShimChannelLostError) return { armed: false }
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes(AUTO_MERGE_UNSUPPORTED_IMAGE)) {
        throw new AutoMergeViolationError('unsupported-image', message)
      }
      // A pod BOUND before this daemon learned the capability carries no `automerge` grant, so its
      // shim refuses with `not granted` (shim/client.ts). That is the same operator fix as an old
      // image — relaunch the agent onto a fresh binding — so it gets the same 409, not a 503.
      if (message.includes('not granted')) {
        throw new AutoMergeViolationError(
          'unsupported-image',
          'this agent’s sandbox was bound before merge-when-ready — restart the agent to pick it up'
        )
      }
      throw err
    }
  }
}

function pick(answer: SandboxState | undefined): Partial<SandboxState> {
  if (!answer) return {}
  return {
    ...(answer.waitingOn ? { waitingOn: String(answer.waitingOn).slice(0, MAX_AUTO_MERGE_DETAIL) } : {}),
    ...(answer.lastError ? { lastError: String(answer.lastError).slice(0, MAX_AUTO_MERGE_DETAIL) } : {}),
    ...(answer.merged ? { merged: true } : {})
  }
}
