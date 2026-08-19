import { afterEach, describe, expect, it } from 'vitest'
import { execFile, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SANDBOX_TUNNEL_PATHS } from '../src/shim/sandbox-paths.js'

// The in-sandbox half of the gh wrapper, run the way the wrapper runs it (issue #457).
// A pod agent has no daemon on its filesystem, so every `gh` goes through this entry and the socket the shim tunnels.
// Asserted is the wrapper's contract, not the internals: the repo the resolver picked, `plane: 'gh'` with the launch
// capability, ONLY the token on stdout, and the three exit codes the sh branches on — 0 serve, 1 refuse, 2 not ours.
// Every child is spawned ASYNCHRONOUSLY: execFileSync blocks this process's event loop, so the socket server could
// not answer until the child had already given up — a deadlock that reads exactly like a broken entry.

const here = dirname(fileURLToPath(import.meta.url))
const entry = join(here, '..', 'src', 'shim', 'gh-token.ts')
const tsx = createRequire(import.meta.url).resolve('tsx/cli')

const dirs: string[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ac-ghtoken-'))
  dirs.push(dir)
  return dir
}

/** The daemon's gitcred.sock as the pod sees it: whatever the shim tunnels to. */
async function gitcredServer(
  reply: (request: Record<string, unknown>) => unknown
): Promise<{ path: string; seen: Array<Record<string, unknown>> }> {
  const path = join(scratchDir(), 'gitcred.sock')
  const seen: Array<Record<string, unknown>> = []
  const server = createServer((socket) => {
    let buffered = ''
    socket.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8')
      const newline = buffered.indexOf('\n')
      if (newline === -1) return
      const request = JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>
      seen.push(request)
      socket.write(`${JSON.stringify(reply(request))}\n`)
    })
    socket.on('error', () => undefined)
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(path, () => resolve()))
  return { path, seen }
}

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

/** Run the entry the way `/opt/agentconnect/pathbin/gh` does: `<agentId> -- <gh argv…>`. */
// The image runs a bundle with everything inlined; a source checkout runs the same entry through tsx, which
// resolves the workspace deps it imports. `--conditions=development` is what points those at their src/, the
// way vitest does — without it the child needs a dist/ that these suites deliberately never build.
function runEntry(
  ghArgv: string[],
  env: Record<string, string | undefined>,
  cwd = here,
  agentId = 'agent-1'
): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [tsx, entry, agentId, '--', ...ghArgv],
      {
        cwd,
        env: { PATH: process.env.PATH ?? '', NODE_OPTIONS: '--conditions=development', ...env } as NodeJS.ProcessEnv
      },
      (error, stdout, stderr) => {
        const code = error && typeof (error as { code?: unknown }).code === 'number' ? (error.code as number) : 0
        resolve({ code, stdout, stderr })
      }
    )
  })
}

describe('the in-sandbox gh token entry', () => {
  it('resolves the target repo from the argv and asks the tunnel for its token', async () => {
    const { path, seen } = await gitcredServer(() => ({ ok: true, username: 'x-access-token', password: 'ghs_pod' }))
    const result = await runEntry(['api', 'repos/acme/infra/pulls/64', '--jq', '.title'], {
      AC_GITCRED_SOCKET: path,
      AC_GITCRED_CAPABILITY: 'cap-agent-1'
    })

    expect(result.code).toBe(0)
    // Only the token, so the wrapper can put `$(…)` straight into GH_TOKEN.
    expect(result.stdout).toBe('ghs_pod')
    expect(seen).toEqual([
      { op: 'get', agentId: 'agent-1', capability: 'cap-agent-1', plane: 'gh', repoFullName: 'acme/infra' }
    ])
  })

  it('falls back to the origin remote of the directory gh ran in', async () => {
    const { path, seen } = await gitcredServer(() => ({ ok: true, username: 'x-access-token', password: 'ghs_cwd' }))
    const checkout = scratchDir()
    const git = (...args: string[]) => execFileSync('git', args, { cwd: checkout, stdio: 'ignore' })
    git('init', '--quiet')
    git('remote', 'add', 'origin', 'https://github.com/example-co/shared-library.git')

    const result = await runEntry(['pr', 'list'], { AC_GITCRED_SOCKET: path, AC_GITCRED_CAPABILITY: 'cap' }, checkout)

    expect(result.code).toBe(0)
    expect(seen[0]?.repoFullName).toBe('example-co/shared-library')
  })

  it('exits 1 with the daemon reason on stderr when the repo is refused', async () => {
    const { path } = await gitcredServer(() => ({ ok: false, error: 'repository acme/infra is not authorized' }))
    const result = await runEntry(['-R', 'acme/infra', 'pr', 'list'], {
      AC_GITCRED_SOCKET: path,
      AC_GITCRED_CAPABILITY: 'cap'
    })

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('no gh credentials for agent agent-1 on acme/infra')
    expect(result.stderr).toContain('repository acme/infra is not authorized')
  })

  it('exits 2 without asking anyone when the target is not on github.com', async () => {
    const { path, seen } = await gitcredServer(() => ({ ok: true, username: 'x-access-token', password: 'leaked' }))
    const result = await runEntry(['-R', 'git.example.test/acme/infra', 'pr', 'list'], {
      AC_GITCRED_SOCKET: path,
      AC_GITCRED_CAPABILITY: 'cap'
    })

    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
    expect(seen).toEqual([])
  })

  it('dials the shim tunnel when nothing names another socket', async () => {
    // The pod has no daemon root to derive a path from, so an absent AC_GITCRED_SOCKET must mean the tunnel and
    // not this daemon's own run dir. The path is absent here, which is exactly what makes it visible.
    const result = await runEntry(['-R', 'acme/infra', 'pr', 'list'], {
      AC_GITCRED_SOCKET: undefined,
      AC_GITCRED_CAPABILITY: 'cap'
    })

    expect(result.code).toBe(1)
    expect(result.stderr).toContain(`cannot reach the daemon socket at ${SANDBOX_TUNNEL_PATHS.gitcred}`)
  })
})
