import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cleanupConfigFiles,
  configFilesDir,
  materializeConfigFiles,
  planConfigFiles
} from '../src/agents/config-file-env.js'

const KUBE = 'apiVersion: v1\nkind: Config\nusers:\n- name: a\n  user:\n    token: tok-123456\n'
const DOCKER = '{"auths":{"ghcr.io":{"auth":"YWxpY2U6czNjcjN0"}}}'

function tmpAgentDir(): string {
  return mkdtempSync(join(tmpdir(), 'ac-cfe-'))
}

describe('planConfigFiles', () => {
  it('selects present data vars and ignores absent ones', () => {
    const plan = planConfigFiles({ KUBECONFIG_DATA: KUBE, OTHER: 'x' })
    expect(plan.materialize.map((m) => m.sourceVar)).toEqual(['KUBECONFIG_DATA'])
    expect(plan.notices).toEqual([])
  })

  it('honors the legacy DOCKER_AUTH_CONFIG alias, preferring the new name when both are set', () => {
    expect(planConfigFiles({ DOCKER_AUTH_CONFIG: DOCKER }).materialize[0]?.sourceVar).toBe('DOCKER_AUTH_CONFIG')
    const both = planConfigFiles({ DOCKER_AUTH_CONFIG: 'old', DOCKER_CONFIG_DATA: DOCKER })
    expect(both.materialize[0]?.sourceVar).toBe('DOCKER_CONFIG_DATA')
    expect(both.materialize[0]?.value).toBe(DOCKER)
  })

  it('an explicitly set pointer var wins: no materialization, a notice instead', () => {
    const plan = planConfigFiles({ KUBECONFIG_DATA: KUBE, KUBECONFIG: '/home/me/.kube/config' })
    expect(plan.materialize).toEqual([])
    expect(plan.notices).toHaveLength(1)
    expect(plan.notices[0]).toContain('KUBECONFIG is set explicitly')
    expect(plan.notices[0]).toContain('KUBECONFIG_DATA')
    expect(plan.notices[0]).not.toContain(KUBE)
  })

  it('treats empty-string values as absent', () => {
    expect(planConfigFiles({ KUBECONFIG_DATA: '' }).materialize).toEqual([])
    const plan = planConfigFiles({ KUBECONFIG_DATA: KUBE, KUBECONFIG: '' })
    expect(plan.materialize).toHaveLength(1)
    expect(plan.notices).toEqual([])
  })
})

describe('materializeConfigFiles', () => {
  it('writes the kubeconfig file 0600 under a 0700 dir and points KUBECONFIG at the file', () => {
    const dir = tmpAgentDir()
    const res = materializeConfigFiles(dir, { KUBECONFIG_DATA: KUBE })
    const file = join(configFilesDir(dir), 'kubeconfig')
    expect(res.env).toEqual({ KUBECONFIG: file })
    expect(res.strip).toEqual(['KUBECONFIG_DATA'])
    expect(res.notices).toEqual([])
    expect(readFileSync(file, 'utf8')).toBe(KUBE)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(configFilesDir(dir)).mode & 0o777).toBe(0o700)
  })

  it('writes docker config.json and points DOCKER_CONFIG at its directory', () => {
    const dir = tmpAgentDir()
    const res = materializeConfigFiles(dir, { DOCKER_CONFIG_DATA: DOCKER })
    const dockerDir = join(configFilesDir(dir), 'docker')
    expect(res.env).toEqual({ DOCKER_CONFIG: dockerDir })
    expect(readFileSync(join(dockerDir, 'config.json'), 'utf8')).toBe(DOCKER)
    expect(statSync(dockerDir).mode & 0o777).toBe(0o700)
  })

  it('strips the legacy alias too when it carried the content', () => {
    const dir = tmpAgentDir()
    const res = materializeConfigFiles(dir, { DOCKER_AUTH_CONFIG: DOCKER, DOCKER_CONFIG_DATA: DOCKER })
    expect(res.strip.sort()).toEqual(['DOCKER_AUTH_CONFIG', 'DOCKER_CONFIG_DATA'])
  })

  it('converges: a secret removed since the last spawn loses its file', () => {
    const dir = tmpAgentDir()
    materializeConfigFiles(dir, { KUBECONFIG_DATA: KUBE, DOCKER_CONFIG_DATA: DOCKER })
    expect(existsSync(join(configFilesDir(dir), 'kubeconfig'))).toBe(true)
    const res = materializeConfigFiles(dir, { DOCKER_CONFIG_DATA: DOCKER })
    expect(existsSync(join(configFilesDir(dir), 'kubeconfig'))).toBe(false)
    expect(existsSync(join(configFilesDir(dir), 'docker', 'config.json'))).toBe(true)
    expect(res.env).toEqual({ DOCKER_CONFIG: join(configFilesDir(dir), 'docker') })
  })

  it('rewrites a rotated value in place', () => {
    const dir = tmpAgentDir()
    materializeConfigFiles(dir, { KUBECONFIG_DATA: KUBE })
    materializeConfigFiles(dir, { KUBECONFIG_DATA: 'rotated' })
    expect(readFileSync(join(configFilesDir(dir), 'kubeconfig'), 'utf8')).toBe('rotated')
  })

  it('cleans up files with nothing planned and stays silent', () => {
    const dir = tmpAgentDir()
    materializeConfigFiles(dir, { KUBECONFIG_DATA: KUBE })
    const res = materializeConfigFiles(dir, {})
    expect(existsSync(configFilesDir(dir))).toBe(false)
    expect(res).toEqual({ env: {}, strip: [], notices: [] })
  })

  it('conflict: pointer var set explicitly ⇒ no file, no strip, a notice', () => {
    const dir = tmpAgentDir()
    const res = materializeConfigFiles(dir, { KUBECONFIG_DATA: KUBE, KUBECONFIG: '/somewhere' })
    expect(res.env).toEqual({})
    expect(res.strip).toEqual([])
    expect(res.notices).toHaveLength(1)
    expect(existsSync(configFilesDir(dir))).toBe(false)
  })

  it('cleanupConfigFiles removes the materialized dir and is a no-op when absent', () => {
    const dir = tmpAgentDir()
    materializeConfigFiles(dir, { KUBECONFIG_DATA: KUBE, DOCKER_CONFIG_DATA: DOCKER })
    expect(existsSync(configFilesDir(dir))).toBe(true)
    expect(cleanupConfigFiles(dir)).toBeUndefined()
    expect(existsSync(configFilesDir(dir))).toBe(false)
    expect(cleanupConfigFiles(dir)).toBeUndefined() // already gone → still silent
  })

  it('a write failure leaves the data var in place and reports a notice', () => {
    const dir = tmpAgentDir()
    // An agentDir whose parent path segment is a regular FILE: preparing
    // <agentDir>/run/config-files fails with ENOTDIR either at rm or mkdir.
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, '')
    const res = materializeConfigFiles(blocker, { DOCKER_CONFIG_DATA: DOCKER })
    expect(res.env).toEqual({})
    expect(res.strip).toEqual([])
    expect(res.notices.length).toBeGreaterThan(0)
    expect(res.notices.join(' ')).not.toContain(DOCKER)
  })
})
