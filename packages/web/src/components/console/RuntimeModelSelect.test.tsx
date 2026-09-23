// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { RuntimeModelSelect } from './RuntimeModelSelect'

vi.mock('@/lib/acp-registry', () => ({ useAcpRegistry: () => ({}), acpRuntime: () => undefined }))
vi.mock('@/components/marks', () => ({ AgentMark: () => <span /> }))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root
let container: HTMLDivElement
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it('searches across runtimes, selects a complete pair and can return to the agent Decision', async () => {
  const onChange = vi.fn()
  const onSelect = vi.fn()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () =>
    root.render(
      <RuntimeModelSelect
        value={{ runtime: 'claude', model: 'model-standard' }}
        source={{
          runtimeModels: [
            { runtime: 'claude', version: '', models: ['model-standard'] },
            { runtime: 'codex', version: '', models: ['model-capable'], authRequired: true }
          ]
        }}
        onChange={onChange}
        decision={{ name: 'Complexity', selected: true, onSelect }}
      />
    )
  )
  await act(async () => container.querySelector('button')!.click())
  const dialog = document.querySelector('[role="dialog"]')!
  const search = dialog.querySelector('input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'capable')
    search.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(dialog.textContent).not.toContain('model-standard')
  await act(async () => dialog.querySelector<HTMLButtonElement>('button[aria-label="Codex · model-capable"]')!.click())
  expect(onChange).toHaveBeenLastCalledWith({ runtime: 'codex', model: 'model-capable' })
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  await act(async () => container.querySelector('button')!.click())
  expect(document.querySelector('[title="Login required"]')).not.toBeNull()
  await act(async () =>
    [...document.querySelectorAll('[role="dialog"] button')]
      .find((button) => button.textContent?.includes('By decision'))!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
  )
  expect(onSelect).toHaveBeenCalledOnce()
})

it('shows the selected Fast mode on the closed form selector', async () => {
  function Form() {
    const [fast, setFast] = useState(false)
    return (
      <RuntimeModelSelect
        value={{ runtime: 'codex', model: 'model-standard' }}
        onChange={vi.fn()}
        fastMode={fast}
        onFastModeChange={setFast}
        source={{ runtimeModels: [{ runtime: 'codex', version: '', models: ['model-standard'] }] }}
      />
    )
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(<Form />))
  const trigger = container.querySelector('button')!
  expect(trigger.textContent).not.toContain('FAST')
  await act(async () => trigger.click())
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Fast mode"]')!.click())
  await act(async () => trigger.click())
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(trigger.textContent).toContain('FAST')
})

it('opens read-only chat settings without allowing runtime or Fast overrides', async () => {
  const onChange = vi.fn()
  const onSelect = vi.fn()
  const onFastModeChange = vi.fn()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () =>
    root.render(
      <RuntimeModelSelect
        compact
        readOnly
        value={{ runtime: 'codex', model: 'model-standard' }}
        onChange={onChange}
        decision={{ name: 'Task type', selected: true, onSelect }}
        onFastModeChange={onFastModeChange}
        source={{ runtimeModels: [{ runtime: 'codex', version: '', models: ['model-standard'] }] }}
      />
    )
  )
  await act(async () => container.querySelector('button')!.click())
  const dialog = document.querySelector('[role="dialog"]')!
  expect(dialog.textContent).toContain('Runtime changes are disabled for this chat.')
  const model = dialog.querySelector<HTMLButtonElement>('[aria-label="Codex · model-standard"]')!
  const fast = dialog.querySelector<HTMLButtonElement>('[aria-label="Fast mode"]')!
  const decision = [...dialog.querySelectorAll('button')].find((button) => button.textContent?.includes('By decision'))!
  expect([model.disabled, fast.disabled, decision.disabled]).toEqual([true, true, true])
  await act(async () => {
    model.click()
    fast.click()
    decision.click()
  })
  expect(onChange).not.toHaveBeenCalled()
  expect(onSelect).not.toHaveBeenCalled()
  expect(onFastModeChange).not.toHaveBeenCalled()
})
