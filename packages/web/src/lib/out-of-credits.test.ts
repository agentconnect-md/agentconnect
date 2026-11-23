import { describe, expect, it } from 'vitest'
import { hasOwnMachine, isOutOfCreditsFailure, outOfCreditsOffer, type OutOfCreditsContext } from './out-of-credits'

const TAG = '[ERR:out_of_credits] Out of AgentConnect credits'
const CLOUD: OutOfCreditsContext = { onCloud: true, owner: true, canEdit: true, ownMachine: true }

describe('isOutOfCreditsFailure', () => {
  it.each([
    ['a live webchat failure', `⚠️ ${TAG}`, false],
    ['a reloaded failure row', `⚠️ Agent failed to respond: ${TAG}`, false],
    ['a runtime-decorated row', `⚠️ Agent failed to respond: API Error: 402 ${TAG}`, false],
    ['an AHP turn error', TAG, true]
  ])('reads %s', (_name, text, errorPart) => {
    expect(isOutOfCreditsFailure(text, errorPart)).toBe(true)
  })

  it.each([
    ['prose quoting the tag', `The daemon sends ${TAG} when credit runs out.`, false],
    ['another registered reason', '⚠️ [ERR:standing_lapsed] Access paused', false],
    ['an unregistered code', '⚠️ [ERR:out_of_time] Later', false],
    ['an untagged failure', '⚠️ Agent failed to respond: 402 Payment Required', false],
    ['an untagged AHP error', 'Out of AgentConnect credits', true]
  ])('leaves %s alone', (_name, text, errorPart) => {
    expect(isOutOfCreditsFailure(text, errorPart)).toBe(false)
  })
})

describe('outOfCreditsOffer', () => {
  it('names a never-funded organization apart from one that spent out', () => {
    expect(outOfCreditsOffer({ text: '[ERR:never_funded] No credit yet', errorPart: true }, CLOUD)?.code).toBe(
      'never_funded'
    )
  })

  it('offers both fixes to an owner who can edit and has a machine', () => {
    expect(outOfCreditsOffer({ text: TAG, errorPart: true }, CLOUD)).toEqual({
      code: 'out_of_credits',
      addCredits: 'link',
      moveToOwnMachine: true
    })
  })

  it('asks a member to reach an owner', () => {
    expect(outOfCreditsOffer({ text: TAG, errorPart: true }, { ...CLOUD, owner: false })?.addCredits).toBe('ask-owner')
  })

  it.each([
    ['without a machine of its own', { ownMachine: false }],
    ['to a viewer who cannot edit the agent', { canEdit: false }]
  ])('offers no move %s', (_name, over) => {
    expect(outOfCreditsOffer({ text: TAG, errorPart: true }, { ...CLOUD, ...over })?.moveToOwnMachine).toBe(false)
  })

  it('renders an agent off Cloud as text, tag or not', () => {
    expect(outOfCreditsOffer({ text: TAG, errorPart: true }, { ...CLOUD, onCloud: false })).toBeNull()
  })
})

describe('hasOwnMachine', () => {
  it('counts an approved or pre-approval machine, online or not', () => {
    expect(hasOwnMachine([{ pool: false }])).toBe(true)
    expect(hasOwnMachine([{ pool: false, approval: { status: 'approved' } as never }])).toBe(true)
  })

  it('ignores Cloud members and machines not approved', () => {
    expect(hasOwnMachine([{ pool: true }])).toBe(false)
    expect(hasOwnMachine([{ pool: false, approval: { status: 'pending' } as never }])).toBe(false)
    expect(hasOwnMachine([{ pool: false, approval: { status: 'revoked' } as never }])).toBe(false)
    expect(hasOwnMachine([])).toBe(false)
  })
})
