import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { microsandboxGitRunner } from '../src/microsandbox/git.js'
import type { MicrosandboxExecute } from '../src/microsandbox/exec.js'
import { GitExecError } from '../src/workspace/command-git-runner.js'
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

const executeLocally: MicrosandboxExecute = async (command, args, options) => {
  expect(command).toBe('/bin/sh')
  return await new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: 'utf8',
        cwd: options?.cwd,
        env: options?.env,
        timeout: options?.timeoutMs,
        signal: options?.abort,
        maxBuffer: options?.maxBytes
      },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') return reject(error)
        resolve({ exitCode: typeof error?.code === 'number' ? error.code : 0, stdout, stderr })
      }
    )
  })
}

describe.skipIf(process.platform === 'win32')('microsandbox native Git', () => {
  it('executes Git with mapped replacement environment, status parsing, and bounded reads', async () => {
    const root = repository()
    const abort = new AbortController()
    const sourceEnv = { HOME: '/home/agent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
    const env = { ...sourceEnv, HOME: root }
    const runner = microsandboxGitRunner({
      execute: async (command, args, options) => {
        expect(options?.env).toEqual(env)
        expect(options?.inheritEnv).toBe(false)
        expect(options?.abort).toBe(abort.signal)
        expect(options?.timeoutMs).toBe(120_000)
        return executeLocally(command, args, options)
      },
      workspaceRoot: root,
      cwd: root,
      abort: abort.signal,
      env: { INITIAL_ENV_MUST_NOT_SURVIVE: '1' },
      mapEnv: (received) => {
        expect(received).toEqual(sourceEnv)
        return { ...received, HOME: root }
      }
    }).withEnv(sourceEnv)
    const status = await runner.status()
    expect(status.current).toBe('main')
    expect(status.clean).toBe(false)
    expect(status.files).toEqual([{ path: 'file with spaces.txt', index: '?', working_dir: '?' }])
    const bounded = await runner.readBounded(['status', '--short'], 2)
    expect(bounded.out.byteLength).toBe(2)
    expect(bounded.overflow).toBe(true)
  })

  it('enforces argv and guest path boundaries without interpreting paths as shell source', async () => {
    const root = repository()
    const runner = microsandboxGitRunner({ execute: executeLocally, workspaceRoot: root, cwd: root })
    await expect(runner.raw(['status', '-c', 'core.pager=unsafe'])).rejects.toThrow('argument -c is refused')
    await expect(runner.raw(['clone', '--shared', root, '../escaped'])).rejects.toThrow('path escapes')
    await expect(runner.raw(['clone', '--shared', root, '../escaped'])).rejects.toBeInstanceOf(GitTransportError)
    const outside = repository()
    mkdirSync(`${root}\n`)
    roots.push(`${root}\n`)
    await expect(
      microsandboxGitRunner({ execute: executeLocally, workspaceRoot: `${root}\n`, cwd: root }).status()
    ).rejects.toThrow('cwd escapes')
    symlinkSync(outside, join(root, 'escape'))
    await expect(
      microsandboxGitRunner({ execute: executeLocally, workspaceRoot: root, cwd: join(root, 'escape') }).status()
    ).rejects.toThrow('cwd escapes')
    const target = join(root, 'spaces;$(touch marker)')
    await runner.clone(root, target)
    const nested = join(root, 'nested')
    mkdirSync(nested)
    await microsandboxGitRunner({ execute: executeLocally, workspaceRoot: root, cwd: nested }).clone(root, '../sibling')
    await expect(runner.raw(['rev-parse', '--verify', 'missing'])).rejects.toBeInstanceOf(GitExecError)
  })

  it('reports stream overflow and distinguishes VM failures from Git exit codes', async () => {
    const root = repository()
    const runner = microsandboxGitRunner({
      workspaceRoot: root,
      execute: async () => ({ exitCode: 0, stdout: 'x'.repeat(65_537), stderr: '' })
    })
    expect(await runner.readBounded(['status', '--short'], 2)).toEqual({ out: Buffer.alloc(0), overflow: true })
    await expect(
      microsandboxGitRunner({
        workspaceRoot: root,
        execute: async () => {
          throw new Error('VM stopped')
        }
      }).status()
    ).rejects.toBeInstanceOf(GitTransportError)
  })
})
