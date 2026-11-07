import { describe, expect, it } from 'vitest'
import { protectedCopyValue } from '../src/microsandbox/secret-values.js'
import type { MicrosandboxSecret } from '../src/microsandbox/secrets.js'

const binding: MicrosandboxSecret = {
  env: 'AC_EXAMPLE_API_KEY',
  placeholder: 'example-placeholder',
  host: ['api.example.test'],
  readValue: () => 'example-host-key'
}
const vm = {}
const srt = { protectRetained: true }
const refusal = 'example credentials changed; start a new session'

describe('protectedCopyValue', () => {
  it('places a fresh copy holding the host key, in a VM or srt', () => {
    for (const sources of [vm, srt])
      expect(protectedCopyValue('example-host-key', binding, false, sources, refusal)).toBe('example-placeholder')
  })

  it('refuses a fresh copy whose key changed or lost its binding, in a VM or srt', () => {
    for (const sources of [vm, srt]) {
      expect(() => protectedCopyValue('example-other-key', binding, false, sources, refusal)).toThrow(refusal)
      expect(() => protectedCopyValue('example-host-key', undefined, false, sources, refusal)).toThrow(refusal)
    }
  })

  it('keeps a retained VM copy that holds its placeholder and refuses anything else', () => {
    expect(protectedCopyValue('example-placeholder', binding, true, vm, refusal)).toBe('example-placeholder')
    expect(() => protectedCopyValue('example-host-key', binding, true, vm, refusal)).toThrow(refusal)
    expect(() => protectedCopyValue('example-placeholder', undefined, true, vm, refusal)).toThrow(refusal)
  })

  it('protects a retained srt copy and leaves an unbound key there as it is', () => {
    expect(protectedCopyValue('example-host-key', binding, true, srt, refusal)).toBe('example-placeholder')
    expect(protectedCopyValue('example-stale-key', binding, true, srt, refusal)).toBe('example-placeholder')
    expect(protectedCopyValue('example-host-key', undefined, true, srt, refusal)).toBeUndefined()
  })
})
