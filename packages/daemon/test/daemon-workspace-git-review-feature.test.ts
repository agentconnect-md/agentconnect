import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TASK_LIST_FEATURE,
  AGENT_WAKE_FEATURE,
  WORKSPACE_GIT_MESSAGE_FEATURE,
  WORKSPACE_GIT_REVIEW_FEATURE,
  WORKSPACE_GIT_V1_FEATURE,
  WORKSPACE_GIT_WRITE_FEATURE,
  WORKSPACE_REPO_SCOPE_FEATURE
} from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'

// The CP refuses to send `workspace/gitdiff` / `workspace/gitlog` to a daemon that
// does not advertise this marker, because an older daemon drops an unknown frame
// silently and the REQ would surface as an offline daemon after its whole
// retransmit budget. So the marker is the wiring, and it is asserted here.
const AGENT_ID = 'bot-a'

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-gitreview-feat-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { 'arbitrary-acp': { command: 'node', args: ['unused'] } }
    })
  )
  const adir = join(root, 'agents', AGENT_ID)
  mkdirSync(adir, { recursive: true })
  writeFileSync(
    join(adir, 'agent.json'),
    JSON.stringify({
      id: AGENT_ID,
      name: AGENT_ID,
      status: 'active',
      runtime: 'arbitrary-acp',
      builtin: true,
      workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
      integrations: [],
      output: { mode: 'medium' }
    })
  )
  return root
}

describe('registrationFeatures — the console dock reads (git review + write + AI message + tasks)', () => {
  it('advertises the git reads, writes AND the message pass unconditionally (daemon code, not a runtime probe)', async () => {
    const daemon = new Daemon({
      root: scaffold(),
      hostFactory: () => ({ start: vi.fn(async () => {}), stop: vi.fn(async () => {}) }) as never
    })
    await daemon.start()
    const features = (daemon as never as Record<string, any>).registrationFeatures() as string[]
    await daemon.stop().catch(() => {})
    expect(features).toContain(WORKSPACE_GIT_REVIEW_FEATURE)
    // Same reasoning for the writes: without the marker the CP must refuse to send the frame, and
    // the console renders the stage/commit controls as absent rather than inert.
    expect(features).toContain(WORKSPACE_GIT_WRITE_FEATURE)
    // The wand is gated separately: it is not a write, and whether the agent's RUNTIME can actually
    // draft a message is data the pass reports — not something a register-time flag can promise.
    expect(features).toContain(WORKSPACE_GIT_MESSAGE_FEATURE)
    // `task/list` is likewise unconditional daemon code — whether the agent's runtime actually
    // emits the SDK lifecycle feed is data the REP reports (`tracked`), not a register-time promise.
    expect(features).toContain(TASK_LIST_FEATURE)
    // The console's repo scope is likewise unconditional daemon code: whether the agent HAS an
    // additional repository is its spec's business, not something the handshake can promise.
    expect(features).toContain(WORKSPACE_REPO_SCOPE_FEATURE)
    // The sandbox wake is the one dock read that is NOT unconditional: a local daemon has nothing to wake.
    expect(features).not.toContain(AGENT_WAKE_FEATURE)
  }, 20_000)
})

// git-workspace-model.md §8: the `git` arm is FRAME-FATAL without this bit, so it is what lets the CP stop dual-encoding.
describe('registrationFeatures — the host-neutral workspace arm', () => {
  it('advertises workspace-git-v1 so the CP may project the `git` arm to this daemon', async () => {
    const daemon = new Daemon({
      root: scaffold(),
      hostFactory: () => ({ start: vi.fn(async () => {}), stop: vi.fn(async () => {}) }) as never
    })
    await daemon.start()
    const features = (daemon as never as Record<string, any>).registrationFeatures() as string[]
    await daemon.stop().catch(() => {})
    expect(features).toContain(WORKSPACE_GIT_V1_FEATURE)
  }, 20_000)
})
