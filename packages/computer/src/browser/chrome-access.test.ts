import { describe, expect, it } from 'vitest'
import { ComputerPolicySchema } from '@agentconnect.md/protocol/computer'
import { browserToolsRefusal, type BrowserAccessInputs } from './chrome-access.js'

const allowed: BrowserAccessInputs = {
  granted: true,
  viewOnly: false,
  registered: true,
  policy: ComputerPolicySchema.parse({ browserTier: true }),
  configTier: false
}

describe('who gets the chrome_* tools (computer-use.md §5.8)', () => {
  it('allows the browser tier when the token and control policy allow it', () => {
    expect(browserToolsRefusal(allowed)).toBeUndefined()
  })

  it('needs the token’s br claim', () => {
    expect(browserToolsRefusal({ ...allowed, granted: false })).toMatch(/token/)
  })

  it('needs the last pushed policy’s browserTier, and reads an unset field or no policy as off', () => {
    expect(browserToolsRefusal({ ...allowed, policy: ComputerPolicySchema.parse({}) })).toMatch(/policy/)
    expect(browserToolsRefusal({ ...allowed, policy: ComputerPolicySchema.parse({ browserTier: false }) })).toMatch(
      /policy/
    )
    expect(browserToolsRefusal({ ...allowed, policy: undefined })).toMatch(/policy/)
  })

  it('gives a view token none, and none under a view policy', () => {
    expect(browserToolsRefusal({ ...allowed, viewOnly: true })).toMatch(/view/)
    const watching = ComputerPolicySchema.parse({ browserTier: true, agentMode: 'view' })
    expect(browserToolsRefusal({ ...allowed, policy: watching })).toMatch(/watch/)
  })

  it('leaves the tier out for a browser appAllowlist omits or redactApps names', () => {
    const only = (appAllowlist: string[]) => ComputerPolicySchema.parse({ browserTier: true, appAllowlist })
    expect(browserToolsRefusal({ ...allowed, policy: only(['libreoffice']) })).toMatch(/allowed apps/)
    expect(browserToolsRefusal({ ...allowed, policy: only(['libreoffice', 'google-chrome']) })).toBeUndefined()
    const masked = ComputerPolicySchema.parse({ browserTier: true, redactApps: ['Google Chrome'] })
    expect(browserToolsRefusal({ ...allowed, policy: masked })).toMatch(/masks/)
  })

  it('gives an unregistered daemon’s local client the tools when its config turns the tier on', () => {
    const local = { ...allowed, registered: false, policy: undefined }
    expect(browserToolsRefusal({ ...local, configTier: true })).toBeUndefined()
    expect(browserToolsRefusal({ ...local, configTier: false })).toMatch(/config/)
  })
})
