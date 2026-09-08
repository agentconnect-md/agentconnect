import { execFile, execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_FRAME_BYTES, type MemoryFsPayload } from '@agentconnect.md/protocol'
import {
  MICROSANDBOX_GUEST_ENTRY,
  MICROSANDBOX_NODE,
  microsandboxGitRunner,
  microsandboxWorkspaceFs,
  type MicrosandboxExecute
} from '../src/microsandbox/guest.js'
import { GitTransportError } from '../src/workspace/git-runner.js'
import { MicrosandboxWorkspaceFs } from '../src/microsandbox/workspace-fs.js'
import { applyMemoryFsPayload } from '../src/shim/memory-fs-channel.js'
import { ShimChannelLostError } from '../src/shim/channels.js'
import { pathExecutor } from './fixtures/memory-fs-pod.js'

const roots: string[] = []
const entry = fileURLToPath(new URL('../src/microsandbox/guest-cli.ts', import.meta.url))

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
  expect(command).toBe(MICROSANDBOX_NODE)
  expect(args[0]).toBe(MICROSANDBOX_GUEST_ENTRY)
  expect(options?.maxBytes).toBe(MAX_FRAME_BYTES)
  return await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['--conditions=development', '--import', 'tsx', entry, ...args.slice(1)],
      {
        encoding: 'utf8',
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

describe('microsandbox guest Git process', () => {
  it('keeps host reads while routing active-VM mutations through the existing workspace protocol', async () => {
    const root = repository()
    const requests: MemoryFsPayload[] = []
    const executor = pathExecutor()
    let active = false
    let unavailable = false
    const guest = microsandboxWorkspaceFs({
      workspaceRoot: root,
      execute: async (command, args, options) => {
        expect(command).toBe(MICROSANDBOX_NODE)
        expect(args[0]).toBe(MICROSANDBOX_GUEST_ENTRY)
        expect(options?.maxBytes).toBe(MAX_FRAME_BYTES)
        if (unavailable) throw new Error('VM stopped')
        const request = JSON.parse(args[1]!)
        expect(request.capability).toBe('read')
        expect(request.workspaceRoot).toBe(root)
        requests.push(request.payload)
        const reply = await applyMemoryFsPayload(request.payload, root, executor)
        return { exitCode: 0, stdout: JSON.stringify(reply), stderr: '' }
      }
    })
    const fs = new MicrosandboxWorkspaceFs(() => (active ? guest : undefined))
    const staging = join(root, 'staging')
    const published = join(root, 'published')
    await fs.mkdir(staging, 0o700)
    await fs.writeFile(join(staging, 'marker'), 'before VM')
    expect(requests).toEqual([])

    active = true
    await fs.rename(staging, published)
    await fs.mkdir(join(published, 'empty'))
    await fs.writeFile(join(published, 'marker'), 'from VM', { mode: 0o600 })
    expect(requests.map((request) => request.op)).toEqual([
      'memory-rename',
      'memory-mkdir',
      'memory-append',
      'memory-commit'
    ])
    expect(await fs.stat(published)).toBe('dir')
    expect(await fs.readFile(join(published, 'marker'))).toBe('from VM')
    expect(await fs.readdir(published)).toEqual(['empty', 'marker'])
    expect(requests).toHaveLength(4)
    expect(await fs.rmdir(published)).toBe(false)
    expect(await fs.rmdir(join(published, 'empty'))).toBe(true)
    await fs.rmTree(published)
    expect(await fs.stat(published)).toBe('missing')

    unavailable = true
    await expect(fs.mkdir(published)).rejects.toBeInstanceOf(ShimChannelLostError)
    expect(await fs.stat(published)).toBe('missing')
    const refused = await executeLocally(
      MICROSANDBOX_NODE,
      [
        MICROSANDBOX_GUEST_ENTRY,
        JSON.stringify({ workspaceRoot: root, capability: 'read', payload: { op: 'memory-stat', root, rel: '..' } })
      ],
      { maxBytes: MAX_FRAME_BYTES }
    )
    expect(refused.exitCode).toBe(0)
    expect(JSON.parse(refused.stdout)).toMatchObject({ ok: false, refusal: { kind: 'path' } })
  })

  it('runs the shipped handler with argv JSON and retains environment, parsing, and output bounds', async () => {
    const root = repository()
    const abort = new AbortController()
    const sourceEnv = {
      PATH: '/host/toolchain/bin',
      HOME: '/host/home',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null'
    }
    const env = { ...sourceEnv, PATH: process.env.PATH ?? '', HOME: root }
    const execute: MicrosandboxExecute = async (command, args, options) => {
      const request = JSON.parse(args[1]!)
      expect(request.workspaceRoot).toBe(root)
      expect(request.payload.env).toEqual(env)
      expect(options?.env).toBeUndefined()
      expect(options?.abort).toBe(abort.signal)
      expect(options?.timeoutMs).toBe(135_000)
      return await executeLocally(command, args, options)
    }
    const runner = microsandboxGitRunner({
      execute,
      workspaceRoot: root,
      cwd: root,
      abort: abort.signal,
      env: { INITIAL_ENV_MUST_NOT_SURVIVE: '1' },
      mapEnv: (received) => {
        expect(received).toEqual(sourceEnv)
        return { ...received, PATH: env.PATH, HOME: root }
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

  it('preserves handler refusal and treats a missing or malformed process reply as transport failure', async () => {
    const root = repository()
    const runner = microsandboxGitRunner({ execute: executeLocally, workspaceRoot: root, cwd: root })
    await expect(runner.raw(['status', '-c', 'core.pager=unsafe'])).rejects.toThrow('argument -c is refused')
    const outside = microsandboxGitRunner({ execute: executeLocally, workspaceRoot: root, cwd: tmpdir() })
    await expect(outside.status()).rejects.toThrow('cwd escapes the workspace root')
    for (const execute of [
      async () => ({ exitCode: 0, stdout: 'not JSON', stderr: '' }),
      async () => ({ exitCode: 0, stdout: '{}', stderr: '' }),
      async () => {
        throw new Error('VM stopped')
      }
    ]) {
      await expect(microsandboxGitRunner({ execute, workspaceRoot: root }).status()).rejects.toBeInstanceOf(
        GitTransportError
      )
    }
  })
})
