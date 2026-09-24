import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { microsandboxGitRunner } from '../src/microsandbox/git.js'
import type { ShimRequester } from '../src/shim/channels.js'
import { createExecHandler } from '../src/shim/exec-handler.js'
import { GitExecError, type GitExecPayload } from '../src/shim/git-exec.js'
import { GitTransportError } from '../src/workspace/git-runner.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function repository(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ac-microsandbox-git-')))
  roots.push(root)
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: root, stdio: 'ignore' })
  writeFileSync(join(root, 'file with spaces.txt'), 'untracked\n')
  return root
}

// The VM's bound shim, served by the exec handler that ships in it, as the local executor's `withEnvironment` hands it over.
function vm(root: string, seen: { capability: string; payload: GitExecPayload; abort?: AbortSignal }[] = []) {
  const handle = createExecHandler({ workspaceRoot: root, log: { info: () => {}, warn: () => {} } })
  const session: ShimRequester = {
    request: async (capability, payload, options) => {
      seen.push({ capability, payload: payload as GitExecPayload, abort: options?.abort })
      return handle(capability, payload, options?.abort)
    }
  }
  return <T>(work: (bound: ShimRequester) => Promise<T>): Promise<T> => work(session)
}

describe.skipIf(process.platform === 'win32')('microsandbox Git over the VM shim', () => {
  it('runs on the exec channel with the launch guest paths over a caller replacement env', async () => {
    const root = repository()
    const seen: Parameters<typeof vm>[1] = []
    const abort = new AbortController()
    const launchEnv = {
      HOME: join(root, '.home'),
      PATH: process.env.PATH!,
      XDG_CONFIG_HOME: join(root, '.config'),
      AC_GITCRED_SOCKET: '/run/agentconnect/gitcred.sock',
      LAUNCH_ONLY: '1'
    }
    const runner = microsandboxGitRunner({
      run: vm(root, seen),
      cwd: root,
      env: launchEnv,
      abort: abort.signal
    })
    expect((await runner.status()).current).toBe('main')
    expect(seen.at(-1)).toMatchObject({
      capability: 'exec',
      payload: { cwd: root, env: launchEnv },
      abort: abort.signal
    })
    const caller = {
      HOME: '/host/home',
      PATH: '/host/bin',
      XDG_CONFIG_HOME: '/host/config',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null'
    }
    const status = await runner.withEnv(caller).status()
    expect(status.files).toEqual([{ path: 'file with spaces.txt', index: '?', working_dir: '?' }])
    expect(seen.at(-1)!.payload.env).toEqual({
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      HOME: launchEnv.HOME,
      PATH: launchEnv.PATH,
      XDG_CONFIG_HOME: launchEnv.XDG_CONFIG_HOME,
      AC_GITCRED_SOCKET: launchEnv.AC_GITCRED_SOCKET
    })
  })

  it('keeps the shim output limit a bounded overflow', async () => {
    const root = repository()
    const env = { PATH: process.env.PATH!, GIT_CONFIG_GLOBAL: '/dev/null' }
    const identity = ['-c', 'user.name=T', '-c', 'user.email=t@example.test']
    execFileSync('git', [...identity, 'commit', '--allow-empty', '-q', '-m', 'x'.repeat(70_000)], { cwd: root })
    const runner = microsandboxGitRunner({ run: vm(root), cwd: root, env })
    expect(await runner.readBounded(['log', '--max-count=1', '--format=%B'], 16)).toEqual({
      out: Buffer.alloc(0),
      overflow: true
    })
  })

  it('reports a VM it could not reach as transport, and the shim answers as they came', async () => {
    const root = repository()
    const env = { PATH: process.env.PATH! }
    const unreachable = microsandboxGitRunner({
      run: async () => {
        throw new Error('microsandbox environment agent/session-000000000000000000000000 is stopping')
      },
      cwd: root,
      env
    })
    await expect(unreachable.status()).rejects.toBeInstanceOf(GitTransportError)
    const runner = microsandboxGitRunner({ run: vm(root), cwd: root, env })
    const escape = runner.raw(['clone', '--shared', root, '../escaped'])
    await expect(escape).rejects.toThrow('path escapes the workspace root')
    await expect(escape).rejects.not.toBeInstanceOf(GitTransportError)
    await expect(runner.raw(['rev-parse', '--verify', 'missing'])).rejects.toBeInstanceOf(GitExecError)
  })
})
