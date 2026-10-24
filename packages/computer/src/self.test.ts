import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { managedEntry, SERVICE_ENTRY_ENV, serviceEntry } from './self.js'

afterEach(() => vi.unstubAllEnvs())

describe('service entry', () => {
  it('runs the version store entry the CLI names, so an upgrade only moves its current link', () => {
    vi.stubEnv(SERVICE_ENTRY_ENV, '/home/ada/.agentconnect/computer/current/dist/agentconnect-computer.mjs')
    expect(managedEntry()).toBe('/home/ada/.agentconnect/computer/current/dist/agentconnect-computer.mjs')
    expect(serviceEntry()).toBe('/home/ada/.agentconnect/computer/current/dist/agentconnect-computer.mjs')
  })

  it('falls back to this bundle when started outside the CLI', () => {
    vi.stubEnv(SERVICE_ENTRY_ENV, ' ')
    expect(managedEntry()).toBeUndefined()
    expect(serviceEntry()).toBe(resolve(process.argv[1]!))
  })
})
