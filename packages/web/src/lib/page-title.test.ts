import { describe, expect, it } from 'vitest'
import { pageTitleMetadata } from './page-title'

describe('pageTitleMetadata', () => {
  it('keeps existing titles when no deployment label is configured', () => {
    expect(pageTitleMetadata(undefined)).toEqual({ title: 'AgentConnect' })
  })

  it('prepends a trimmed deployment label to default and child-page titles', () => {
    expect(pageTitleMetadata(' staging ')).toEqual({
      title: {
        default: '(staging) AgentConnect',
        template: '(staging) %s'
      }
    })
  })
})
