import { describe, expect, it } from 'vitest'
import { protectedCopyValue } from '../src/microsandbox/secret-values.js'
import type { MicrosandboxSecret } from '../src/microsandbox/secrets.js'

const binding: MicrosandboxSecret = {
  env: 'AC_EXAMPLE_API_KEY',
  placeholder: 'example-placeholder',
  host: ['api.example.test'],
  readValue: () => 'example-host-key'
}
const refusal = 'example credentials changed; retry launch'

describe('protectedCopyValue', () => {
  it('places a fresh copy holding the host key', () => {
    expect(protectedCopyValue('example-host-key', binding, false, refusal)).toBe('example-placeholder')
  })

  it('refuses a fresh copy whose key changed or lost its binding', () => {
    expect(() => protectedCopyValue('example-other-key', binding, false, refusal)).toThrow(refusal)
    expect(() => protectedCopyValue('example-host-key', undefined, false, refusal)).toThrow(refusal)
  })

  it('gives a bound key in a retained copy its placeholder whatever it holds and leaves an unbound one as it is', () => {
    for (const value of ['example-placeholder', 'example-host-key', 'example-stale-key'])
      expect(protectedCopyValue(value, binding, true, refusal)).toBe('example-placeholder')
    expect(protectedCopyValue('example-host-key', undefined, true, refusal)).toBeUndefined()
  })
})
