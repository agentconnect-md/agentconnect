import { describe, it, expect } from 'vitest'
import { slackThreadUrl } from '../src/platforms/slack/permalink.js'

describe('slackThreadUrl', () => {
  it('builds the archives permalink, stripping the ts dot and trailing slash', () => {
    expect(slackThreadUrl('https://acme.slack.com/', 'C0123ABC', '1710799200.123456')).toBe(
      'https://acme.slack.com/archives/C0123ABC/p1710799200123456'
    )
  })

  it('works when the workspace URL has no trailing slash', () => {
    expect(slackThreadUrl('https://acme.slack.com', 'C1', '1.2')).toBe('https://acme.slack.com/archives/C1/p12')
  })

  it('builds DM (im) links the same way', () => {
    expect(slackThreadUrl('https://acme.slack.com/', 'D9', '1710799200.000200')).toBe(
      'https://acme.slack.com/archives/D9/p1710799200000200'
    )
  })

  it('returns undefined when any piece is missing', () => {
    expect(slackThreadUrl(undefined, 'C1', '1.2')).toBeUndefined()
    expect(slackThreadUrl('', 'C1', '1.2')).toBeUndefined()
    expect(slackThreadUrl('https://acme.slack.com/', '', '1.2')).toBeUndefined()
    expect(slackThreadUrl('https://acme.slack.com/', 'C1', '')).toBeUndefined()
  })
})
