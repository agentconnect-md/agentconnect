// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { RuntimeSelectionSample } from './RuntimeSelectionSample'

vi.mock('@/lib/acp-registry', () => ({ useAcpRegistry: () => ({}), acpRuntime: () => undefined }))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root
let container: HTMLDivElement
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it('shows answer probabilities for a matching rule and falls back when evaluation is unavailable', async () => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () =>
    root.render(
      <RuntimeSelectionSample
        question={{ type: 'choice', instructions: 'Classify.', criteria: { deploy: 'Deployment', docs: 'Docs' } }}
        selection={{
          decisionId: '44444444-4444-4444-8444-444444444444',
          rules: [{ when: { type: 'choice', thresholds: { deploy: 0.5 } }, runtime: 'codex', model: 'model-capable' }]
        }}
        fallback={{ runtime: 'claude', model: 'model-standard' }}
        valid
      />
    )
  )
  const current = () => container.querySelector('[aria-current="step"]')?.textContent
  expect(container.textContent).toContain('78%')
  expect(current()).toContain('Rules')
  expect(container.textContent).toContain('model-capable')

  await act(async () =>
    [...container.querySelectorAll('button')].find((button) => button.textContent?.startsWith('ERROR'))!.click()
  )
  expect(container.textContent).toContain('Evaluation unavailable')
  expect(current()).toContain('Fallback')
  expect(container.textContent).toContain('model-standard')
})
