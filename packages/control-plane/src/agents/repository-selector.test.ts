import { describe, expect, it } from 'vitest'
import { DECISION_PROVIDER_PROFILES } from '@agentconnect.md/protocol'
import { REPOSITORY_SELECTOR_UNSUPPORTED, repositorySelectorRefusal } from './repository-selector.js'
import { CreateAgentBody, UpdateAgentBody } from '../http/dto/index.js'

describe('repository selector validation (multi-repository-workspaces.md decision 15)', () => {
  it('accepts every catalog model that answers Choice, and nothing to check', () => {
    for (const provider of DECISION_PROVIDER_PROFILES) {
      for (const model of provider.models) {
        expect(repositorySelectorRefusal({ providerId: provider.id, model: model.id })).toBeNull()
      }
    }
    expect(repositorySelectorRefusal(undefined)).toBeNull()
    expect(repositorySelectorRefusal(null)).toBeNull()
  })

  it('refuses an unknown provider or model', () => {
    expect(repositorySelectorRefusal({ providerId: 'example-provider', model: 'jev-latest' })).toBe(
      REPOSITORY_SELECTOR_UNSUPPORTED
    )
    expect(repositorySelectorRefusal({ providerId: 'typesafe', model: 'example-model' })).toBe(
      REPOSITORY_SELECTOR_UNSUPPORTED
    )
  })

  it('refuses a model whose profile cannot answer Choice', () => {
    const catalog = [
      {
        id: 'example-provider',
        models: [
          { id: 'example-score', questionTypes: ['boolean' as const, 'score' as const] },
          { id: 'example-choice', questionTypes: ['choice' as const] }
        ]
      }
    ]
    expect(repositorySelectorRefusal({ providerId: 'example-provider', model: 'example-score' }, catalog)).toBe(
      REPOSITORY_SELECTOR_UNSUPPORTED
    )
    expect(repositorySelectorRefusal({ providerId: 'example-provider', model: 'example-choice' }, catalog)).toBeNull()
  })

  it('takes the pair on create, clears it with null on edit, and refuses a half pair or an extra key', () => {
    const selector = { providerId: 'typesafe', model: 'jev-latest' }
    expect(CreateAgentBody.parse({ name: 'reviewer', runtime: 'claude', repositorySelector: selector })).toMatchObject({
      repositorySelector: selector
    })
    expect(CreateAgentBody.safeParse({ name: 'reviewer', runtime: 'claude', repositorySelector: null }).success).toBe(
      false
    )
    expect(UpdateAgentBody.parse({ repositorySelector: null })).toEqual({ repositorySelector: null })
    expect(UpdateAgentBody.parse({ repositorySelector: selector })).toEqual({ repositorySelector: selector })
    expect(UpdateAgentBody.safeParse({ repositorySelector: { providerId: 'typesafe' } }).success).toBe(false)
    expect(UpdateAgentBody.safeParse({ repositorySelector: { ...selector, question: {} } }).success).toBe(false)
  })
})
