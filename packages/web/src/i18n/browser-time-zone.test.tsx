// @vitest-environment happy-dom

import { useFormatter } from 'next-intl'
import { act } from 'react'
import { hydrateRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BrowserTimeZoneProvider } from './browser-time-zone'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const AT = Date.UTC(2026, 0, 2, 1, 11)

function Stamp() {
  return <time>{useFormatter().dateTime(AT, { hour: 'numeric', minute: '2-digit' })}</time>
}

const tree = () => (
  <BrowserTimeZoneProvider>
    <Stamp />
  </BrowserTimeZoneProvider>
)

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  const resolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (this: Intl.DateTimeFormat) {
    return { ...resolvedOptions.call(this), timeZone: 'Asia/Tokyo' }
  })
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  container.remove()
  vi.restoreAllMocks()
})

/** Server markup rendered with `window` hidden, as Node renders it; the test provider stands in for the server-inherited zone (UTC). */
function serverMarkup() {
  vi.stubGlobal('window', undefined)
  try {
    return renderToString(tree())
  } finally {
    vi.unstubAllGlobals()
  }
}

it('hydrates over server markup in the server zone, then formats in the viewer zone', () => {
  container.innerHTML = serverMarkup()
  expect(container.textContent).toBe('1:11 AM')

  const recovered: unknown[] = []
  const errors: string[] = []
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '))
  })
  act(() => {
    root = hydrateRoot(container, tree(), { onRecoverableError: (error) => recovered.push(error) })
  })

  expect(recovered).toEqual([])
  expect(errors).toEqual([])
  expect(container.textContent).toBe('10:11 AM')
})
