import { describe, expect, it } from 'vitest'
import {
  DESCRIPTION_FOOTER_MARKER,
  descriptionInitiator,
  initiatorFooter,
  withDescriptionFooter,
  withOperationFooter
} from '../src/codehost/description-footer.js'

const FOOTER = '\n\n<sub>Example agent · runtime · model</sub>'

describe('the description footer', () => {
  it('escapes a human label without turning it into a mention and keeps its original value for edits', () => {
    const initiator = '@alex [team](https://example.test) <admin>'
    const description = withDescriptionFooter('Body', initiatorFooter(initiator))
    expect(description).toContain('Initiated by **&#64;alex \\[team\\](https://example.test) \\<admin\\>**')
    expect(descriptionInitiator(description)).toBe(initiator)
    expect(descriptionInitiator(initiatorFooter('Copied'))).toBeUndefined()
  })

  it('follows the text under a hidden marker', () => {
    expect(withDescriptionFooter('Body', FOOTER)).toBe(`Body\n\n${DESCRIPTION_FOOTER_MARKER}${FOOTER}`)
    expect(withDescriptionFooter(undefined, FOOTER)).toBe(`${DESCRIPTION_FOOTER_MARKER}${FOOTER}`)
  })

  it('replaces a footer the text already carries, so a rewrite keeps exactly one', () => {
    const published = withDescriptionFooter('Old body', FOOTER)
    expect(withDescriptionFooter(`New body\n\n${published}`, FOOTER)).toBe(
      `New body\n\nOld body\n\n${DESCRIPTION_FOOTER_MARKER}${FOOTER}`
    )
    expect(withDescriptionFooter(published.replace('Old body', 'Edited'), FOOTER)).toBe(
      `Edited\n\n${DESCRIPTION_FOOTER_MARKER}${FOOTER}`
    )
  })

  it('drops a copied footer and adds none when the footer is off', () => {
    expect(withDescriptionFooter(withDescriptionFooter('Body', FOOTER), '')).toBe('Body')
  })

  it('touches only a create and a description rewrite', () => {
    const create = withOperationFooter(
      { kind: 'createMergeRequest', sourceBranch: 'a', targetBranch: 'b', title: 't' },
      FOOTER
    )
    expect(create).toMatchObject({ description: `${DESCRIPTION_FOOTER_MARKER}${FOOTER}` })
    const titleOnly = { kind: 'updateMergeRequest' as const, iid: 1, title: 't' }
    expect(withOperationFooter(titleOnly, FOOTER)).toBe(titleOnly)
    const comment = { kind: 'createComment' as const, subject: 'issue' as const, iid: 1, body: 'x' }
    expect(withOperationFooter(comment, FOOTER)).toBe(comment)
  })
})
