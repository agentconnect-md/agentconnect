import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from '../src/daemon.js'
import { SANDBOX_BOOTSTRAP_NOTICE } from '../src/daemon/constants.js'
import { LocalMemoryFs } from '../src/memory/fs.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'

/**
 * The sandbox-bootstrap notice (#1475), on the legacy (non-streaming) pipeline. A cluster turn
 * whose agent has no attached shim session must bring a pod up first — up to a minute and a half
 * of silence with nothing to read as progress — and the daemon says so before the wait. On a
 * turn-bar platform (Slack) the wait rides the per-turn status bar and posts NO extra message; on
 * an on-demand chat platform it is a message of its own. Either label then retires to
 * "is thinking…" once the wait is over — even on a warm host, because a suspended pod drops its
 * channel while `hostStarts` still holds the agent. The webchat `notice` event is covered in
 * daemon-webchat.test.ts.
 */

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

/** A cluster daemon whose agent has no bound pod: the one plane fact the notice is decided on. */
function coldSandbox(daemon: Daemon): void {
  ;(daemon as unknown as { k8sPlane: unknown }).k8sPlane = {
    runsInSandbox: () => false,
    withSandbox: (_id: string, work: () => Promise<unknown>) => work(),
    ensureChannel: async () => {},
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

describe('sandbox-bootstrap notice on the legacy pipeline', () => {
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

    expect(statuses).toContain('is allocating a sandbox pod…')
    // Slack is turn-bar: the label rides the status bar, so no second message says the same thing.
    expect(conn.postMessage).not.toHaveBeenCalledWith('C1', SANDBOX_BOOTSTRAP_NOTICE, expect.anything())
    // The label does not outlive the wait it names — the row retires to "is thinking…".
    expect(statuses.filter((text) => text !== '').at(-1)).toBe('is thinking…')
    await daemon.stop()
  })

  it('retires the bootstrap label to "is thinking…" on a warm-host turn that still has no pod', async () => {
    // The transition must not depend on the host being cold: a suspended pod drops its channel
    // while `hostStarts` still holds the agent, which is a bootstrap turn with a warm host.
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

    expect(statuses).toContain('is allocating a sandbox pod…')
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
      postMessage: vi.fn(async () => 'm1')
    }
    vi.spyOn(daemon as never as { replyConnFor: () => unknown }, 'replyConnFor').mockReturnValue(conn)

    await (daemon as never as Dispatchable).dispatch('bot-a', chatMsg('telegram', '1'))

    expect(conn.postMessage).toHaveBeenCalledWith('C1', SANDBOX_BOOTSTRAP_NOTICE, 'T1')
    await daemon.stop()
  })
})
