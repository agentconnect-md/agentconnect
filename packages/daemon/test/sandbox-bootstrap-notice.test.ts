import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from '../src/daemon.js'
import { withStartupPhase } from '../src/session/startup-progress.js'
import { LocalMemoryFs } from '../src/memory/fs.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'

// Startup phases use one transient surface per turn.

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-sandbox-notice-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: ['unused'] } }
    })
  )
  const agentDir = join(root, 'agents', 'bot-a')
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(
    join(agentDir, 'agent.json'),
    JSON.stringify({
      id: 'bot-a',
      name: 'bot-a',
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: join(agentDir, 'workspace') },
      integrations: [],
      output: { mode: 'low' }
    })
  )
  return root
}

// Simulate the resource wait reported by the cluster driver.
function coldSandbox(daemon: Daemon): void {
  ;(daemon as unknown as { k8sPlane: unknown }).k8sPlane = {
    runsInSandbox: () => false,
    withSandbox: (_id: string, work: () => Promise<unknown>) => work(),
    ensureChannel: () => withStartupPhase('sandbox', async () => {}),
    workspaceRootFor: () => undefined,
    gitRunnerFor: () => undefined,
    workspaceFsFor: () => undefined,
    memoryFsFor: () => new LocalMemoryFs(mkdtempSync(join(tmpdir(), 'ac-sandbox-notice-mem-'))),
    autoMergeFor: () => undefined,
    releaseAgent: () => {},
    launched: () => [],
    stop: async () => {}
  }
}

function bootDaemon(root: string): Daemon {
  const host = {
    __started: true,
    start: vi.fn(async () => {}),
    newSession: vi.fn(async () => 'acp-1'),
    prompt: vi.fn(async () => 'end_turn'),
    cancel: vi.fn(),
    stop: vi.fn()
  }
  return new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, hostFactory: () => host as never } as never)
}

function chatMsg(platform: 'slack' | 'telegram', id: string): NormalizedMessage {
  return {
    msgId: `cron:${platform}:${id}`,
    traceId: id,
    source: 'cron',
    platform,
    channel: 'C1',
    thread: 'T1',
    sender: { id: 'cron:s', isBot: false },
    text: 'go',
    mentionedBots: [],
    isDm: false,
    trigger: 'cron'
  } as NormalizedMessage
}

type Dispatchable = { dispatch: (agentId: string, msg: NormalizedMessage) => Promise<unknown> }

describe('session startup notices', () => {
  it("narrates a cold sandbox on Slack's status bar and posts no message for it", async () => {
    const daemon = bootDaemon(scaffold())
    await daemon.start()
    coldSandbox(daemon)
    const statuses: string[] = []
    const conn = {
      setStatus: vi.fn(async (_c: string, _t: string, status: string) => void statuses.push(status)),
      postMessage: vi.fn(async () => undefined)
    }
    vi.spyOn(daemon as never as { replyConnFor: () => unknown }, 'replyConnFor').mockReturnValue(conn)

    await (daemon as never as Dispatchable).dispatch('bot-a', chatMsg('slack', '1'))

    expect(statuses).toContain('is starting a sandbox…')
    // Slack is turn-bar: the label rides the status bar, so no second message says the same thing.
    expect(conn.postMessage).not.toHaveBeenCalledWith('C1', '⏳ Starting sandbox…', expect.anything())
    // The label does not outlive the wait it names — the row retires to "is thinking…".
    expect(statuses.filter((text) => text !== '').at(-1)).toBe('is thinking…')
    await daemon.stop()
  })

  it('does not announce sandbox preparation when a warm turn does no preparation', async () => {
    // A fake plane reports no pod, but this warm turn never asks it to prepare one.
    const daemon = bootDaemon(scaffold())
    await daemon.start()
    coldSandbox(daemon)
    const statuses: string[] = []
    const conn = {
      setStatus: vi.fn(async (_c: string, _t: string, status: string) => void statuses.push(status)),
      postMessage: vi.fn(async () => undefined)
    }
    vi.spyOn(daemon as never as { replyConnFor: () => unknown }, 'replyConnFor').mockReturnValue(conn)

    await (daemon as never as Dispatchable).dispatch('bot-a', chatMsg('slack', '1')) // warms the host
    statuses.length = 0
    await (daemon as never as Dispatchable).dispatch('bot-a', chatMsg('slack', '2')) // warm host, still no pod

    expect(statuses).not.toContain('is starting a sandbox…')
    expect(statuses.filter((text) => text !== '').at(-1)).toBe('is thinking…')
    await daemon.stop()
  })

  it('posts the notice as its own message on an on-demand chat platform', async () => {
    const daemon = bootDaemon(scaffold())
    await daemon.start()
    coldSandbox(daemon)
    // Telegram is on-demand, not turn-bar, so the wait cannot ride a pushed status bar.
    const conn = {
      sendChatAction: vi.fn(async () => {}),
      postMessage: vi.fn(async () => 'm1'),
      updateMessage: vi.fn(async () => {}),
      deleteMessage: vi.fn(async () => true)
    }
    vi.spyOn(daemon as never as { replyConnFor: () => unknown }, 'replyConnFor').mockReturnValue(conn)

    await (daemon as never as Dispatchable).dispatch('bot-a', chatMsg('telegram', '1'))

    expect(conn.postMessage).toHaveBeenCalledTimes(1)
    expect(conn.updateMessage).toHaveBeenCalledWith('C1', 'm1', '⏳ Starting agent…', { threadTs: 'T1' })
    expect(conn.deleteMessage).toHaveBeenCalledWith('C1', 'm1', 'T1')
    await daemon.stop()
  })
})
