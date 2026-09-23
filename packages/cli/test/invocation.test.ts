import { describe, expect, it } from 'vitest'
import { delimiter, join } from 'node:path'
import { cliCommand, detectInvocation, setInvocation } from '../src/invocation.js'

const ENTRY = '/opt/node/lib/node_modules/@agentconnect.md/cli/dist/index.js'
const NPX_ENTRY = '/home/agent/.npm/_npx/0123abcd/node_modules/@agentconnect.md/cli/dist/index.js'

/** A fake filesystem keyed by host-flavored paths, as detection builds them with `node:path`; the entry resolves to itself. */
const resolver = (bins: Record<string, string>) => (p: string) =>
  p in bins ? bins[p] : p === ENTRY ? ENTRY : undefined

describe('detectInvocation', () => {
  it('reproduces an npx run on the channel it came from', () => {
    const base = { cliEntry: NPX_ENTRY, path: '', platform: 'linux' as const }
    expect(detectInvocation({ ...base, version: '1.61.0-rc.74' })).toBe('npx -y @agentconnect.md/cli@rc')
    expect(detectInvocation({ ...base, version: '1.60.0' })).toBe('npx -y @agentconnect.md/cli')
  })

  it('suggests the bare bin when the PATH copy is this very CLI', () => {
    const realpath = resolver({ [join('/opt/node/bin', 'agentconnect')]: ENTRY })
    const path = ['/usr/bin', '/opt/node/bin'].join(delimiter)
    expect(detectInvocation({ cliEntry: ENTRY, version: '1.60.0', path, platform: 'linux', realpath })).toBe(
      'agentconnect'
    )
  })

  it('names the entry when the first PATH agentconnect is a different install', () => {
    const realpath = resolver({ [join('/usr/local/bin', 'agentconnect')]: '/usr/local/lib/other/dist/index.js' })
    const path = ['/usr/local/bin', '/opt/node/bin'].join(delimiter)
    expect(detectInvocation({ cliEntry: ENTRY, version: '1.60.0', path, platform: 'linux', realpath })).toBe(
      `node ${ENTRY}`
    )
  })

  it('quotes an entry path the shell would split', () => {
    const entry = '/home/a b/cli/dist/index.js'
    expect(
      detectInvocation({ cliEntry: entry, version: '1.60.0', path: '', platform: 'linux', realpath: () => undefined })
    ).toBe(`node '${entry}'`)
  })
})

describe('cliCommand', () => {
  it('prefixes the selector with the detected invocation', () => {
    setInvocation({ cliEntry: NPX_ENTRY, path: '', platform: 'linux', version: '1.61.0-rc.74' })
    expect(cliCommand({ instance: 'cp2', root: '/srv/cp2' })).toBe(
      'npx -y @agentconnect.md/cli@rc --instance cp2 --root /srv/cp2'
    )
  })
})
