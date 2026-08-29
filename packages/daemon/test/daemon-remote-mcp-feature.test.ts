import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WEBCHAT_REMOTE_MCP_FEATURE } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'

const AGENT_ID = 'bot-a'

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-rmcp-feat-'))
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
      runInSandbox: true,
      workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
      integrations: [],
      output: { mode: 'medium' }
    })
  )
  return root
}

async function registrationFeatures(withGrantDelivery: boolean): Promise<string[]> {
  const daemon = new Daemon({
    root: scaffold(),
    hostFactory: () => ({ start: vi.fn(async () => {}), stop: vi.fn(async () => {}) }) as never
  })
  await daemon.start()
  const anyDaemon = daemon as never as Record<string, any>
  if (withGrantDelivery) anyDaemon.remoteWebchatGrants = { revokeAll: vi.fn(async () => {}) }
  const features = anyDaemon.registrationFeatures()
  await daemon.stop().catch(() => {})
  return features
}

describe('registrationFeatures — webchat_remote_mcp_v1', () => {
  it('advertises descriptor delivery independently of runtime probes and sandbox mode', async () => {
    expect(await registrationFeatures(true)).toContain(WEBCHAT_REMOTE_MCP_FEATURE)
  })

  it('does not advertise when confidential grant delivery is unavailable', async () => {
    expect(await registrationFeatures(false)).not.toContain(WEBCHAT_REMOTE_MCP_FEATURE)
  })
})
