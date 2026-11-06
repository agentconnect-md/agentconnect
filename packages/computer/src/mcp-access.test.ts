import { describe, expect, it } from 'vitest'
import { mayWatch, viewerAuthenticator } from './mcp-access.js'
import type { ViewerPrincipal } from './viewer.js'

describe('viewer tokens per desktop (computer-use.md §3.9)', () => {
  const console = (desktop: string): ViewerPrincipal => ({ client: 'console:u', control: true, desktop })
  const local = (header: string | undefined) => (header === 'Bearer local' ? 'claude' : undefined)

  it('opens only the viewer of the desktop a console token names, and every one for a local client', () => {
    const member = (header: string | undefined) => (header === 'Bearer d1' ? console('d1') : undefined)
    expect(viewerAuthenticator(member, local)('Bearer d1', 'relay')).toBeUndefined()
    expect(viewerAuthenticator(member, local, 'd1')('Bearer d1', 'relay')).toMatchObject({ desktop: 'd1' })
    expect(viewerAuthenticator(member, local, null)('Bearer d1', 'relay')).toMatchObject({ desktop: 'd1' })
    expect(viewerAuthenticator(member, local, 'd1')('Bearer local', 'local')).toEqual({
      client: 'claude',
      control: true
    })
    expect(mayWatch({ client: 'claude', control: true }, 'd7')).toBe(true)
    expect(mayWatch(console('main'), 'd7')).toBe(false)
  })
})
