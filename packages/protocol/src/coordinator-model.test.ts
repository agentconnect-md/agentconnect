import { describe, expect, it } from 'vitest'
import { CoordinatorModel, defaultCoordinatorModel } from './coordinator-model.js'

describe('defaultCoordinatorModel', () => {
  it("takes Claude Code's haiku alias over a numbered haiku", () => {
    const models = [{ id: 'sonnet' }, { id: 'claude-haiku-4-5' }, { id: 'haiku' }, { id: 'opus[1m]' }]
    expect(defaultCoordinatorModel('claude-acp', models)).toBe('haiku')
  })

  it('takes the newest Codex terra, never a mini or luna model', () => {
    const models = [{ id: 'gpt-5.6-sol' }, { id: 'gpt-5.6-terra' }, { id: 'gpt-6.1-terra' }, { id: 'gpt-5.6-luna' }]
    expect(defaultCoordinatorModel('codex-acp', models)).toBe('gpt-6.1-terra')
    expect(defaultCoordinatorModel('codex-acp', [{ id: 'gpt-5-mini' }])).toBeUndefined()
  })

  it('names nothing for another runtime, which follows the task model', () => {
    expect(defaultCoordinatorModel('opencode', [{ id: 'haiku' }])).toBeUndefined()
  })
})

it('parses a coordinator model and refuses an approval on it', () => {
  expect(CoordinatorModel.parse({ runtime: 'codex-acp', model: 'gpt-5.6-terra', effort: 'low' })).toEqual({
    runtime: 'codex-acp',
    model: 'gpt-5.6-terra',
    effort: 'low'
  })
  expect(() => CoordinatorModel.parse({ runtime: 'codex-acp', model: 'm', permissionMode: 'agent' })).toThrow()
})
