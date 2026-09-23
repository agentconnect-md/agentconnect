// Each usage kind lands on the console page that edits it, or on nothing where no page exists yet.

import { describe, expect, it } from 'vitest'
import { decisionUsageHref } from './usage-links'

const orgPath = (path: string) => `/o/acme${path}`
const integrations = [{ id: 'int 1', agentId: 'agent/1' }]

describe('decisionUsageHref', () => {
  it('sends a gate to its integration agent’s conversation list', () => {
    expect(
      decisionUsageHref(
        { kind: 'gate', id: 'int 1:C1', label: '#general', integrationId: 'int 1', channelId: 'C1' },
        orgPath,
        integrations
      )
    ).toBe('/o/acme/agents/agent%2F1')
  })

  it('links nothing for a gate whose integration is unknown or unnamed', () => {
    expect(
      decisionUsageHref({ kind: 'gate', id: 'x', label: '#x', integrationId: 'int-2' }, orgPath, integrations)
    ).toBeNull()
    expect(decisionUsageHref({ kind: 'gate', id: 'x', label: '#x' }, orgPath, integrations)).toBeNull()
  })

  it('sends agent tools and model selection to their agent tabs', () => {
    expect(decisionUsageHref({ kind: 'agent_tool', id: 'a b', label: 'A' }, orgPath, integrations)).toBe(
      '/o/acme/agents/a%20b?tab=tools'
    )
    expect(decisionUsageHref({ kind: 'model_selection', id: 'a', label: 'A' }, orgPath, integrations)).toBe(
      '/o/acme/agents/a?tab=config'
    )
  })

  it('sends shared-bot routing to the bot’s Routing page', () => {
    expect(decisionUsageHref({ kind: 'shared_bot_routing', id: 'bot 1', label: 'Bot' }, orgPath, integrations)).toBe(
      '/o/acme/integrations/bots/bot%201/routing'
    )
  })
})
