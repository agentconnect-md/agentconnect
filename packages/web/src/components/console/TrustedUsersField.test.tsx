// @vitest-environment happy-dom
/**
 * The chip field behind "Trusted users": Enter commits the typed login (a leading @ is the user's,
 * not the host's), and a login typed but never entered is committed by the dialog's Save through the
 * flush handle — answering false, with the refusal on screen, when the host turns that login down, so
 * Save keeps the dialog open instead of closing over a user who was never added.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  add: vi.fn(async (_hookId: string, login: string) => ({ id: `id-${login}`, login }))
}))

vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ activeOrg: { id: 'o1' } }) }))
vi.mock('@/lib/api', () => ({
  fetchTrustedActors: vi.fn(async () => [{ id: 'id-example-maintainer', login: 'example-maintainer' }]),
  addTrustedActor: mocks.add,
  removeTrustedActor: vi.fn(async () => undefined)
}))

const { TrustedUsersField } = await import('./TrustedUsersField')
type Flush = () => Promise<boolean>

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root | undefined
let host: HTMLDivElement | undefined
let flushRef: { current: Flush | null } = { current: null }

async function render() {
  flushRef = { current: null }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <TrustedUsersField hookId="h1" provider="github" flushRef={flushRef} />
      </SWRConfig>
    )
  })
}

const input = () => document.querySelector<HTMLInputElement>('[data-trusted-users] input')!

/** React tracks the DOM value it wrote, so a raw assignment is swallowed. */
async function type(value: string): Promise<void> {
  const field = input()
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const press = (key: string) =>
  act(async () => input().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })))

async function flush(): Promise<boolean | undefined> {
  let answer: boolean | undefined
  await act(async () => {
    answer = await flushRef.current?.()
  })
  return answer
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  mocks.add.mockClear()
})

describe('TrustedUsersField', () => {
  it('adds the typed login on Enter, without the @ the user may have led with', async () => {
    await render()
    await type('@example-user')
    await press('Enter')
    expect(mocks.add).toHaveBeenCalledWith('h1', 'example-user')
    expect(input().value).toBe('')
    expect(document.body.textContent).toContain('example-user')
  })

  it('commits a login typed but never entered when the dialog flushes it', async () => {
    await render()
    await type('example-user')
    expect(await flush()).toBe(true)
    expect(mocks.add).toHaveBeenCalledWith('h1', 'example-user')
    expect(input().value).toBe('')
  })

  it('answers false with the refusal on screen when the host turns the login down', async () => {
    mocks.add.mockRejectedValueOnce(new Error('no such user'))
    await render()
    await type('ghost')
    expect(await flush()).toBe(false)
    expect(document.body.textContent).toContain('no such user')
    expect(input().value).toBe('ghost')
  })

  it('carries on when there is nothing to commit', async () => {
    await render()
    expect(await flush()).toBe(true)
    expect(mocks.add).not.toHaveBeenCalled()
  })

  it('lets go of the handle when it unmounts, so a later Save cannot reach a dead field', async () => {
    await render()
    await act(async () => root?.unmount())
    root = undefined
    expect(flushRef.current).toBeNull()
  })
})
