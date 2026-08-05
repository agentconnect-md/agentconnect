import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ orgPath: (path: string) => `/agentconnect${path}` })
}))

import SessionAccessNotice from './SessionAccessNotice'

describe('SessionAccessNotice', () => {
  it('offers a one-time identity refresh for a classified regional identity failure', () => {
    const html = renderToStaticMarkup(
      <SessionAccessNotice
        degraded
        issues={[{ provider: 'feishu', region: 'lark', reason: 'authorization' }]}
        impact="sessions"
      />
    )

    expect(html).toContain('Your Lark sign-in identity needs to be refreshed.')
    expect(html).toContain('Refresh Lark')
    expect(html).toContain('/agentconnect/profile?reauthorize=lark#sign-in-methods')
  })

  it('keeps an unclassified provider failure generic and fail-closed', () => {
    const html = renderToStaticMarkup(
      <SessionAccessNotice degraded issues={[{ provider: 'linear', reason: 'authorization' }]} impact="sessions" />
    )

    expect(html).toContain('Affected sessions are hidden until access can be verified.')
    expect(html).not.toContain('Reconnect')
  })
})
