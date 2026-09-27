import { describe, it, expect } from 'vitest'
import { keyAdmitted, selectionCovers, isAgentLevelPermission } from './api-key-permission.js'

const AGENT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const AGENT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

describe('keyAdmitted (daemon-api-key-auth.md §6)', () => {
  it('admits a full key everywhere', () => {
    expect(keyAdmitted('full', 'GET', undefined)).toBe(true)
    expect(keyAdmitted('full', 'POST', undefined)).toBe(true)
    expect(keyAdmitted('full', 'DELETE', 'agent:chat')).toBe(true)
  })

  it('admits a read key on read methods only, unless the route gates its own writes', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) expect(keyAdmitted('read', method, undefined)).toBe(true)
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(keyAdmitted('read', method, undefined)).toBe(false)
    // The MCP endpoint: a POST that hides and refuses write tools itself.
    expect(keyAdmitted('read', 'POST', 'read')).toBe(true)
    // A route declaring an agent-level permission is still a write for a read key.
    expect(keyAdmitted('read', 'POST', 'agent:chat')).toBe(false)
  })

  it('admits an agent-level key only where the route declares exactly it', () => {
    expect(keyAdmitted('agent:chat', 'POST', 'agent:chat')).toBe(true)
    expect(keyAdmitted('agent:chat', 'GET', undefined)).toBe(false)
    expect(keyAdmitted('agent:chat', 'POST', undefined)).toBe(false)
    expect(keyAdmitted('agent:chat', 'POST', 'read')).toBe(false)
  })
})

describe('agent selection', () => {
  it('covers every agent with allAgents, else exactly the rows; an empty selection covers none', () => {
    expect(selectionCovers({ allAgents: true, agentIds: [] }, AGENT_A)).toBe(true)
    expect(selectionCovers({ allAgents: false, agentIds: [AGENT_A] }, AGENT_A)).toBe(true)
    expect(selectionCovers({ allAgents: false, agentIds: [AGENT_A] }, AGENT_B)).toBe(false)
    expect(selectionCovers({ allAgents: false, agentIds: [] }, AGENT_A)).toBe(false)
  })

  it('is consulted for agent-level permissions only, and the predicate takes any token claim', () => {
    expect(isAgentLevelPermission('agent:chat')).toBe(true)
    expect(isAgentLevelPermission('read')).toBe(false)
    expect(isAgentLevelPermission('full')).toBe(false)
    expect(isAgentLevelPermission(undefined)).toBe(false)
    expect(isAgentLevelPermission(42)).toBe(false)
  })
})
