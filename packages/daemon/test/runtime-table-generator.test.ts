import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ACP_AUTH_REQUIRED_CODE,
  buildTable,
  isAuthRequired
} from '../../../docker/runtime-sandbox/generate-runtime-table.mjs'

// The runtime image's table generator tolerates exactly one session/new failure: a runtime that is
// unauthenticated. Everything else must fail the build, because the smoke test exercises only
// Claude — so a broken Codex would otherwise be published AND verified with an empty snapshot.

describe('runtime table probe classification', () => {
  it('accepts only the ACP auth-required CODE, not a message that mentions auth', () => {
    expect(ACP_AUTH_REQUIRED_CODE).toBe(-32000)
    const unauthenticated = Object.assign(new Error('codex-acp session/new failed: Authentication required'), {
      acpCode: -32000
    })
    expect(isAuthRequired(unauthenticated)).toBe(true)

    // The case the earlier substring match got wrong: a broken auth store is a broken runtime.
    const brokenAuthStore = Object.assign(new Error('failed to initialize auth database at /agent/.codex'), {
      acpCode: -32603
    })
    expect(isAuthRequired(brokenAuthStore)).toBe(false)

    // And an error carrying no code at all — a spawn failure or a timeout — is never auth.
    expect(isAuthRequired(new Error('codex-acp did not answer session/new within 60000ms'))).toBe(false)
    expect(isAuthRequired(undefined)).toBe(false)
  })

  it.each([
    {
      label: 'reported version',
      agentInfo: { name: 'fixture', version: '1.2.3' },
      metadata: { version: '1.2.3' },
      identity: { agentName: 'fixture' }
    },
    { label: 'no version', agentInfo: { name: 'fixture' }, metadata: {}, identity: { agentName: 'fixture' } },
    { label: 'no agentInfo', agentInfo: undefined, metadata: {}, identity: {} }
  ])('records real initialize metadata with $label and an unauthenticated session', async (fixture) => {
    const initialized = { protocolVersion: 1, agentInfo: fixture.agentInfo, agentCapabilities: {} }
    const script = `
      require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
        const { id, method } = JSON.parse(line)
        const response = method === 'initialize'
          ? { result: ${JSON.stringify(initialized)} }
          : { error: { code: -32000, message: 'Authentication required' } }
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...response }) + '\\n')
      })
    `
    const entry = { id: 'fixture', command: process.execPath, args: ['--eval', script] }
    const table = await buildTable([entry])
    expect(table.runtimes).toEqual([
      {
        ...entry,
        ...fixture.metadata,
        acp: {
          protocolVersion: 1,
          ...fixture.identity,
          authMethods: [],
          capabilities: {},
          modes: [],
          configOptions: [],
          sessionProbe: 'auth-required'
        }
      }
    ])
  })

  it('reports a missing executable without waiting for the ACP timeout', async () => {
    await expect(
      buildTable([{ id: 'missing', command: join(tmpdir(), `missing-runtime-${randomUUID()}`) }])
    ).rejects.toThrow(/ENOENT/)
  })
})
