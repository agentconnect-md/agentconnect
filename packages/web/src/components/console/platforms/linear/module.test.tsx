// The Linear module as the registry sees it. A Linear Bot row IS one connected
// workspace and its agents are members, which is a different shape from every other
// platform's "one bot, one agent" — so what this pins is where that difference is
// declared, and where it deliberately is not.

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PLATFORM_MARK_IDS } from '../marks'
import { BOT_PLATFORMS, INTEGRATION_BLURB, isCoreTriggerKind } from '../host-projections'
import {
  botSharingEditable,
  channelListSemantics,
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
  it('renders inline SVG that honours the fill box uncapped', () => {
    // The artwork carries its own padding (the bar cluster spans ~68% of the
    // viewBox), so a full-bleed caller gets 100% rather than the square-glyph cap.
    expect(renderToStaticMarkup(<LinearMark />)).toContain('width:60%')
    expect(renderToStaticMarkup(<LinearMark fillPct={100} />)).toContain('width:100%')
    const markup = renderToStaticMarkup(<LinearMark />)
    expect(markup.startsWith('<svg')).toBe(true)
    // Four bars, drawn here rather than imported as an asset.
    expect(markup.match(/<path /g)).toHaveLength(4)
  })
})

describe('the linear transcript and channel semantics', () => {
  it('calls a room an issue and offers no leave affordance', () => {
    const semantics = channelListSemantics('linear')
    expect(semantics.roomNoun).toBe('issue')
    expect(semantics.roomGlyph).toBe('')
    expect(semantics.leave).toBe('none')
    // Nobody is shown out of an issue from here, so the row hint names where the
    // session actually ends instead of pointing at a control that does not exist.
    expect(semantics.cannotLeaveRowHint).toContain('end the agent session in Linear')
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
  it('names the funnel, its reconnect arm and the default-agent move — and nothing else', () => {
    // Removing a member is deliberately absent: it is the generic
    // DELETE /integrations/:id, committed through the console's own data context so
    // the integration/bot projections refresh with it.
    expect(Object.keys(linearApi).sort()).toEqual(['getConnect', 'reconnect', 'setDefaultAgent', 'startConnect'])
    expect(module().apiBindings).toBe(linearApi)
  })
})
