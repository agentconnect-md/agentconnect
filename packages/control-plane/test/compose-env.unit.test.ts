/**
 * The documented self-host deployment enumerates each service's environment, so
 * a new variable is silently absent there even when the code reads it.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const compose = readFileSync(fileURLToPath(new URL('../../../compose.yaml', import.meta.url)), 'utf8')

/** The `environment:` entries of one compose service. */
function serviceEnv(name: string): string[] {
  const service = compose.split(new RegExp(`^  ${name}:$`, 'm'))[1]
  if (service === undefined) throw new Error(`service ${name} not found in compose.yaml`)
  const block = service.split(/^  \S/m)[0] ?? ''
  const env = block.split(/^ {4}environment:$/m)[1]
  if (env === undefined) throw new Error(`service ${name} has no environment block`)
  const entries = env.split(/^ {4}\S/m)[0] ?? ''
  return (entries.match(/^ {6}- ([A-Z0-9_]+)/gm) ?? []).map((line) => line.replace(/^ {6}- /, '').trim())
}

describe('compose.yaml service environment', () => {
  it('passes self-hosted preset and platform Slack configuration to the control plane', () => {
    expect(serviceEnv('control-plane')).toEqual(
      expect.arrayContaining([
        'PRESET_AGENTS_ENABLED',
        'SLACK_PLATFORM_APP_ID',
        'SLACK_PLATFORM_CLIENT_ID',
        'SLACK_PLATFORM_CLIENT_SECRET',
        'SLACK_PLATFORM_SIGNING_SECRET'
      ])
    )
  })

  it('passes SOCIAL_PROVIDERS to the console, which owns the decision', () => {
    expect(serviceEnv('web')).toContain('SOCIAL_PROVIDERS')
  })

  it('passes the Computer viewer TURN settings through for compose.turn.yaml to fill', () => {
    expect(serviceEnv('control-plane')).toEqual(
      expect.arrayContaining(['COMPUTER_TURN_URLS', 'COMPUTER_TURN_SECRET', 'COMPUTER_TURN_TTL_SEC'])
    )
    expect(compose).not.toMatch(/COMPUTER_TURN_SECRET\s*=/)
    const turn = readFileSync(fileURLToPath(new URL('../../../compose.turn.yaml', import.meta.url)), 'utf8')
    expect(turn).toMatch(/^ {6}- COMPUTER_TURN_URLS=turn:\S+\?transport=udp,turn:\S+\?transport=tcp$/m)
    expect(turn).toMatch(/^ {6}- COMPUTER_TURN_SECRET=\$\{AGENTCONNECT_TURN_SECRET\}$/m)
    // Relay-only UDP peers reach only this host's external IP and the container, so the server is no proxy into the network.
    expect(turn).toContain('--denied-peer-ip=0.0.0.0-255.255.255.255')
    expect(turn).toMatch(/^ {6}- --no-tcp-relay$/m)
  })

  it('has compose.stun.yaml run STUN on the relay and advertise this host’s public address', () => {
    const stun = readFileSync(fileURLToPath(new URL('../../../compose.stun.yaml', import.meta.url)), 'utf8')
    expect(stun).toMatch(/^ {6}- RELAY_STUN_PORT=3478$/m)
    expect(stun).toMatch(
      /^ {6}- RELAY_STUN_URL=stun:\$\{AGENTCONNECT_STUN_HOST:\?[^}]+\}:\$\{AGENTCONNECT_STUN_PORT:-3479\}$/m
    )
    expect(stun).toMatch(/^ {6}- \$\{AGENTCONNECT_STUN_PORT:-3479\}:3478\/udp$/m)
  })

  it('has compose.relay-turn.yaml run TURN on the relay and advertise this host’s UDP and TCP addresses', () => {
    const turn = readFileSync(fileURLToPath(new URL('../../../compose.relay-turn.yaml', import.meta.url)), 'utf8')
    expect(turn).toMatch(/^ {6}- RELAY_TURN_PORT=3480$/m)
    expect(turn).toMatch(
      /^ {6}- RELAY_TURN_URLS=turn:\$\{AGENTCONNECT_RELAY_TURN_HOST:\?[^}]+\}:\$\{AGENTCONNECT_RELAY_TURN_PORT:-3480\}\?transport=udp,turn:\$\{AGENTCONNECT_RELAY_TURN_HOST\}:\$\{AGENTCONNECT_RELAY_TURN_PORT:-3480\}\?transport=tcp$/m
    )
    expect(turn).toMatch(/^ {6}- \$\{AGENTCONNECT_RELAY_TURN_PORT:-3480\}:3480\/udp$/m)
    expect(turn).toMatch(/^ {6}- \$\{AGENTCONNECT_RELAY_TURN_PORT:-3480\}:3480\/tcp$/m)
    // No secret in the file: the Control Plane hands the relay the one it mints credentials from.
    expect(turn).not.toMatch(/SECRET/)
  })

  it('passes the usage batch-ingress credential through without inventing a default', () => {
    // Bare passthrough, NOT `=${...:-default}`: a stock default would stand up an
    // authenticated write endpoint, with a published token, on every local stack.
    expect(serviceEnv('control-plane')).toContain('USAGE_INGEST_TOKEN')
    expect(compose).not.toMatch(/USAGE_INGEST_TOKEN\s*=/)
  })
})
