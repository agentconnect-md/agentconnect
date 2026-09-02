// The Linear module as the registry sees it. A Linear Bot row IS one connected
// workspace and its agents are members, which is a different shape from every other
// platform's "one bot, one agent" — so what this pins is where that difference is
// declared, and where it deliberately is not.

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { sessionFromDto, type SessionDto } from '@/lib/api'
import { sessionChannelFilterValue } from '@/lib/data'
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
  it('calls the room a team, with no glyph and no way out of one', () => {
    // The TEAM is the channel (§4.3): the generic list renders one row per team, and the
    // roster is the workspace's own — the CP upserts it — so nothing here is left or
    // dropped. A team goes quiet by turning its row Off, or the workspace by unlinking.
    const semantics = channelListSemantics('linear')
    expect(semantics.roomNoun).toBe('team')
    expect(semantics.roomGlyph).toBe('')
    expect(semantics.leave).toBe('none')
    expect(semantics.roster).toBe('derived')
    expect(semantics).not.toEqual(DEFAULT_CHANNEL_LIST)
  })

  it('offers Mention and Off, never "any message"', () => {
    // Every Linear event is addressed by construction (§6.1), so an "any message" arm
    // would match nothing an operator could ever observe.
    expect(channelListSemantics('linear').triggers).toEqual(['off', 'mention'])
  })

  it('warns before a team’s default leaves a private agent', () => {
    // §6.2: on an owner-as-default platform the seat IS the gated agent's grant.
    const warning = channelListSemantics('linear').ownerChangeWarning
    expect(warning).toBeDefined()
    // A bare verb, per the console's modal convention — never "Yes, move it".
    expect(warning?.confirmLabel).toBe('Move')
    const body = warning!.body({ owner: 'triage-bot', room: 'ENG · Engineering' })
    expect(body).toContain('triage-bot is a private agent')
    expect(body).toContain('can still be stopped, but it will not answer in them again')
  })

  it('wraps that list in its own card body, and is the only module that does', () => {
    expect(linearModule.agentCard?.Body).toBeDefined()
    expect(platformAgentCard('linear')?.Body).toBe(linearModule.agentCard?.Body)
    const withOwnCard = platformRegistry.all().filter((m) => m.agentCard)
    expect(withOwnCard.map((m) => m.platformId)).toEqual(['linear'])
    for (const m of platformRegistry.all()) {
      if (m.platformId !== 'linear') expect(platformAgentCard(m.platformId), m.platformId).toBeUndefined()
    }
  })

  it('puts its one repair in the header’s action track, over card-scoped state', () => {
    // The header already names the workspace and unlinks it, so the module adds Reconnect
    // there rather than drawing a second row — and the provider is what lets the button and
    // the body's band report one round trip.
    expect(platformAgentCard('linear')?.HeaderActions).toBeDefined()
    expect(platformAgentCard('linear')?.CardProvider).toBeDefined()
  })

  it('says why a private agent stays quiet in a team, in one clause', () => {
    // §4.3: a gated member acts in a team only as its default; the host's generic banner
    // would promise a per-member enable the model does not have.
    const note = channelListSemantics('linear').gatedNote
    expect(note).toBe('Private agent: it answers in a team only where it is the default and the team is not off.')
  })

  it('keeps the footer to what the rows do not already say', () => {
    const footerNote = channelListSemantics('linear').footerNote ?? ''
    expect(footerNote).toContain('Every team of this workspace is listed here')
    expect(footerNote.split('. ').length).toBe(1)
  })

  it('is the only module whose roster is derived, or whose triggers are narrowed', () => {
    // Both are capabilities core reads; neither may become "the platform is Linear".
    for (const m of platformRegistry.all()) {
      if (m.platformId === 'linear') continue
      expect(m.channelList?.roster, m.platformId).toBeUndefined()
      expect(m.channelList?.triggers, m.platformId).toBeUndefined()
      expect(m.channelList?.ownerChangeWarning, m.platformId).toBeUndefined()
      expect(m.channelList?.gatedNote, m.platformId).toBeUndefined()
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

describe('the linear session list', () => {
  // The daemon keys a session on its issue's TEAM and labels it `<KEY> · <Team name>`
  // (§4.3), so the console's generic per-channel grouping buckets by team with no
  // Linear arm anywhere: nothing collapses a workspace into one group.
  const session = (channel: string, channelName: string): SessionDto =>
    ({
      sessionId: `s-${channel}`,
      sessionKey: { platform: 'linear', channel, thread: 'issue-1' },
      agentId: 'agent-a',
      title: 'Ship it',
      status: 'running',
      lastActivityAt: '2026-09-01T00:00:00.000Z',
      usage: null,
      triggeredBy: 'u1',
      triggeredByName: 'Dana Reyes',
      hookKind: null,
      channelName,
      threadUrl: null,
      visibility: 'org'
    }) as unknown as SessionDto

  it('buckets a workspace’s sessions by their team, not into one group', () => {
    const eng = sessionFromDto(session('team-eng', 'ENG · Engineering'))
    const des = sessionFromDto(session('team-des', 'DES · Design'))

    expect(eng.channel).toContain('ENG · Engineering')
    expect(des.channel).toContain('DES · Design')
    expect(sessionChannelFilterValue(eng)).toBe('team-eng')
    expect(sessionChannelFilterValue(des)).toBe('team-des')
    expect(sessionChannelFilterValue(eng)).not.toBe(sessionChannelFilterValue(des))
  })
})
