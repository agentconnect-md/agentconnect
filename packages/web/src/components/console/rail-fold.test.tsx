// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { RailFoldContext, useRailFold } from './rail-fold'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function Folding({ active }: { active: boolean }) {
  useRailFold(active)
  return null
}

it('folds the navigation while active and releases it when it closes', () => {
  const setFold = vi.fn()
  const root = createRoot(document.createElement('div'))
  const draw = (active: boolean) =>
    act(() =>
      root.render(
        <RailFoldContext.Provider value={setFold}>
          <Folding active={active} />
        </RailFoldContext.Provider>
      )
    )
  draw(false)
  expect(setFold).not.toHaveBeenCalled()
  draw(true)
  expect(setFold).toHaveBeenLastCalledWith(true)
  draw(false)
  expect(setFold).toHaveBeenLastCalledWith(false)
  act(() => root.unmount())
})
