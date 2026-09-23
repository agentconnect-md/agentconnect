import { MAX_AUTO_MERGE_DETAIL } from '@agentconnect.md/protocol'
import type { AutoMergeSandbox, SandboxCall, SandboxState } from '../github/auto-merge/watcher.js'
import { AutoMergeViolationError } from '../github/auto-merge/watcher.js'
import { AUTO_MERGE_UNSUPPORTED_IMAGE } from './auto-merge-handler.js'
import { ShimChannelLostError, type ShimRequester } from './channels.js'

/** The daemon side of the `automerge` channel on one bound shim, keyed by the pull request the caller names. */
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

  /** The same read with a lost channel propagated, so an arm's scan asks again instead of taking a renewal for "nothing here". */
  watching(call: SandboxCall): Promise<SandboxState> {
    return this.send({ ...call, op: 'state' })
  }

  /** Whether ANY watcher is armed in this pod, asked of the registry that owns the answer; a lost channel propagates, since a renewal loses the request and not the watcher, and a suspend decided on it would kill one. */
  async anyArmed(agentId: string): Promise<boolean> {
    return (await this.send({ agentId, op: 'list' })).armed
  }

  private async request(payload: Record<string, unknown>): Promise<SandboxState> {
    try {
      return await this.send(payload)
    } catch (err) {
      // For the box's own ops a lost channel is a pod that went away mid-request, which IS the answer: nothing is watching any more.
      if (err instanceof ShimChannelLostError) return { armed: false }
      throw err
    }
  }

  private async send(payload: Record<string, unknown>): Promise<SandboxState> {
    try {
      const answer = (await this.requester.request('automerge', payload)) as SandboxState
      return { armed: answer?.armed === true, ...pick(answer) }
    } catch (err) {
      if (err instanceof ShimChannelLostError) throw err
      const message = err instanceof Error ? err.message : String(err)
      // An image that ships no watcher is a refusal the console shows.
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

/** Ask a pod's registry, retrying once on the session a renewal re-attached; a second lost channel propagates as "unknown", and no channel at all answers false. */
export async function askArmed(
  sessionFor: () => Promise<ShimRequester | undefined>,
  agentId: string
): Promise<boolean> {
  const ask = async (): Promise<boolean> => {
    const session = await sessionFor()
    return session ? await new ShimAutoMergeClient(session).anyArmed(agentId) : false
  }
  try {
    return await ask()
  } catch (err) {
    if (!(err instanceof ShimChannelLostError)) throw err
    return await ask()
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
