import { fork, spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detectSandbox } from '../src/acp/sandbox.js'

const workerFile = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/skill-workspace-lock-worker.ts')

// Exercise the same live Linux SRT/bwrap boundary as sandbox.test.ts. macOS
// sandbox coverage is deferred to the SRT platform-support follow-up.
const hasBwrap = detectSandbox() === 'bwrap'

describe.skipIf(!hasBwrap)('cross-process skill workspace lock', () => {
  let root: string
  let cwd: string
  let stateDir: string
  const children = new Set<ChildProcess>()

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ac-skill-lock-'))
    cwd = join(root, 'workspace')
    stateDir = join(root, 'state')
    await mkdir(cwd)
  })

  afterEach(async () => {
    for (const child of children) child.kill('SIGKILL')
    await Promise.all([...children].map((child) => waitForExit(child).catch(() => undefined)))
    await rm(root, { recursive: true, force: true })
  })

  const start = (mode = 'hold', extraArgs: string[] = []): ChildProcess => {
    const child = fork(workerFile, [mode, cwd, stateDir, ...extraArgs], {
      // `--conditions development` so the forked worker resolves workspace
      // packages (e.g. @agentconnect.md/protocol) to their src entry, matching
      // how vitest runs the suite. Without it the worker resolves the `import`
      // export to dist/, which is unbuilt in CI (ERR_MODULE_NOT_FOUND).
      execArgv: ['--import', 'tsx', '--conditions', 'development'],
      // Capture the worker's stderr so an unexpected crash surfaces its cause
      // instead of a bare "exited before <x>" (the sandbox path only runs on CI).
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    })
    const stderr: string[] = []
    ;(child as unknown as { capturedStderr: string[] }).capturedStderr = stderr
    child.stderr?.on('data', (chunk) => stderr.push(String(chunk)))
    children.add(child)
    child.once('exit', () => children.delete(child))
    return child
  }

  it('does not admit a contender while the committed owner process is stopped', async () => {
    const owner = start()
    await waitForMessage(owner, 'locked')
    process.kill(owner.pid!, 'SIGSTOP')
    const contender = start()

    await expectNoMessage(contender, 'locked', 750)

    process.kill(owner.pid!, 'SIGCONT')
    owner.send('release')
    await waitForMessage(owner, 'done')
    await waitForExit(owner)
    await waitForMessage(contender, 'locked')
    contender.send('release')
    await waitForMessage(contender, 'done')
  }, 120_000)

  it('atomically reclaims a lease after the exact owner process dies', async () => {
    const owner = start()
    await waitForMessage(owner, 'locked')
    owner.kill('SIGKILL')
    await waitForExit(owner)

    const contender = start()
    await waitForMessage(contender, 'locked')
    contender.send('release')
    await waitForMessage(contender, 'done')
  }, 120_000)

  it('keeps a dead owner fenced until its durably registered helper group exits', async () => {
    const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
      detached: true,
      stdio: 'ignore'
    })
    if (!helper.pid) throw new Error('missing helper pid')
    children.add(helper)
    helper.once('exit', () => children.delete(helper))
    const owner = start('helper-crash', [String(helper.pid)])
    const message = await waitForMessage(owner, 'helper')
    const pgid = Number(message.pgid)
    expect(pgid).toBeGreaterThan(0)
    await waitForExit(owner)

    const contender = start()
    await expectNoMessage(contender, 'locked', 750)

    process.kill(-pgid, 'SIGKILL')
    await waitForExit(helper)
    await waitForMessage(contender, 'locked')
    contender.send('release')
    await waitForMessage(contender, 'done')
  }, 120_000)

  it('persists the first agent authority across processes before any skills exist', async () => {
    const owner = start('claim', ['agent-a'])
    await waitForMessage(owner, 'claimed')
    await waitForExit(owner)

    const contender = start('claim', ['agent-b'])
    const rejected = await waitForMessage(contender, 'claim-error')
    expect(rejected.error).toMatch(/belongs to another agent \(agent-a\)/)
    await waitForExit(contender)
  }, 120_000)
})

function workerStderr(child: ChildProcess): string {
  const captured = (child as unknown as { capturedStderr?: string[] }).capturedStderr ?? []
  const text = captured.join('').trim()
  return text ? `\n--- worker stderr ---\n${text.slice(-2000)}` : ''
}

function waitForMessage(child: ChildProcess, type: string, timeoutMs = 60_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => finish(new Error(`timed out waiting for ${type}${workerStderr(child)}`)),
      timeoutMs
    )
    const onMessage = (message: unknown): void => {
      if (isMessage(message) && message.type === type) finish(undefined, message)
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(new Error(`worker exited before ${type}: code=${code} signal=${signal}${workerStderr(child)}`))
    }
    const finish = (error?: Error, message?: Record<string, unknown>): void => {
      clearTimeout(timeout)
      child.off('message', onMessage)
      child.off('exit', onExit)
      if (error) reject(error)
      else resolve(message!)
    }
    child.on('message', onMessage)
    child.on('exit', onExit)
  })
}

async function expectNoMessage(child: ChildProcess, type: string, durationMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(finish, durationMs)
    const onMessage = (message: unknown): void => {
      if (isMessage(message) && message.type === type) finish(new Error(`unexpected ${type}`))
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(new Error(`worker exited while waiting: code=${code} signal=${signal}`))
    }
    function finish(error?: Error): void {
      clearTimeout(timeout)
      child.off('message', onMessage)
      child.off('exit', onExit)
      if (error) reject(error)
      else resolve()
    }
    child.on('message', onMessage)
    child.on('exit', onExit)
  })
}

function waitForExit(child: ChildProcess, timeoutMs = 60_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('timed out waiting for worker exit')), timeoutMs)
    const onExit = (): void => finish()
    function finish(error?: Error): void {
      clearTimeout(timeout)
      child.off('exit', onExit)
      if (error) reject(error)
      else resolve()
    }
    child.on('exit', onExit)
  })
}

function isMessage(value: unknown): value is Record<string, unknown> & { type: string } {
  return !!value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string'
}
