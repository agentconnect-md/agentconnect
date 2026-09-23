import { expect, it } from 'vitest'
import { storedModelAfterPick } from './fallback-model'

it('keeps an unset model unset when only run settings change', () => {
  expect(
    storedModelAfterPick(
      { runtime: 'claude', model: 'preferred-model', effort: 'high', fastMode: true },
      'claude',
      'preferred-model',
      ''
    )
  ).toBe('')
})

it('stores a different model or runtime the user picked', () => {
  expect(storedModelAfterPick({ runtime: 'claude', model: 'other-model' }, 'claude', 'preferred-model', '')).toBe(
    'other-model'
  )
  expect(storedModelAfterPick({ runtime: 'codex', model: 'preferred-model' }, 'claude', 'preferred-model', '')).toBe(
    'preferred-model'
  )
})
