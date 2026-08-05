import { describe, expect, it } from 'vitest'
import { loadTenantAdminProcessConfig } from '../src/admin/config.js'

const DATABASE_URL = 'postgresql://agentconnect:agentconnect@localhost:5432/agentconnect'

describe('tenant-admin process config', () => {
  it('is loopback-only by default and keeps the secret cipher bootstrap in env', () => {
    expect(loadTenantAdminProcessConfig({ DATABASE_URL })).toMatchObject({
      HOST: '127.0.0.1',
      PORT: 8091,
      TENANT_ADMIN_URL: 'http://localhost:8091',
      SECRET_CIPHER: 'none'
    })
  })

  it('requires a Vault address and exactly one Vault auth mode', () => {
    expect(() =>
      loadTenantAdminProcessConfig({ DATABASE_URL, SECRET_CIPHER: 'vault-transit', VAULT_TOKEN: 'token' })
    ).toThrow(/VAULT_ADDR/)
    expect(() =>
      loadTenantAdminProcessConfig({
        DATABASE_URL,
        SECRET_CIPHER: 'vault-transit',
        VAULT_ADDR: 'https://vault.example.test',
        VAULT_TOKEN: 'token',
        VAULT_JWT_ROLE: 'role'
      })
    ).toThrow(/exactly one/)
    expect(() =>
      loadTenantAdminProcessConfig({
        DATABASE_URL,
        SECRET_CIPHER: 'vault-transit',
        VAULT_ADDR: 'http://vault.example.test',
        VAULT_TOKEN: 'token'
      })
    ).toThrow(/HTTPS/)
  })

  it('requires HTTPS for a non-loopback Tenant Admin URL', () => {
    expect(() => loadTenantAdminProcessConfig({ DATABASE_URL, TENANT_ADMIN_URL: 'http://admin.example.test' })).toThrow(
      /HTTPS/
    )
    expect(() =>
      loadTenantAdminProcessConfig({ DATABASE_URL, TENANT_ADMIN_URL: 'https://admin.example.test/path' })
    ).toThrow(/origin/)
  })
})
