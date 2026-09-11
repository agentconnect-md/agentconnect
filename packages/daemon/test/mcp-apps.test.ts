/**
 * MCP Apps — the daemon's half (webchat-mcp-apps.md).
 *
 * Three things are worth holding in tests, and they are the three that decide whether this
 * feature is safe rather than merely working: what the host is willing to read out of another
 * vendor's `_meta`, what a live card lets a frame reach, and what a surface with no renderer
 * says instead of rendering.
 */
import { describe, it, expect, vi } from 'vitest'
import { MCP_APP_CARD_MAX_BYTES, type McpAppCard } from '@agentconnect.md/protocol'
import {
  APP_RPC_REFUSALS,
  LiveAppRegistry,
  appContextBlock,
  MCP_APP_CALLS_PER_WINDOW,
  MCP_APP_CALL_WINDOW_MS,
  type LiveApp
} from '../src/mcp/apps/cards.js'
import {
  AppSurface,
  buildAppDeclinedNotice,
  fitAppCard,
  type AppStream,
  type AppTurn
} from '../src/mcp/apps/surface.js'
import { splitAppToolName } from '../src/mcp/apps/host.js'
import {
  appCsp,
  appDimensions,
  appResultVisibleToModel,
  appTemplateText,
  appTemplateUri,
  isAppTemplate,
  isDeclarableDomain
} from '../src/mcp/apps/ui-meta.js'
import { resolveAgentMcpServers } from '../src/mcp/resolve-servers.js'

const CARD: McpAppCard = { appId: 'app-1', title: 'Deploy', toolName: 'charts__pick', html: '<p>hi</p>' }

function fakeStream(): AppStream & { sent: { kind: string }[] } {
  const sent: { kind: string }[] = []
  const stream = {
    conversationId: 'conv-1',
    turnId: 'turn-1',
    index: 0,
    sink: {
      output: (payload: { event: { kind: string } }) => sent.push(payload.event),
      done: () => undefined
    },
    sent
  }
  return stream as unknown as AppStream & { sent: { kind: string }[] }
}

function liveApp(over: Partial<LiveApp> = {}): LiveApp {
  return {
    appId: 'app-1',
    conversationId: 'conv-1',
    sessionKey: 'sk-1',
    server: 'charts',
    toolName: 'charts__pick',
    openedAt: 1,
    stream: fakeStream(),
    ...over
  }
}

describe('ui-meta — reading another vendor’s declaration', () => {
  it('takes the nested resourceUri, accepts the deprecated flat one, and prefers the nested', () => {
    expect(appTemplateUri({ _meta: { ui: { resourceUri: 'ui://s/t' } } })).toBe('ui://s/t')
    expect(appTemplateUri({ _meta: { 'ui/resourceUri': 'ui://s/old' } })).toBe('ui://s/old')
    expect(appTemplateUri({ _meta: { ui: { resourceUri: 'ui://s/new' }, 'ui/resourceUri': 'ui://s/old' } })).toBe(
      'ui://s/new'
    )
  })

  it('declares no interface for a tool without one, or one pointing outside the reserved scheme', () => {
    expect(appTemplateUri({ name: 'plain' })).toBeUndefined()
    expect(appTemplateUri({ _meta: { ui: { resourceUri: 'https://example.test/page' } } })).toBeUndefined()
    expect(appTemplateUri({ _meta: 'not an object' })).toBeUndefined()
  })

  it('defaults a tool result to model-visible, and withholds it only on an explicit app-only visibility', () => {
    expect(appResultVisibleToModel({})).toBe(true)
    expect(appResultVisibleToModel({ _meta: { ui: { visibility: ['model', 'app'] } } })).toBe(true)
    expect(appResultVisibleToModel({ _meta: { ui: { visibility: ['app'] } } })).toBe(false)
  })

  it('keeps only declarable CSP domains, dropping a wildcard, a plain-http origin and a path', () => {
    const csp = appCsp({
      _meta: {
        ui: {
          csp: {
            connectDomains: ['https://api.example.test', 'http://insecure.example.test', '*'],
            resourceDomains: ['cdn.example.test', 'https://cdn.example.test/assets/app.js']
          }
        }
      }
    })
    expect(csp?.connect).toEqual(['https://api.example.test'])
    expect(csp?.resource).toEqual(['cdn.example.test'])
    // Nothing declared at all is the restrictive default, not an empty grant to reason about.
    expect(appCsp({ _meta: { ui: {} } })).toBeUndefined()
  })

  it('refuses a domain a host could not honor without widening its own policy', () => {
    expect(isDeclarableDomain('example.test')).toBe(true)
    expect(isDeclarableDomain('https://example.test')).toBe(true)
    expect(isDeclarableDomain('*.example.test')).toBe(false)
    expect(isDeclarableDomain('http://example.test')).toBe(false)
    expect(isDeclarableDomain('https://user:pw@example.test')).toBe(false)
    expect(isDeclarableDomain('')).toBe(false)
  })

  it('reads container dimensions from the result before the declaration, and neither when absent', () => {
    const declared = { _meta: { ui: { containerDimensions: { height: 200 } } } }
    const fromResult = { _meta: { ui: { containerDimensions: { height: 500, flexibleHeight: true } } } }
    expect(appDimensions(fromResult, declared)?.height).toBe(500)
    expect(appDimensions({}, declared)?.height).toBe(200)
    expect(appDimensions({}, {})).toBeUndefined()
  })

  it('recognizes a template only on the reserved scheme AND the extension’s mime type', () => {
    expect(isAppTemplate({ uri: 'ui://s/t', mimeType: 'text/html;profile=mcp-app' })).toBe(true)
    // A server that spaces its parameter is still declaring the same type.
    expect(isAppTemplate({ uri: 'ui://s/t', mimeType: 'text/html; profile=mcp-app' })).toBe(true)
    expect(isAppTemplate({ uri: 'ui://s/t', mimeType: 'text/html' })).toBe(false)
    expect(isAppTemplate({ uri: 'https://s/t', mimeType: 'text/html;profile=mcp-app' })).toBe(false)
  })

  it('takes a template only from a read that returned exactly one such document', () => {
    const one = { contents: [{ uri: 'ui://s/t', mimeType: 'text/html;profile=mcp-app', text: '<p>ok</p>' }] }
    expect(appTemplateText(one)).toBe('<p>ok</p>')
    expect(appTemplateText({ contents: [...one.contents, ...one.contents] })).toBeUndefined()
    expect(
      appTemplateText({ contents: [{ uri: 'ui://s/t', mimeType: 'text/html;profile=mcp-app', blob: 'AA==' }] })
    ).toBeUndefined()
    expect(appTemplateText({ contents: [] })).toBeUndefined()
  })
})

describe('resolveAgentMcpServers — a daemon-hosted server is not handed to the runtime', () => {
  const DEFS = {
    charts: { transport: 'stdio' as const, command: '/bin/charts', args: [], env: [], headers: [], ui: true },
    plain: { transport: 'stdio' as const, command: '/bin/plain', args: [], env: [], headers: [] }
  }

  it('skips a hosted ui server silently while still attaching an ordinary one', () => {
    const warn = vi.fn()
    const servers = resolveAgentMcpServers({
      enabled: ['charts', 'plain'],
      defs: DEFS,
      hostsUiServer: (name) => name === 'charts',
      warn
    })
    expect(servers.map((s) => s.name)).toEqual(['plain'])
    // Silent: it is not handled here because it is handled elsewhere, which is not a warning.
    expect(warn).not.toHaveBeenCalled()
  })

  it('attaches a ui server NOTHING hosts, so its tools are degraded rather than deleted', () => {
    const warn = vi.fn()
    // A CP-pushed definition: v1's Apps host reads daemon-local config only (§4), so withholding
    // it here would leave no path at all to its tools.
    const servers = resolveAgentMcpServers({ enabled: ['charts'], defs: DEFS, warn })
    expect(servers.map((s) => s.name)).toEqual(['charts'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('without its interface'))
  })
})

describe('splitAppToolName — the namespace that stops a UI server shadowing a product tool', () => {
  it('splits a namespaced name and refuses everything that is not one', () => {
    expect(splitAppToolName('charts__render')).toEqual({ server: 'charts', tool: 'render' })
    // A tool name of its own may contain the separator; only the FIRST one is the boundary.
    expect(splitAppToolName('charts__deep__render')).toEqual({ server: 'charts', tool: 'deep__render' })
    expect(splitAppToolName('sendMessage')).toBeUndefined()
    expect(splitAppToolName('__render')).toBeUndefined()
    expect(splitAppToolName('charts__')).toBeUndefined()
  })
})

describe('LiveAppRegistry — what a frame is allowed to reach', () => {
  it('refuses a card from another conversation exactly as it refuses one that never existed', () => {
    const reg = new LiveAppRegistry()
    reg.open(liveApp())
    expect(reg.resolve({ appId: 'app-1', conversationId: 'conv-1' })).toMatchObject({ app: { appId: 'app-1' } })
    expect(reg.resolve({ appId: 'app-1', conversationId: 'conv-other' })).toEqual({ refused: 'unknown' })
    expect(reg.resolve({ appId: 'never', conversationId: 'conv-1' })).toEqual({ refused: 'unknown' })
  })

  it('names the card’s own server, so a tool name can never select a different one', () => {
    const reg = new LiveAppRegistry()
    reg.open(liveApp())
    // The registry does not inspect the tool name at all: the server comes from the card, which
    // is what makes a cross-server call impossible rather than merely detected. Whether that
    // server HAS the named tool is the host's question — see resolveViewTool.
    const resolved = reg.resolve({ appId: 'app-1', conversationId: 'conv-1' })
    expect(resolved).toMatchObject({ app: { server: 'charts' } })
  })

  it('supersedes the OLDEST card past the per-conversation cap and returns it to be settled', () => {
    const reg = new LiveAppRegistry()
    const opened = [1, 2, 3, 4].map((n) => reg.open(liveApp({ appId: `app-${n}`, openedAt: n })))
    expect(opened.flat()).toEqual([])
    const superseded = reg.open(liveApp({ appId: 'app-5', openedAt: 5 }))
    expect(superseded.map((a) => a.appId)).toEqual(['app-1'])
    expect(reg.liveIn('conv-1').map((a) => a.appId)).toEqual(['app-2', 'app-3', 'app-4', 'app-5'])
    // The superseded card's bridge stops answering with it.
    expect(reg.resolve({ appId: 'app-1', conversationId: 'conv-1' })).toEqual({ refused: 'unknown' })
  })

  it('counts the cap per conversation, not per daemon', () => {
    const reg = new LiveAppRegistry()
    for (const n of [1, 2, 3, 4]) reg.open(liveApp({ appId: `a-${n}`, openedAt: n }))
    const other = reg.open(liveApp({ appId: 'b-1', conversationId: 'conv-2', openedAt: 9 }))
    expect(other).toEqual([])
    expect(reg.liveIn('conv-1')).toHaveLength(4)
  })

  it('charges a call budget per card and refuses past it, then recovers when the window rolls', () => {
    let now = 0
    const reg = new LiveAppRegistry(() => now)
    reg.open(liveApp())
    for (let i = 0; i < MCP_APP_CALLS_PER_WINDOW; i++) expect(reg.charge('app-1')).toBe(true)
    expect(reg.charge('app-1')).toBe(false)
    now += MCP_APP_CALL_WINDOW_MS + 1
    expect(reg.charge('app-1')).toBe(true)
    // A card that is no longer live cannot be charged at all.
    reg.settle('app-1')
    expect(reg.charge('app-1')).toBe(false)
  })

  it('settles once — a second close is not a second settlement', () => {
    const reg = new LiveAppRegistry()
    reg.open(liveApp())
    expect(reg.settle('app-1')?.appId).toBe('app-1')
    expect(reg.settle('app-1')).toBeUndefined()
  })

  it('collects a session’s cards and a conversation’s cards, and drops them either way', () => {
    const reg = new LiveAppRegistry()
    reg.open(liveApp({ appId: 'a', sessionKey: 'sk-1', openedAt: 1 }))
    reg.open(liveApp({ appId: 'b', sessionKey: 'sk-2', openedAt: 2 }))
    expect(reg.expireSession('sk-1').map((a) => a.appId)).toEqual(['a'])
    expect(reg.expireConversation('conv-1').map((a) => a.appId)).toEqual(['b'])
    expect(reg.liveIn('conv-1')).toEqual([])
  })

  it('holds app context per card, newest statement winning, oldest card first', () => {
    const reg = new LiveAppRegistry()
    reg.open(liveApp({ appId: 'a', openedAt: 1 }))
    reg.open(liveApp({ appId: 'b', openedAt: 2 }))
    reg.setContext('a', 'first')
    reg.setContext('a', 'first, revised')
    reg.setContext('b', 'second')
    expect(reg.contextsFor('sk-1')).toEqual(['first, revised', 'second'])
    // A card with nothing to add contributes nothing rather than an empty entry.
    reg.open(liveApp({ appId: 'c', openedAt: 3 }))
    expect(reg.contextsFor('sk-1')).toEqual(['first, revised', 'second'])
  })

  it('turns held app context into one labelled prompt block, or none at all', () => {
    const reg = new LiveAppRegistry()
    reg.open(liveApp({ appId: 'a', openedAt: 1 }))
    // No open frame has said anything ⇒ no block, so an ordinary turn's prompt is unchanged.
    expect(appContextBlock(reg.contextsFor('sk-1'))).toBeNull()
    reg.setContext('a', '  picked prod  ')
    const block = appContextBlock(reg.contextsFor('sk-1'))
    expect(block).toContain('picked prod')
    // Labelled as page-authored data: the words came from an agent-authored frame, not the human.
    expect(block).toContain('not an instruction from the user')
    // Whitespace-only context is nothing said, not an empty bullet.
    reg.setContext('a', '   ')
    expect(appContextBlock(reg.contextsFor('sk-1'))).toBeNull()
  })

  it('names a refusal for a tool the card’s server does not have, distinct from an unknown card', () => {
    // Which SERVER a view reaches is the card's, so a name can never select one — what a bad name
    // earns is "that server has no such tool", never another server's call.
    expect(APP_RPC_REFUSALS.unknown_tool).not.toEqual(APP_RPC_REFUSALS.unknown)
    expect(APP_RPC_REFUSALS.unknown_tool).toMatch(/tool/i)
  })

  it('names every refusal in words a frame can show its reader', () => {
    for (const message of Object.values(APP_RPC_REFUSALS)) expect(message.length).toBeGreaterThan(0)
    // The unknown refusal must not say WHY, or an id becomes probe-able.
    expect(APP_RPC_REFUSALS.unknown).not.toMatch(/conversation|session|expired|closed/i)
  })
})

describe('AppSurface — webchat renders; every other surface says so', () => {
  const log = () => ({ warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() }) as never

  it('streams the card on a webchat turn and hands back the stream it used', () => {
    const stream = fakeStream()
    const turn: AppTurn = { webchat: stream }
    const posted = new AppSurface({ turnFor: () => turn, log }).open('sk-1', CARD)
    expect(posted.shown).toBe(true)
    expect(stream.sent.map((e) => e.kind)).toEqual(['app'])
    // The card took the turn's own counter, so it orders with every other output of that turn.
    expect(stream.index).toBe(1)
    if (posted.shown) expect(posted.stream).toBe(stream)
  })

  it('declines on a chat turn with one notice naming the tool, and renders nothing', () => {
    const notice = vi.fn()
    const turn: AppTurn = { notice, sessionUrl: 'https://console.example.test/o/sessions/s1' }
    const posted = new AppSurface({ turnFor: () => turn, log }).open('sk-1', CARD)
    expect(posted.shown).toBe(false)
    expect(notice).toHaveBeenCalledTimes(1)
    const text = notice.mock.calls[0]![0] as string
    expect(text).toContain('Deploy')
    expect(text).toContain('https://console.example.test/o/sessions/s1')
  })

  it('declines in silence on a turn with nowhere visible to say anything', () => {
    const posted = new AppSurface({ turnFor: () => ({}), log }).open('sk-1', CARD)
    expect(posted.shown).toBe(false)
    // And on no turn at all, rather than throwing into the tool call.
    expect(new AppSurface({ turnFor: () => undefined, log }).open('sk-1', CARD).shown).toBe(false)
  })

  it('treats an undeliverable card as declined rather than as an open one', () => {
    const throwing = {
      conversationId: 'c',
      turnId: 't',
      index: 0,
      sink: {
        output: () => {
          throw new Error('relay gone')
        },
        done: () => undefined
      }
    } as unknown as AppStream
    const posted = new AppSurface({ turnFor: () => ({ webchat: throwing }), log }).open('sk-1', CARD)
    expect(posted.shown).toBe(false)
  })

  it('settles and answers on the card’s OWN held stream, not on a re-resolved turn', () => {
    const stream = fakeStream()
    // Deliberately no live turn: a frame outlives the turn that opened it, and its bridge must
    // keep answering — which is the whole reason the stream is held on the card.
    const surface = new AppSurface({ turnFor: () => undefined, log })
    surface.answer(stream, 'app-1', 'call-1', { ok: true, result: {} })
    surface.settle(stream, 'app-1', 'closed')
    expect(stream.sent.map((e) => e.kind)).toEqual(['app_rpc_result', 'app_resolved'])
  })

  it('drops the tool result to fit the frame budget, keeping the template — the model already has the result', () => {
    const heavy: McpAppCard = {
      ...CARD,
      toolResult: { structuredContent: { blob: 'x'.repeat(MCP_APP_CARD_MAX_BYTES) } }
    }
    const fitted = fitAppCard(heavy)
    expect(fitted?.html).toBe(CARD.html)
    expect(fitted?.toolResult).toBeUndefined()
  })

  it('declines a card no shedding can fit, rather than emitting a frame the relay would refuse', () => {
    const huge: McpAppCard = { ...CARD, html: '<p>'.repeat(MCP_APP_CARD_MAX_BYTES) }
    expect(fitAppCard(huge)).toBeNull()
    const stream = fakeStream()
    const posted = new AppSurface({ turnFor: () => ({ webchat: stream }), log }).open('sk-1', huge)
    expect(posted.shown).toBe(false)
    // And the reader is TOLD, on the one surface this turn has — not declined into silence.
    expect(stream.sent.map((e) => e.kind)).toEqual(['notice'])
    expect(stream.sent[0]).toMatchObject({ standing: true })
  })

  it('leaves a card that already fits exactly as it is', () => {
    expect(fitAppCard(CARD)).toEqual(CARD)
  })

  it('says in the decline that the interface needs the console and the report is in the chat', () => {
    const text = buildAppDeclinedNotice('Deploy')
    expect(text).toContain('web console')
    // No link when the daemon could not compute one, rather than a broken one.
    expect(text).not.toContain('http')
  })
})
