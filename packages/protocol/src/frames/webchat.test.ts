import { describe, it, expect } from 'vitest'
import {
  ELICIT_FORM_WIRE_FIELD_CAP,
  MCP_APP_CONTEXT_MAX_CHARS,
  MCP_APP_HTML_MAX_BYTES,
  McpAppRpc,
  WebchatOutput,
  WebchatStatus
} from '../index.js'

const CONV = '11111111-1111-4111-8111-111111111111'
const TURN = '22222222-2222-4222-8222-222222222222'

describe('WebchatOutput — event / status framing', () => {
  it('accepts a reply-chunk frame (event only)', () => {
    const r = WebchatOutput.safeParse({
      conversationId: CONV,
      turnId: TURN,
      index: 0,
      event: { kind: 'message', text: 'hi' }
    })
    expect(r.success).toBe(true)
  })

  it('accepts a plan snapshot, priority and all', () => {
    const r = WebchatOutput.safeParse({
      conversationId: CONV,
      turnId: TURN,
      index: 2,
      event: {
        kind: 'plan',
        entries: [
          { content: 'read the file', status: 'completed' },
          { content: 'fix the bug', status: 'in_progress', priority: 'high' }
        ]
      }
    })
    expect(r.success).toBe(true)
    if (r.success && r.data.event?.kind === 'plan') expect(r.data.event.entries).toHaveLength(2)
  })

  it('accepts a status-only frame (no event)', () => {
    const r = WebchatOutput.safeParse({
      conversationId: CONV,
      turnId: TURN,
      index: 1,
      status: { model: 'opus-4.8', contextUsed: 120_000, contextSize: 200_000, totalTokens: 45_200 }
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.status?.model).toBe('opus-4.8')
  })

  it('accepts a combined event + status frame', () => {
    const r = WebchatOutput.safeParse({
      conversationId: CONV,
      turnId: TURN,
      index: 2,
      event: { kind: 'message', text: 'done' },
      status: { costAmount: 0.18, costCurrency: 'USD' }
    })
    expect(r.success).toBe(true)
  })

  it('carries an elicitation card and its settled twin, uncapped in options', () => {
    const card = WebchatOutput.safeParse({
      conversationId: CONV,
      turnId: TURN,
      index: 4,
      event: {
        kind: 'elicitation',
        requestId: 'elicit-1',
        message: 'Which branch should I cut from?',
        // Well past Slack's five-button cap — that limit belongs to Slack's card, not here.
        options: Array.from({ length: 12 }, (_, i) => ({ value: `b${i}`, label: `branch ${i}` }))
      }
    })
    expect(card.success).toBe(true)
    if (card.success && card.data.event?.kind === 'elicitation') expect(card.data.event.options).toHaveLength(12)
    for (const outcome of ['accepted', 'dismissed', 'cancelled']) {
      expect(
        WebchatOutput.safeParse({
          conversationId: CONV,
          turnId: TURN,
          index: 5,
          event: {
            kind: 'elicitation_resolved',
            requestId: 'elicit-1',
            outcome,
            ...(outcome === 'accepted' ? { label: 'branch 3' } : {})
          }
        }).success
      ).toBe(true)
    }
  })

  it('carries a URL-mode consent card, and its completion as a fourth outcome', () => {
    const card = WebchatOutput.safeParse({
      conversationId: CONV,
      turnId: TURN,
      index: 4,
      event: {
        kind: 'elicitation',
        requestId: 'elicit-9',
        message: 'Sign in to continue',
        // No options and no field descriptors — the card is the URL.
        options: [],
        url: 'https://billing.example.test/oauth/authorize?state=xyz'
      }
    })
    expect(card.success).toBe(true)
    if (card.success && card.data.event?.kind === 'elicitation')
      expect(card.data.event.url).toBe('https://billing.example.test/oauth/authorize?state=xyz')
    // 'completed' re-labels an already-consented card; the three original outcomes are untouched.
    expect(
      WebchatOutput.safeParse({
        conversationId: CONV,
        turnId: TURN,
        index: 5,
        event: { kind: 'elicitation_resolved', requestId: 'elicit-9', outcome: 'completed' }
      }).success
    ).toBe(true)
    // A form card written before this field still decodes to exactly what it always meant.
    const form = WebchatOutput.safeParse({
      conversationId: CONV,
      turnId: TURN,
      index: 6,
      event: { kind: 'elicitation', requestId: 'elicit-1', message: 'Pick', options: [{ value: 'a', label: 'a' }] }
    })
    expect(form.success).toBe(true)
    if (form.success && form.data.event?.kind === 'elicitation') expect(form.data.event.url).toBeUndefined()
  })

  it('marks a STANDING notice, and leaves the wait notice it grew out of untouched', () => {
    const notice = (event: Record<string, unknown>) =>
      WebchatOutput.safeParse({ conversationId: CONV, turnId: TURN, index: 2, event })
    // A notice the reader has to keep: an ask this surface could not show, or an answer it would
    // not take. Without the flag the browser retires it the moment output resumes, which is what
    // made a declined webchat elicitation silent (#1794).
    const standing = notice({ kind: 'notice', text: 'The agent asked something…', standing: true })
    expect(standing.success).toBe(true)
    if (standing.success && standing.data.event?.kind === 'notice') expect(standing.data.event.standing).toBe(true)
    // The wait notice predates the field, so every payload written before it still means "a wait".
    const wait = notice({ kind: 'notice', text: 'Allocating a sandbox pod…' })
    expect(wait.success).toBe(true)
    if (wait.success && wait.data.event?.kind === 'notice') expect(wait.data.event.standing).toBeUndefined()
    expect(notice({ kind: 'notice', text: 'x', standing: 'yes' }).success).toBe(false)
  })

  it('marks a multi-select card with its bounds, and leaves the single-choice card untouched', () => {
    const card = (event: Record<string, unknown>) =>
      WebchatOutput.safeParse({ conversationId: CONV, turnId: TURN, index: 4, event })
    const base = {
      kind: 'elicitation',
      requestId: 'elicit-1',
      message: 'Which checks should I run?',
      options: [
        { value: 'lint', label: 'lint' },
        { value: 'test', label: 'test' }
      ]
    }
    const multi = card({ ...base, multi: { minItems: 1, maxItems: 2 } })
    expect(multi.success).toBe(true)
    if (multi.success && multi.data.event?.kind === 'elicitation') expect(multi.data.event.multi?.maxItems).toBe(2)
    // Unbounded, and the original single-choice card — `multi` absent means "pick exactly one",
    // so every payload written before this field keeps decoding to what it always meant.
    expect(card({ ...base, multi: {} }).success).toBe(true)
    const single = card(base)
    expect(single.success).toBe(true)
    if (single.success && single.data.event?.kind === 'elicitation') expect(single.data.event.multi).toBeUndefined()
    expect(card({ ...base, multi: { minItems: -1 } }).success).toBe(false)
    expect(card({ ...base, multi: { maxItems: 1.5 } }).success).toBe(false)
  })

  it('marks a typed card with its constraints and its default, leaving the option cards alone', () => {
    const card = (event: Record<string, unknown>) =>
      WebchatOutput.safeParse({ conversationId: CONV, turnId: TURN, index: 4, event })
    const base = { kind: 'elicitation', requestId: 'elicit-1', message: 'Name the branch?', options: [] }
    const text = card({
      ...base,
      text: { minLength: 3, maxLength: 50, pattern: '^[a-z-]+$', format: 'email' },
      defaultValue: 'user@example.com'
    })
    expect(text.success).toBe(true)
    if (text.success && text.data.event?.kind === 'elicitation') {
      // A typed card offers nothing to pick, which is exactly why `options` may now be empty.
      expect(text.data.event.options).toEqual([])
      expect(text.data.event.text?.format).toBe('email')
      expect(text.data.event.defaultValue).toBe('user@example.com')
    }
    expect(card({ ...base, number: { integer: true, minimum: 0, maximum: 100 }, defaultValue: 50 }).success).toBe(true)
    // Only the four formats MCP defines, and a pattern short enough to have been screened.
    expect(card({ ...base, text: { format: 'hostname' } }).success).toBe(false)
    expect(card({ ...base, text: { pattern: 'a'.repeat(201) } }).success).toBe(false)
    // The option cards keep decoding to exactly what they always meant: no typed fields at all.
    const single = card({
      kind: 'elicitation',
      requestId: 'elicit-1',
      message: 'Which branch?',
      options: [{ value: 'main', label: 'main' }]
    })
    expect(single.success).toBe(true)
    if (single.success && single.data.event?.kind === 'elicitation') {
      expect(single.data.event.text).toBeUndefined()
      expect(single.data.event.number).toBeUndefined()
      expect(single.data.event.defaultValue).toBeUndefined()
    }
  })

  it('carries a multi-field form card, its fields bounded and the single-field descriptors left off', () => {
    const card = (event: Record<string, unknown>) =>
      WebchatOutput.safeParse({ conversationId: CONV, turnId: TURN, index: 4, event })
    const field = (propName: string, over: Record<string, unknown> = {}) => ({
      propName,
      label: propName,
      kind: 'text',
      options: [],
      ...over
    })
    const form = card({
      kind: 'elicitation',
      requestId: 'elicit-1',
      message: 'Cut the branch',
      // Empty, and NO multi/text/number/defaultValue: a reader that does not know `fields`
      // gets a card with nothing to pick rather than one it could half-answer.
      options: [],
      fields: [
        field('branch', { kind: 'enum', required: true, options: [{ value: 'main', label: 'main' }] }),
        field('note', { text: { maxLength: 40 } }),
        field('retries', { kind: 'number', number: { integer: true }, defaultValue: 3 })
      ]
    })
    expect(form.success).toBe(true)
    if (form.success && form.data.event?.kind === 'elicitation') {
      expect(form.data.event.fields?.map((f) => f.propName)).toEqual(['branch', 'note', 'retries'])
      expect(form.data.event.fields?.[0]?.required).toBe(true)
      expect(form.data.event.fields?.[1]?.required).toBeUndefined()
      expect(form.data.event.multi).toBeUndefined()
      expect(form.data.event.text).toBeUndefined()
    }
    // One field is the single-field card, not a form; and no card is longer than the cap.
    expect(card({ kind: 'elicitation', requestId: 'e', message: 'm', options: [], fields: [field('a')] }).success).toBe(
      false
    )
    const wide = Array.from({ length: ELICIT_FORM_WIRE_FIELD_CAP + 1 }, (_, i) => field(`f${i}`))
    expect(card({ kind: 'elicitation', requestId: 'e', message: 'm', options: [], fields: wide }).success).toBe(false)
    // A field with no property to answer under, or a kind no surface renders, is not a field.
    expect(
      card({ kind: 'elicitation', requestId: 'e', message: 'm', options: [], fields: [field(''), field('b')] }).success
    ).toBe(false)
    expect(
      card({
        kind: 'elicitation',
        requestId: 'e',
        message: 'm',
        options: [],
        fields: [field('a', { kind: 'slider' }), field('b')]
      }).success
    ).toBe(false)
  })

  it('rejects an unrenderable elicitation frame rather than streaming a dead card', () => {
    const bad = (event: unknown) =>
      WebchatOutput.safeParse({ conversationId: CONV, turnId: TURN, index: 6, event }).success
    expect(bad({ kind: 'elicitation', requestId: '', message: 'm', options: [] })).toBe(false)
    expect(bad({ kind: 'elicitation', requestId: 'e', message: 'm' })).toBe(false) // options required
    expect(bad({ kind: 'elicitation', requestId: 'e', message: 'm', options: [{ value: 'v' }] })).toBe(false)
    expect(bad({ kind: 'elicitation_resolved', requestId: 'e', outcome: 'expired' })).toBe(false)
  })

  it('rejects an empty frame carrying neither event nor status', () => {
    const r = WebchatOutput.safeParse({ conversationId: CONV, turnId: TURN, index: 3 })
    expect(r.success).toBe(false)
  })

  it('WebchatStatus tolerates a fully partial snapshot and carries models + permission modes + sessionId', () => {
    expect(WebchatStatus.safeParse({}).success).toBe(true)
    expect(WebchatStatus.safeParse({ contextUsed: 10 }).success).toBe(true)
    const r = WebchatStatus.safeParse({
      model: 'a',
      models: ['a', 'b'],
      permissionMode: 'plan',
      permissionModes: ['default', 'plan'],
      sessionId: 'acp-1'
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.models).toEqual(['a', 'b'])
    if (r.success) expect(r.data.permissionModes).toEqual(['default', 'plan'])
  })
})

describe('McpAppCard — the MCP Apps wire (webchat-mcp-apps.md §5)', () => {
  const card = {
    kind: 'app',
    appId: 'app-1',
    title: 'Deploy target',
    toolName: 'charts__pick_target',
    html: '<div>hi</div>'
  }

  it('accepts a minimal app event and one carrying the declared CSP + dimensions', () => {
    expect(WebchatOutput.safeParse({ conversationId: CONV, turnId: TURN, index: 0, event: card }).success).toBe(true)
    const rich = WebchatOutput.safeParse({
      conversationId: CONV,
      turnId: TURN,
      index: 1,
      event: {
        ...card,
        toolInput: { env: 'prod' },
        toolResult: { structuredContent: { targets: ['a'] } },
        csp: { connect: ['https://api.example.test'], resource: ['cdn.example.test'] },
        dimensions: { height: 400, flexibleHeight: true }
      }
    })
    expect(rich.success).toBe(true)
  })

  it('refuses a template past the wire guard, and an app event with no template at all', () => {
    const oversized = { ...card, html: 'x'.repeat(MCP_APP_HTML_MAX_BYTES + 1) }
    expect(WebchatOutput.safeParse({ conversationId: CONV, turnId: TURN, index: 0, event: oversized }).success).toBe(
      false
    )
    const { html: _html, ...noTemplate } = card
    expect(WebchatOutput.safeParse({ conversationId: CONV, turnId: TURN, index: 0, event: noTemplate }).success).toBe(
      false
    )
  })

  it('settles a card by appId, and refuses an outcome it has no verdict for', () => {
    const settled = { kind: 'app_resolved', appId: 'app-1', outcome: 'superseded' }
    expect(WebchatOutput.safeParse({ conversationId: CONV, turnId: TURN, index: 2, event: settled }).success).toBe(true)
    expect(
      WebchatOutput.safeParse({
        conversationId: CONV,
        turnId: TURN,
        index: 3,
        event: { ...settled, outcome: 'accepted' }
      }).success
    ).toBe(false)
  })

  it('carries a view RPC verdict back, correlated by the browser-minted callId', () => {
    const ok = { kind: 'app_rpc_result', appId: 'app-1', callId: 'c1', outcome: { ok: true, result: {} } }
    const refused = { kind: 'app_rpc_result', appId: 'app-1', callId: 'c1', outcome: { ok: false, error: 'nope' } }
    for (const event of [ok, refused]) {
      expect(WebchatOutput.safeParse({ conversationId: CONV, turnId: TURN, index: 4, event }).success).toBe(true)
    }
    // An outcome that is neither shape is not a partial answer the browser could act on.
    expect(
      WebchatOutput.safeParse({
        conversationId: CONV,
        turnId: TURN,
        index: 5,
        event: { kind: 'app_rpc_result', appId: 'a', callId: 'c', outcome: { ok: true, error: 'both' } }
      }).success
    ).toBe(false)
  })
})

describe('McpAppRpc — the four host methods a view may reach the daemon with', () => {
  it('accepts each method in its own shape', () => {
    expect(McpAppRpc.safeParse({ method: 'tools/call', name: 'charts__render' }).success).toBe(true)
    expect(McpAppRpc.safeParse({ method: 'resources/read', uri: 'ui://charts/tpl' }).success).toBe(true)
    expect(McpAppRpc.safeParse({ method: 'ui/message', text: 'ship it' }).success).toBe(true)
    expect(McpAppRpc.safeParse({ method: 'ui/update-model-context', context: 'picked prod' }).success).toBe(true)
  })

  it('refuses a method this host does not serve, and a served one with the wrong params', () => {
    // Browser-local by design (webchat-mcp-apps.md §7.3) — it must never reach a wire.
    expect(McpAppRpc.safeParse({ method: 'ui/open-link', url: 'https://example.test' }).success).toBe(false)
    expect(McpAppRpc.safeParse({ method: 'tools/call' }).success).toBe(false)
    expect(McpAppRpc.safeParse({ method: 'ui/message', text: '' }).success).toBe(false)
    expect(
      McpAppRpc.safeParse({ method: 'ui/update-model-context', context: 'x'.repeat(MCP_APP_CONTEXT_MAX_CHARS + 1) })
        .success
    ).toBe(false)
  })
})
