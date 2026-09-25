import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hostKeyDirName, sessionHostKey, sessionKeyDirName } from '../src/acp/host-key.js'
import { Daemon } from '../src/daemon.js'
import { localSrtRuntimeRoot } from '../src/execution/srt-local.js'
import type { GitExecPayload } from '../src/shim/git-exec.js'
import { inProcessShimExecutor } from './fixtures/in-process-shim.js'

// session-executors.md §11 (R1b-2a): a confined srt session's workspace Git and files cross its shim; the agent's other roots stay on this disk.
const KEY = 'slack:T1:C1:1700000000.000100'
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function scaffold(execution: string): { root: string; agentDir: string; sessionDir: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ac-srt-ws-')))
  roots.push(root)
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: [] } }
    })
  )
  const agentDir = join(root, 'agents', 'bot-a')
  mkdirSync(join(agentDir, 'workspace'), { recursive: true })
  writeFileSync(
    join(agentDir, 'agent.json'),
    JSON.stringify({
      id: 'bot-a',
      name: 'bot-a',
      status: 'active',
      runtime: 'claude',
      execution,
      workspace: { mode: 'from-scratch', path: join(agentDir, 'workspace') },
      integrations: [],
      output: { mode: 'medium' }
    })
  )
  return { root, agentDir, sessionDir: join(agentDir, 'sessions', sessionKeyDirName(KEY)) }
}

async function started(execution: string) {
  const layout = scaffold(execution)
  const daemon = new Daemon({ root: layout.root, hostFactory: () => ({}) as never })
  await daemon.start()
  const d = daemon as any
  await vi.waitFor(() => expect(d.sessionRetentionSweepInFlight).toBe(false))
  // After the startup sweep, which retires a session directory the store has no row for.
  mkdirSync(join(layout.sessionDir, 'workspace'), { recursive: true })
  execFileSync('git', ['init', '-q', '--initial-branch=main'], { cwd: join(layout.sessionDir, 'workspace') })
  const executor = inProcessShimExecutor()
  d.localSrtExecutor = executor
  const stopMatching = vi.spyOn(d.localSrt, 'stopMatching')
  return { ...layout, daemon, d, executor, stopMatching }
}

describe.skipIf(process.platform === 'win32')("a confined srt session's workspace", () => {
  it("runs its Git in the session's shim with the boundary's own HOME, temp root and credential socket", async () => {
    const { daemon, d, executor, sessionDir, root } = await started('srt')
    try {
      const clone = join(sessionDir, 'workspace')
      const git = d.workspaces.runnerFor('bot-a', clone).withEnv({ PATH: process.env.PATH, HOME: '/host/home' })
      expect((await git.status()).current).toBe('main')
      const id = `bot-a/${sessionKeyDirName(KEY)}`
      const runtimeRoot = localSrtRuntimeRoot(root, id)
      // The session directory alone, which a runtime launched later widens by starting it again.
      expect(executor.withEnvironment.mock.calls[0]![0]).toEqual({
        id,
        workspaceRoot: sessionDir,
        mounts: [{ source: sessionDir, target: sessionDir, mode: 'writable' }]
      })
      const { env } = executor.seen.at(-1)!.payload as GitExecPayload
      expect(env).toMatchObject({
        HOME: join(sessionDir, 'home'),
        TMPDIR: join(runtimeRoot, 't'),
        AC_GITCRED_SOCKET: join(runtimeRoot, 'gitcred.sock')
      })
    } finally {
      await daemon.stop()
    }
  })

  it("reads its files through the shim, and keeps the agent's own roots and the session directory itself on this disk", async () => {
    const { daemon, d, executor, sessionDir, agentDir } = await started('srt')
    try {
      writeFileSync(join(sessionDir, 'workspace', 'a.txt'), 'content')
      const fs = d.workspaces.fsFor('bot-a', { sessionKey: KEY })
      expect(await fs.stat(join(sessionDir, 'workspace', 'a.txt'))).toBe('file')
      expect(executor.seen.map((entry) => entry.capability)).toEqual(['read'])
      expect(await fs.stat(sessionDir)).toBe('dir')
      expect(await d.workspaces.fsFor('bot-a').stat(join(agentDir, 'workspace'))).toBe('dir')
      expect((await d.workspaces.runnerFor('bot-a', join(agentDir, 'workspace')).raw(['init', '-q'])).length).toBe(0)
      expect(executor.seen).toHaveLength(1)
    } finally {
      await daemon.stop()
    }
  })

  it("retires the agent's other sessions' shims when its workspace is replaced", async () => {
    const { daemon, d, stopMatching } = await started('srt')
    try {
      await d.workspaces.planeFor({ agentId: 'bot-a' }).discardSessions('bot-a', sessionKeyDirName(KEY))
      const keep = stopMatching.mock.calls[0]![0] as (id: string) => boolean
      expect(keep(`bot-a/${sessionKeyDirName(KEY)}`)).toBe(false)
      expect(keep('bot-a/session-76543210fedcba9876543210')).toBe(true)
      expect(keep('bot-b/session-76543210fedcba9876543210')).toBe(false)
    } finally {
      await daemon.stop()
    }
  })

  // R1b-2b: every srt host runs in its own environment's shim, so the tool bridge it is handed dials that shim's `mcp` tunnel.
  it("hands each srt host the tool bridge on its own environment's tunnel: the shared host's, a confined session's, a pass's", async () => {
    const { daemon, d, root } = await started('srt')
    try {
      const agent = d.agents.get('bot-a')
      const tunnel = (id: string) => join(localSrtRuntimeRoot(root, id), 'mcp.sock')
      const specOf = (...args: unknown[]) => JSON.stringify(d.mcpToolServerSpec('token', agent, ...args))
      expect(specOf()).toContain(tunnel('bot-a/agent'))
      // A session its agent's shared host serves takes that host's, and an isolated one its own directory's once preparation records it.
      expect(specOf(KEY)).toContain(tunnel('bot-a/agent'))
      d.sessionIsolation.set(KEY, 'session')
      expect(specOf(KEY)).toContain(tunnel(`bot-a/${sessionKeyDirName(KEY)}`))
      const pass = sessionHostKey('bot-a', 'internal:bot-a:dream:example')
      expect(specOf(undefined, pass)).toContain(tunnel(`bot-a/${sessionKeyDirName('internal:bot-a:dream:example')}`))
      expect(specOf()).not.toContain(join(root, 'run', 'mcp.sock'))
    } finally {
      await daemon.stop()
    }
  })

  // A dream's host is one-off, so its shim goes when the extraction settles or fails to start, not at the idle sweep.
  it("stops a dream host's own shim when its environment is retired, and no other", async () => {
    const { daemon, d, stopMatching } = await started('srt')
    try {
      const dream = d.dreamOwnerKey('bot-a', 'dream-1')
      await d.discardDreamEnvironment(d.agents.get('bot-a'), dream)
      const matches = stopMatching.mock.calls.at(-1)![0] as (id: string) => boolean
      expect(matches(`bot-a/${hostKeyDirName(dream)}`)).toBe(true)
      expect(matches('bot-a/agent')).toBe(false)
      expect(matches(`bot-a/${sessionKeyDirName(KEY)}`)).toBe(false)
    } finally {
      await daemon.stop()
    }
  })

  it("leaves a host agent's session on this disk", async () => {
    const { daemon, d, executor, sessionDir } = await started('host')
    try {
      expect((await d.workspaces.runnerFor('bot-a', join(sessionDir, 'workspace')).status()).current).toBe('main')
      expect(await d.workspaces.fsFor('bot-a', { sessionKey: KEY }).stat(join(sessionDir, 'workspace'))).toBe('dir')
      expect(executor.withEnvironment).not.toHaveBeenCalled()
    } finally {
      await daemon.stop()
    }
  })
})
