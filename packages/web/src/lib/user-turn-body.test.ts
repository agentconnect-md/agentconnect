import { describe, expect, it } from 'vitest'
import { linearDescriptionMarkdown, parseUserTurnBody, shortSha } from './user-turn-body'

describe('parseUserTurnBody', () => {
  it('keeps the facts and never the prompt', () => {
    const body = JSON.stringify({
      prompt: 'the whole prompt',
      linear: { issue: { identifier: 'ENG-3', title: 'x' }, delegatedBy: 'Dana' },
      codehost: { provider: 'github', event: 'issues:opened', subject: { number: 42 } }
    })
    expect(parseUserTurnBody(body)).toEqual({
      linear: { issue: { identifier: 'ENG-3', title: 'x' }, delegatedBy: 'Dana' },
      codehost: { provider: 'github', event: 'issues:opened', subject: { number: 42 } }
    })
  })

  it('fails closed on anything that is not a turn body', () => {
    expect(parseUserTurnBody(undefined)).toBeUndefined()
    expect(parseUserTurnBody('')).toBeUndefined()
    expect(parseUserTurnBody('{not json')).toBeUndefined()
    expect(parseUserTurnBody('null')).toBeUndefined()
    expect(parseUserTurnBody('[1]')).toBeUndefined()
    // A tool body on a text row, or a prompt with no facts: nothing to fold.
    expect(parseUserTurnBody(JSON.stringify({ toolCallId: 'tc-1', status: 'completed' }))).toBeUndefined()
    expect(parseUserTurnBody(JSON.stringify({ prompt: 'only a prompt' }))).toBeUndefined()
    // Facts of the wrong shape are dropped rather than rendered — validated whole, so a fold
    // can never open onto a formatter that dereferences what is not there.
    expect(parseUserTurnBody(JSON.stringify({ linear: 'ENG-3' }))).toBeUndefined()
    expect(parseUserTurnBody(JSON.stringify({ linear: { issue: null } }))).toBeUndefined()
    expect(parseUserTurnBody(JSON.stringify({ linear: { issue: { identifier: 7 } } }))).toBeUndefined()
    expect(parseUserTurnBody(JSON.stringify({ codehost: { subject: {} } }))).toBeUndefined()
    expect(parseUserTurnBody(JSON.stringify({ codehost: { provider: 'github' } }))).toBeUndefined()
    expect(
      parseUserTurnBody(JSON.stringify({ codehost: { provider: 'github', event: 'x', subject: null } }))
    ).toBeUndefined()
    // One bad fact does not take the other down with it.
    expect(
      parseUserTurnBody(
        JSON.stringify({ linear: { issue: null }, codehost: { provider: 'gitlab', event: 'note', subject: {} } })
      )
    ).toEqual({ codehost: { provider: 'gitlab', event: 'note', subject: {} } })
  })
})

describe('linearDescriptionMarkdown', () => {
  it('lifts the description out of the XML-shaped context and decodes its entities', () => {
    const context =
      '<issue identifier="ENG-3">\n<title>investigate</title> <description>See [the repo](https://example.test) &amp; the &lt;docs&gt;.</description> <team name="ENG"/> </issue>'
    expect(linearDescriptionMarkdown(context)).toEqual({
      markdown: 'See [the repo](https://example.test) & the <docs>.',
      parsed: true
    })
  })

  it('reads an envelope with no description element as an issue that has none', () => {
    // Everything this envelope carries — the identifier, the title, the team — is already a row
    // of its own, so printing it raw under "Description" was the whole of the bug.
    const context = '<issue identifier="AC-1">\n<title>who are you</title>\n<team name="AAA"/>\n</issue>'
    expect(linearDescriptionMarkdown(context)).toEqual({ markdown: '', parsed: true })
    expect(linearDescriptionMarkdown('<issue><description/></issue>')).toEqual({ markdown: '', parsed: true })
  })

  it('keeps a description the relay cut before its closing tag', () => {
    // `promptContext` is byte-truncated at the relay's budget, so a long description can arrive
    // as an open element with no close. Every word that DID arrive still reads.
    const cut = '<issue identifier="ENG-3">\n<title>investigate</title>\n<description>The first half of a long'
    expect(linearDescriptionMarkdown(cut)).toEqual({ markdown: 'The first half of a long', parsed: true })
  })

  it('takes a description element that carries attributes', () => {
    expect(linearDescriptionMarkdown('<issue><description format="markdown">ship it</description></issue>')).toEqual({
      markdown: 'ship it',
      parsed: true
    })
  })

  it('shows a context that is not the envelope at all whole rather than guessing', () => {
    expect(linearDescriptionMarkdown('plain words')).toEqual({ markdown: 'plain words', parsed: false })
  })
})

describe('shortSha', () => {
  it('is the seven characters a person quotes', () => {
    expect(shortSha('7830b10b5bc939c5576324a06f8b60c05dccb161')).toBe('7830b10')
  })
})
