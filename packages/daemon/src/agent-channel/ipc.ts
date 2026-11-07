// The agent channel socket call itself, for the in-sandbox entries that reach it (the auto-merge watcher, `agentconnect-secrets`).
// Node builtins only: every consumer of this file is bundled into the runtime image.
import { createConnection } from 'node:net'
import { AGENT_CHANNEL_CAPABILITY_ENV } from './env.js'

export interface AgentChannelReply {
  ok: boolean
  password?: string
  error?: string
  /** Present when the control plane refused, as opposed to the daemon being unreachable. */
  denied?: 'repository' | 'agent'
}

/** One newline-delimited-JSON round trip on the agent channel socket; never rejects, since an unreachable daemon is an `ok:false` answer. */
export function agentChannelIpc(path: string, msg: unknown): Promise<AgentChannelReply> {
  return new Promise((resolve) => {
    const sock = createConnection(path)
    let buf = ''
    const fail = (error: string) => resolve({ ok: false, error })
    sock.setTimeout(15_000, () => {
      sock.destroy()
      fail('daemon did not answer in time')
    })
    sock.on('connect', () => sock.write(JSON.stringify(msg) + '\n'))
    sock.on('data', (c) => {
      buf += c.toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl === -1) return
      sock.destroy()
      try {
        resolve(JSON.parse(buf.slice(0, nl)) as AgentChannelReply)
      } catch {
        fail('malformed daemon reply')
      }
    })
    sock.on('error', (e) => fail(`cannot reach the daemon socket at ${path}: ${e.message}`))
  })
}

/** A GH_TOKEN-plane token for one repository, or a thrown reason. Fetched per use rather than
 *  cached here: these tokens are short-lived, and the daemon/CP side already caches and clamps. */
export async function fetchGhToken(
  args: { agentId: string; repoFullName: string; socketPath: string; capability?: string },
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  const res = await agentChannelIpc(args.socketPath, {
    op: 'get',
    agentId: args.agentId,
    capability: args.capability ?? env[AGENT_CHANNEL_CAPABILITY_ENV],
    plane: 'gh',
    repoFullName: args.repoFullName
  })
  if (!res.ok || !res.password) {
    throw new Error(
      `no gh credentials for agent ${args.agentId} on ${args.repoFullName}: ${res.error ?? 'unknown error'}`
    )
  }
  return res.password
}
