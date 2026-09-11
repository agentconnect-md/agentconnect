import { describe, it, expect } from 'vitest'
import { askHost, askModes, askRequestedSchema, AskRequired, type AskAnswer } from '../src/mcp/ask.js'

/** A port backed by one fixed answer map, as `McpControlServer` builds per call. */
const port = (answers: Record<string, AskAnswer>) => ({ answer: (key: string) => answers[key] })

const spec = {
  message: 'Which workspace?',
  fields: {
    integrationId: { kind: 'choice' as const, title: 'Integration', options: [{ value: 'a' }, { value: 'b' }] }
  },
  required: ['integrationId']
}

describe('askModes — the client capability test', () => {
  // Load-bearing: the Claude harness declares a BARE {}. A strict `elicitation.form` read would
  // silently disable every ask on that runtime while codex kept working.
  it('reads a bare elicitation declaration as form support', () => {
    expect(askModes({ elicitation: {} })).toEqual({ form: true, url: false })
  })

  it('reads an explicit form declaration as form support', () => {
    expect(askModes({ elicitation: { form: {} } })).toEqual({ form: true, url: false })
  })

  it('does NOT imply form once a mode is named explicitly', () => {
    expect(askModes({ elicitation: { url: {} } })).toEqual({ form: false, url: true })
    expect(askModes({ elicitation: { form: {}, url: {} } })).toEqual({ form: true, url: true })
  })

  it('answers undefined when the client declared no elicitation at all', () => {
    expect(askModes({})).toBeUndefined()
    expect(askModes(undefined)).toBeUndefined()
    expect(askModes({ elicitation: undefined })).toBeUndefined()
  })
})

describe('askRequestedSchema — the emitted wire schema', () => {
  // A ROOT-level key beyond these three kills the forward inside codex core before it ever
  // reaches ACP: it re-parses requestedSchema with a deny-unknown-fields type.
  it('carries no root key beyond type/properties/required', () => {
    const schema = askRequestedSchema(spec)
    expect(Object.keys(schema).sort()).toEqual(['properties', 'required', 'type'])
    expect(schema.type).toBe('object')
    expect(schema.required).toEqual(['integrationId'])
  })

  it('omits `required` entirely rather than emitting an empty array', () => {
    const schema = askRequestedSchema({ message: 'm', fields: { note: { kind: 'text' } } })
    expect(Object.keys(schema).sort()).toEqual(['properties', 'type'])
  })

  it('drops a required name that names no field', () => {
    const schema = askRequestedSchema({ message: 'm', fields: { note: { kind: 'text' } }, required: ['nope'] })
    expect(schema.required).toBeUndefined()
  })

  it('puts title and description on the PROPERTY, where a card renders them from', () => {
    const schema = askRequestedSchema({
      message: 'm',
      fields: { note: { kind: 'text', title: 'Note', description: 'Free text' } }
    })
    expect(schema.properties.note).toEqual({ type: 'string', title: 'Note', description: 'Free text' })
  })

  it('emits a plain enum for unlabelled options and titled oneOf when every option is labelled', () => {
    expect(askRequestedSchema(spec).properties.integrationId).toEqual({
      type: 'string',
      title: 'Integration',
      enum: ['a', 'b']
    })
    const labelled = askRequestedSchema({
      message: 'm',
      fields: {
        pick: {
          kind: 'choice',
          options: [
            { value: 'a', label: 'Alpha' },
            { value: 'b', label: 'Beta' }
          ]
        }
      }
    })
    expect(labelled.properties.pick).toEqual({
      type: 'string',
      oneOf: [
        { const: 'a', title: 'Alpha' },
        { const: 'b', title: 'Beta' }
      ]
    })
  })

  it('emits a boolean for a confirm field', () => {
    const schema = askRequestedSchema({ message: 'm', fields: { go: { kind: 'confirm' } } })
    expect(schema.properties.go).toEqual({ type: 'boolean' })
  })
})

describe('askHost', () => {
  it('reports unavailable — never throws — when this connection cannot ask', () => {
    expect(askHost(undefined, 'k', spec)).toEqual({ state: 'unavailable' })
  })

  it('throws AskRequired carrying the wire ask when nothing has been answered yet', () => {
    try {
      askHost(port({}), 'pick.integrationId', spec)
      expect.unreachable('askHost must not return on the first round')
    } catch (err) {
      expect(err).toBeInstanceOf(AskRequired)
      const { ask } = err as AskRequired
      expect(ask.key).toBe('pick.integrationId')
      expect(ask.message).toBe('Which workspace?')
      expect(Object.keys(ask.requestedSchema).sort()).toEqual(['properties', 'required', 'type'])
    }
  })

  it('returns the accepted content on the round that carries the answer', () => {
    const answers = { 'pick.integrationId': { action: 'accept' as const, content: { integrationId: 'b' } } }
    expect(askHost(port(answers), 'pick.integrationId', spec)).toEqual({
      state: 'answered',
      content: { integrationId: 'b' }
    })
  })

  it('turns a decline or a cancel into a usable outcome, not an exception', () => {
    expect(askHost(port({ k: { action: 'decline' } }), 'k', spec)).toEqual({ state: 'refused' })
    expect(askHost(port({ k: { action: 'cancel' } }), 'k', spec)).toEqual({ state: 'refused' })
  })

  it('asks again when the answer belongs to another key', () => {
    const answers = { other: { action: 'accept' as const, content: {} } }
    expect(() => askHost(port(answers), 'k', spec)).toThrow(AskRequired)
  })
})
