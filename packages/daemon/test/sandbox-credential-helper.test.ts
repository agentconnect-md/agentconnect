import { afterEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * REAL git, asking the in-sandbox helper for a credential, over a real socket.
 *
 * The parts were all testable in isolation and all passed while the feature did not exist, so this
 * asserts the join that matters in production: git reads a helper line naming the image's path, runs
 * that executable, and a token comes back over the gitcred wire protocol. Everything here is the
 * pod's side — the daemon's socket is stood in for by a server on a temp path, which is exactly what
 * the shim's tunnel presents to a pod.
 *
 * `git credential fill` is the invocation because that is what git itself runs: the helper is
 * spawned by git, handed the request on stdin, and its stdout is parsed by git rather than by us.
 *
 * Every child is spawned ASYNCHRONOUSLY, and that is load-bearing rather than stylistic:
 * `execFileSync` blocks this process's event loop, so the socket server below could not answer until
 * the child had already given up — a deadlock that reads exactly like a broken helper.
 */

const here = dirname(fileURLToPath(import.meta.url))
const helperEntry = join(here, '..', 'src', 'shim', 'git-credential.ts')

const dirs: string[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ac-podhelper-'))
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

/**
 * The image's `/opt/agentconnect/bin/git-credential`, reproduced for a source checkout.
 *
 * The image's wrapper execs `node <helper bundle> "$@"`; this one runs the same entry through tsx
 * because it is TypeScript here. What is under test either way is the argv contract and the
 * helper's behaviour.
 */
function helperWrapper(): string {
  const path = join(scratchDir(), 'git-credential')
  const tsx = createRequire(import.meta.url).resolve('tsx/cli')
  writeFileSync(path, `#!/bin/sh\nexec ${process.execPath} ${tsx} ${helperEntry} "$@"\n`)
  chmodSync(path, 0o755)
  return path
}

interface FillResult {
  stdout: string
  stderr: string
  status: number
}

/** `git credential fill` with the pointers the daemon writes for a pod, git's own exit included. */
function gitCredentialFill(options: {
  helper: string
  socketPath: string
  agentId: string
  request: string
  /** Extra env — the capability/identity pair the daemon mints at spawn. */
  env?: Record<string, string>
  /** Scope the helper to a host, as the real injection does; omit for a bare `credential.helper`. */
  scoped?: boolean
}): Promise<FillResult> {
  const scope = options.scoped === false ? 'credential.helper' : 'credential.https://github.com.helper'
  const args = [
    '-c',
    `${scope}=!'${options.helper}' ${options.agentId}`,
    ...(options.scoped === false ? [] : ['-c', 'credential.https://github.com.useHttpPath=true']),
    'credential',
    'fill'
  ]
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      args,
      {
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: scratchDir(),
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_TERMINAL_PROMPT: '0',
          AC_GITCRED_SOCKET: options.socketPath,
          ...options.env
        }
      },
      (err, stdout, stderr) => {
        const status = (err as (Error & { code?: number }) | null)?.code
        resolve({ stdout, stderr, status: typeof status === 'number' ? status : 0 })
      }
    )
    child.stdin?.end(options.request)
  })
}

describe('the credential helper the runtime image ships', () => {
  it('answers real git with a token fetched over the gitcred socket', async () => {
    const server = await gitcredServer(() => ({ ok: true, username: 'x-access-token', password: 'ghs_tunnelled' }))
    const result = await gitCredentialFill({
      helper: helperWrapper(),
      socketPath: server.path,
      agentId: 'agent-a',
      request: 'protocol=https\nhost=github.com\npath=acme/private.git\n\n'
    })

    expect(result.status).toBe(0)
    // git parsed the helper's stdout, which is the contract that actually matters here.
    expect(result.stdout).toContain('username=x-access-token')
    expect(result.stdout).toContain('password=ghs_tunnelled')
    // And the request carried the identity and the routing repo, not just a bare ask.
    expect(server.seen).toEqual([
      expect.objectContaining({ op: 'get', agentId: 'agent-a', repoFullName: 'acme/private' })
    ])
  }, 60_000)

  it('prefers the env identity over the id baked into the helper line', async () => {
    // A `.git/config` helper line outlives the agent that wrote it — deleted and recreated under the
    // same name leaves the DEAD id on disk — so the pair minted at spawn has to outrank it.
    const server = await gitcredServer(() => ({ ok: true, username: 'x-access-token', password: 'ghs_env' }))
    const result = await gitCredentialFill({
      helper: helperWrapper(),
      socketPath: server.path,
      agentId: 'stale-agent',
      request: 'protocol=https\nhost=github.com\n\n',
      env: { AC_GITCRED_AGENT: 'live-agent', AC_GITCRED_CAPABILITY: 'cap-live' }
    })

    expect(result.stdout).toContain('password=ghs_env')
    expect(server.seen).toEqual([expect.objectContaining({ op: 'get', agentId: 'live-agent', capability: 'cap-live' })])
  }, 60_000)

  it('fails loudly when the daemon denies the repo, instead of answering git with nothing', async () => {
    // An empty answer reads to git as "this helper has no opinion", and the operation then fails
    // against GitHub with a 403 that says nothing about authorization having been refused here.
    const server = await gitcredServer(() => ({ ok: false, error: 'repository not authorized for this agent' }))
    const result = await gitCredentialFill({
      helper: helperWrapper(),
      socketPath: server.path,
      agentId: 'agent-a',
      request: 'protocol=https\nhost=github.com\npath=acme/secret.git\n\n'
    })

    expect(result.status).not.toBe(0)
    expect(result.stdout).not.toContain('password=')
    expect(result.stderr).toContain('no git credentials for agent agent-a on acme/secret')
    expect(result.stderr).toContain('repository not authorized')
  }, 60_000)

  it('says why it cannot reach the daemon, rather than looking like a repo with no credentials', async () => {
    // In a pod this is the tunnel being absent — the exact state before the shim serves it — and the
    // message has to name the socket, because everything else about the failure looks like GitHub.
    const result = await gitCredentialFill({
      helper: helperWrapper(),
      socketPath: join(scratchDir(), 'never-served.sock'),
      agentId: 'agent-a',
      request: 'protocol=https\nhost=github.com\n\n'
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/cannot reach the daemon socket at .*never-served\.sock/)
  }, 60_000)

  it('stays silent for a host that is not github.com, so nothing is asked for it', async () => {
    const server = await gitcredServer(() => ({ ok: true, username: 'x-access-token', password: 'ghs_leak' }))
    // Configured unscoped on purpose: the helper must decline by the host git names, not by relying
    // on the config scope to have kept it away.
    const result = await gitCredentialFill({
      helper: helperWrapper(),
      socketPath: server.path,
      agentId: 'agent-a',
      request: 'protocol=https\nhost=gitlab.example\n\n',
      scoped: false
    })

    expect(result.stdout).not.toContain('ghs_leak')
    // Nothing was asked of the daemon at all: a github.com token must not be fetched for another host.
    expect(server.seen).toEqual([])
  }, 60_000)
})
