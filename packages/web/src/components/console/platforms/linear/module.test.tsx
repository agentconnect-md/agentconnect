// The Linear module as the registry sees it. A Linear Bot row IS one connected
// workspace and its agents are members, which is a different shape from every other
// platform's "one bot, one agent" — so what this pins is where that difference is
// declared, and where it deliberately is not.

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PLATFORM_MARK_IDS } from '../marks'
import { BOT_PLATFORMS, INTEGRATION_BLURB, isCoreTriggerKind } from '../host-projections'
import {
  DEFAULT_CHANNEL_LIST,
  botSharingEditable,
  channelListSemantics,
  platformAgentCard,
  platformRegistry,
  platformSharingFixed,
  platformSupportsSharing
} from '../registry'
import { LinearMark } from './mark'
import { linearApi } from './api'
import { linearModule } from '.'

const module = () => {
  const found = platformRegistry.get('linear')
  if (!found) throw new Error('no module registered for linear')
  return found
}

describe('the linear registry row', () => {
  it('registers the module once, last in picker order', () => {
    expect(module()).toBe(linearModule)
    expect(platformRegistry.ids().at(-1)).toBe('linear')
    expect(PLATFORM_MARK_IDS).toContain('linear')
  })

  it('is a daemon-gated chat platform, not a relay-backed trigger kind', () => {
    // The FIRST of the three availability conditions (§4.2). The picker gates a
    // registry platform on the owning daemon's advertised adapters and must never
    // gate a trigger kind that way — being in this list IS the gate.
    expect(BOT_PLATFORMS.map((tile) => tile.key)).toContain('linear')
    expect(isCoreTriggerKind('linear')).toBe(false)
    expect(INTEGRATION_BLURB.linear).toBeTruthy()
  })

  it('declares multi-agent bots as STRUCTURAL — a workspace is not opted into sharing', () => {
    // Reuse must still admit members, so the platform supports sharing; but the
    // provider stamps the flag (§4.3), so neither surface offers a control for it.
    expect(module().wizard.affordances.share).toBe('fixed')
    expect(platformSupportsSharing('linear')).toBe(true)
    expect(platformSharingFixed('linear')).toBe(true)
    expect(botSharingEditable({ platform: 'linear', transport: 'http', shareable: true })).toBe(false)
  })
})

describe('the linear mark', () => {
  it('renders the official glyph inline, capped like the other full-bleed marks', () => {
    // The logomark fills its viewBox edge to edge, so a full-bleed caller gets the
    // 80% square-glyph cap rather than outsizing the marks beside it.
    expect(renderToStaticMarkup(<LinearMark />)).toContain('width:60%')
    expect(renderToStaticMarkup(<LinearMark fillPct={100} />)).toContain('width:80%')
    const markup = renderToStaticMarkup(<LinearMark />)
    expect(markup.startsWith('<svg')).toBe(true)
    // One traced path, drawn here rather than imported as an asset.
    expect(markup.match(/<path /g)).toHaveLength(1)
  })
})

describe('the linear transcript and card semantics', () => {
  it('declares NO channel list, and its own agent-card body instead', () => {
    // The generic list enumerates rooms a bot was added to, each with a trigger and a
    // way out. A Linear workspace has none of those, and its issues are not a roster
    // the console keeps — so the module renders the workspace itself and the list is
    // never reached. Declaring semantics for it would describe a list that must not
    // exist; absence is the declaration.
    expect(linearModule.channelList).toBeUndefined()
    expect(linearModule.agentCard?.Body).toBeDefined()
    expect(platformAgentCard('linear')?.Body).toBe(linearModule.agentCard?.Body)
    // Falling back to the host defaults is what "never rendered" looks like from the
    // lookup's side — no borrowed noun, no invented issue vocabulary.
    expect(channelListSemantics('linear')).toEqual(DEFAULT_CHANNEL_LIST)
  })

  it('is the only module that replaces the agent card', () => {
    const withOwnCard = platformRegistry.all().filter((m) => m.agentCard)
    expect(withOwnCard.map((m) => m.platformId)).toEqual(['linear'])
    // Every other platform keeps the generic list, so each still declares — or
    // defaults — its own room semantics.
    for (const m of platformRegistry.all()) {
      if (m.platformId !== 'linear') expect(platformAgentCard(m.platformId), m.platformId).toBeUndefined()
    }
  })

  it('dedupes on an agent-activity id and on nothing else', () => {
    const row = (ts: string) => ({ seq: 1, sender: 'u', ts, kind: 'text', text: 'hi' })
    const activity = '2f1c9c4e-0d3b-4f5a-8f31-9a2b6c7d8e90'
    expect(linearModule.messageIdentity?.(row(activity))).toBe(`ts:${activity}`)
    // Not a Slack decimal ts, not a snowflake, not a daemon-local millisecond stamp.
    for (const ts of ['1754123456.000200', '1101111111111111111', '1754123457123', '', 'om_abc']) {
      expect(linearModule.messageIdentity?.(row(ts)), ts).toBeNull()
    }
  })

  it('orders pages by the daemon sequence', () => {
    expect(linearModule.transcriptOrdering).toBe('seq')
  })
})

describe('the linear api bindings', () => {
  it('names the funnel, its reconnect arm and the org-wide disconnect — and nothing else', () => {
    // `disconnect` is a route rather than a client loop because the membership list the
    // console could loop over is visibility-filtered; only the server sees every member.
    expect(Object.keys(linearApi).sort()).toEqual(['disconnect', 'getConnect', 'reconnect', 'startConnect'])
    expect(module().apiBindings).toBe(linearApi)
  })
})
