/**
 * `SecretCipher` — the at-rest seam every persisted secret value passes through.
 * The identity cipher must be EXACTLY identity: existing plaintext rows keep
 * reading back unchanged, so wiring it in is a pure no-op deploy.
 */
import { describe, it, expect } from 'vitest'
import { PlaintextSecretCipher } from './cipher.js'

describe('PlaintextSecretCipher', () => {
  it('seal and open are both identity (plaintext at rest, unchanged reads)', async () => {
    const cipher = new PlaintextSecretCipher()
    for (const value of ['xoxb-token', '', 'vault:v1:already-looks-sealed', 'multibyte ✓']) {
      expect(await cipher.seal(value)).toBe(value)
      expect(await cipher.open(value)).toBe(value)
    }
  })
})
