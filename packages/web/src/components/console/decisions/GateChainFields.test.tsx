// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import type { ChannelDecisionGate, DecisionDefinition } from '@agentconnect.md/protocol/decision'
import { GateChainFields } from './GateChainFields'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

it('opens a child gate in a sheet and removes the whole continuation from the root', async () => {
  const definitions = ['First', 'Second'].map((name, index) => ({
    id: String(index),
    name,
    question: { type: 'boolean', instructions: 'Continue?', criteria: { true: 'Yes', false: 'No' } }
  })) as DecisionDefinition[]
  let saved: ChannelDecisionGate = {
    type: 'gate',
    decisionId: '0',
    when: { type: 'boolean', values: [true] }
  }
  function Form() {
    const [value, setValue] = useState(saved)
    return (
      <GateChainFields
        value={value}
        decisions={definitions}
        disabled={false}
        onChange={(next) => {
          saved = next
          setValue(next)
        }}
      />
    )
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<Form />))
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Continue with a Decision"]')!.click()
    )
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
        .find((button) => button.textContent === 'Second')!
        .click()
    )
    expect(saved.steps).toHaveLength(1)
    expect(saved.nextStepId).toBe(saved.steps![0]!.id)
    expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Second')
    expect(document.querySelector('[role="dialog"] nav')?.textContent).toContain('When matched')
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] nav button')]
        .find((button) => button.textContent === 'First')!
        .click()
    )
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Remove next Decision"]')!.click())
    expect(saved).toEqual({ type: 'gate', decisionId: '0', when: { type: 'boolean', values: [true] } })
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})
