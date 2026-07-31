import { describe, expect, it } from 'vitest'
import { DELEGATED_MCP_ASSERTION_FEATURE } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'

function features(input: {
  platform: NodeJS.Platform
  mechanism: 'bwrap' | null
  requireSandbox: boolean
  completePath: boolean
}): string[] {
  const daemon = new Daemon({
    platform: input.platform,
    sandboxMechanism: input.mechanism
  })
  ;(daemon as any).cfg = { security: { requireSandbox: input.requireSandbox } }
  if (input.completePath) {
    ;(daemon as any).delegatedMcpBroker = {}
    ;(daemon as any).delegatedWebchatHosts = {}
  }
  return (daemon as any).registrationFeatures()
}

describe('delegated MCP daemon capability', () => {
  it('advertises only when the complete daemon-wide bwrap path is ready', () => {
    expect(
      features({
        platform: 'linux',
        mechanism: 'bwrap',
        requireSandbox: true,
        completePath: true
      })
    ).toContain(DELEGATED_MCP_ASSERTION_FEATURE)
  })

  it.each([
    ['optional sandbox policy', 'linux', 'bwrap', false, true],
    ['non-Linux host', 'darwin', 'bwrap', true, true],
    ['missing bwrap', 'linux', null, true, true],
    ['incomplete broker/host path', 'linux', 'bwrap', true, false]
  ] as const)('omits the capability for %s', (_label, platform, mechanism, requireSandbox, completePath) => {
    expect(features({ platform, mechanism, requireSandbox, completePath })).not.toContain(
      DELEGATED_MCP_ASSERTION_FEATURE
    )
  })
})
