import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WEBCHAT_REMOTE_MCP_FEATURE } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'

/**
 * `webchat_remote_mcp_v1` advertisement (registrationFeatures): the static
 * builtin-agent path must open the feature WITHOUT a probe round — register
 * runs before the probe sweep, so a freshly started daemon would otherwise
 * never advertise it on its first connection — while keeping the §13
 * provenance gate: only a builtin (preset) agent whose runtime resolves to the
 * validated adapter artifact under daemon-owned catalog provenance qualifies.
 */

const AGENT_ID = 'bot-a'

function scaffold(agent: { builtin?: boolean }): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-rmcp-feat-'))
  writeFileSync(join(root, 'config.json'), JSON.stringify({ version: 1, controlPlane: { enabled: false } }))
  const adir = join(root, 'agents', AGENT_ID)
  mkdirSync(adir, { recursive: true })
  writeFileSync(
    join(adir, 'agent.json'),
    JSON.stringify({
      id: AGENT_ID,
      name: AGENT_ID,
      status: 'active',
      runtime: 'claude-acp',
      ...(agent.builtin !== undefined ? { builtin: agent.builtin } : {}),
      workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
      integrations: [],
      output: { mode: 'medium' }
    })
  )
  return root
}

async function featuresWith(opts: { builtin?: boolean; source?: 'registry' | 'user'; probed?: boolean }) {
  const host = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {})
  }
  const daemon = new Daemon({ root: scaffold({ builtin: opts.builtin }), hostFactory: () => host as never })
  await daemon.start()
  const anyDaemon = daemon as never as Record<string, any>
  anyDaemon.remoteWebchatGrants = {} // presence-gated; the manager itself is not exercised here
  const source = opts.source ?? 'registry'
  const runtime =
    source === 'registry'
      ? { command: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp@0.64.0'], env: [] }
      : { command: 'node', args: ['unused'], env: [] }
  anyDaemon.runtimeCatalog.entries['claude-acp'] = { runtime, source, name: 'Claude Agent', version: '0.64.0' }
  if (opts.probed) anyDaemon.runtimeMcpCaps.set('claude-acp', { http: true, sse: false })
  const features: string[] = anyDaemon.registrationFeatures()
  await daemon.stop().catch(() => {})
  return features
}

describe('registrationFeatures — webchat_remote_mcp_v1', () => {
  it('opens on a synced builtin agent with a validated registry launch, before any probe', async () => {
    const features = await featuresWith({ builtin: true })
    expect(features).toContain(WEBCHAT_REMOTE_MCP_FEATURE)
  }, 20_000)

  it('stays closed when the agent is not builtin and no probe has run', async () => {
    const features = await featuresWith({ builtin: false })
    expect(features).not.toContain(WEBCHAT_REMOTE_MCP_FEATURE)
  }, 20_000)

  it('stays closed for a builtin agent on a user-configured (unvalidated) launch', async () => {
    const features = await featuresWith({ builtin: true, source: 'user' })
    expect(features).not.toContain(WEBCHAT_REMOTE_MCP_FEATURE)
  }, 20_000)

  it('the probed path still opens the feature without any builtin agent', async () => {
    const features = await featuresWith({ builtin: false, probed: true })
    expect(features).toContain(WEBCHAT_REMOTE_MCP_FEATURE)
  }, 20_000)
})
