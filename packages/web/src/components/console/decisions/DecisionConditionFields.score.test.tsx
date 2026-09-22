// @vitest-environment happy-dom

// The score gate's condition control. The design collapsed the interval into one row and
// dropped the rubric chips, so the only place the levels are still legible is the printed
// inequality — which is why `intervalText` carries the meaning.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DecisionConditionFields } from './DecisionConditionFields'
import type { DecisionQuestion } from '@agentconnect.md/protocol/decision'

const question: DecisionQuestion = {
  type: 'score',
  instructions: 'How severe is it?',
  criteria: ['Calm', 'Concerned but polite', 'Clearly dissatisfied', 'Threatening to cancel']
}

let root: Root | undefined
let container: HTMLDivElement | undefined

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
})

async function render(min: number, max: number) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <DecisionConditionFields question={question} value={{ type: 'score', min, max }} onChange={vi.fn()} issues={[]} />
    )
  })
  return container
}

describe('the score condition control', () => {
  it('prints the interval it will match', async () => {
    const view = await render(2.5, 3)
    expect(view.textContent).toContain('2.5 ≤ score ≤ 3')
  })

  it('prints a half-open interval below the rubric maximum', async () => {
    const view = await render(1, 2.5)
    expect(view.textContent).toContain('1 ≤ score < 2.5')
  })

  // Both bounds are editable as numbers AND draggable, so the control appears twice each.
  it('offers a number field and a slider for each bound', async () => {
    const view = await render(0, 3)
    expect(view.querySelectorAll('input[aria-label="Interval start"]')).toHaveLength(2)
    expect(view.querySelectorAll('input[aria-label="Interval end"]')).toHaveLength(2)
  })

  // The design removed the rubric chips; a level's description must not reappear as a chip.
  it('no longer renders a chip per rubric level', async () => {
    const view = await render(0, 3)
    for (const level of question.type === 'score' ? question.criteria : []) {
      expect([...view.querySelectorAll('[title]')].some((node) => node.getAttribute('title') === level)).toBe(false)
    }
  })
})
