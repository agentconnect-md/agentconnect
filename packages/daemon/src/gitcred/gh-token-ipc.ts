// The gitcred socket call itself, split out of `gh-token-client.ts` so a second in-sandbox entry can
// reach a gh token without also pulling in the gh-argv target resolver and its `git remote` probe.
// Node builtins only: every consumer of this file is bundled into the runtime image.
import { createConnection } from 'node:net'
import { GITCRED_CAPABILITY_ENV } from './env.js'

export interface GitCredIpcReply {
  ok: boolean
  password?: string
  error?: string
}

/** One newline-delimited-JSON round trip on the gitcred socket. Never rejects: an unreachable
 *  daemon is an answer (`ok:false`), and callers report it as data. */
export function gitcredIpc(path: string, msg: unknown): Promise<GitCredIpcReply> {
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
        resolve(JSON.parse(buf.slice(0, nl)) as GitCredIpcReply)
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
  const res = await gitcredIpc(args.socketPath, {
    op: 'get',
    agentId: args.agentId,
    capability: args.capability ?? env[GITCRED_CAPABILITY_ENV],
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
