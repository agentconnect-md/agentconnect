import { describe, expect, it } from 'vitest'
import { loadSetupServerProcessConfig } from '../src/server/config.js'

const DATABASE_URL = 'postgresql://agentconnect:agentconnect@localhost:5432/agentconnect'

describe('setup-server process config', () => {
  it('is loopback-only by default and keeps the secret cipher bootstrap in env', () => {
    expect(loadSetupServerProcessConfig({ DATABASE_URL })).toMatchObject({
      HOST: '127.0.0.1',
      PORT: 8091,
      SETUP_SERVER_URL: 'http://localhost:8091',
      LOGTO_ADMIN_ENDPOINT: 'http://localhost:3002',
      SECRET_CIPHER: 'none'
    })
  })

  it('requires a Vault address and exactly one Vault auth mode', () => {
    expect(() =>
      loadSetupServerProcessConfig({ DATABASE_URL, SECRET_CIPHER: 'vault-transit', VAULT_TOKEN: 'token' })
    ).toThrow(/VAULT_ADDR/)
    expect(() =>
      loadSetupServerProcessConfig({
        DATABASE_URL,
        SECRET_CIPHER: 'vault-transit',
        VAULT_ADDR: 'https://vault.example.test',
        VAULT_TOKEN: 'token',
        VAULT_JWT_ROLE: 'role'
      })
    ).toThrow(/exactly one/)
    expect(
      loadSetupServerProcessConfig({
        DATABASE_URL,
        SECRET_CIPHER: 'vault-transit',
        VAULT_ADDR: 'http://vault.example.test',
        VAULT_TOKEN: 'token'
      })
    ).toMatchObject({ VAULT_ADDR: 'http://vault.example.test' })
  })

  it('requires HTTPS for a non-loopback Setup Server URL', () => {
    expect(() => loadSetupServerProcessConfig({ DATABASE_URL, SETUP_SERVER_URL: 'http://setup.example.test' })).toThrow(
      /HTTPS/
    )
    expect(() =>
      loadSetupServerProcessConfig({ DATABASE_URL, SETUP_SERVER_URL: 'https://setup.example.test/path' })
    ).toThrow(/origin/)
  })
})
