import { describe, it, expect } from 'vitest'
import { mentionedUserIds, substituteUserMentions } from '../src/slack/mentions.js'

describe('mentionedUserIds', () => {
  it('extracts distinct user ids from <@U…> / <@U…|label> tokens', () => {
    expect(mentionedUserIds('hi <@U123> and <@W9|alice> and <@U123> again')).toEqual(['U123', 'W9'])
  })

  it('returns [] for no mentions or undefined', () => {
    expect(mentionedUserIds('no mentions here')).toEqual([])
    expect(mentionedUserIds(undefined)).toEqual([])
  })

  it('ignores channel <#C…> and special <!here> tokens', () => {
    expect(mentionedUserIds('<#C1|general> <!here> <@U7>')).toEqual(['U7'])
  })
})

describe('substituteUserMentions', () => {
  it('rewrites known ids to @name and leaves unknown ids as the raw token', () => {
    const names = new Map([['U123', 'Alice Smith']])
    expect(substituteUserMentions('hey <@U123> and <@U999>', names)).toBe('hey @Alice Smith and <@U999>')
  })

  it('resolves the labelled form <@U…|x> to the cached name, not the label', () => {
    const names = new Map([['U123', 'Alice']])
    expect(substituteUserMentions('<@U123|old-label>', names)).toBe('@Alice')
  })

  it('leaves text unchanged when there are no mentions', () => {
    expect(substituteUserMentions('plain text', new Map())).toBe('plain text')
  })
})
