import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ClusterAccessError, loadClusterAccess, loadKubeconfig } from './access.js'

function writeConfig(body: string, name = 'config'): string {
  const dir = mkdtempSync(join(tmpdir(), 'ac-kubeconfig-'))
  const path = join(dir, name)
  writeFileSync(path, body)
  return path
}

const TOKEN_CONFIG = `
apiVersion: v1
kind: Config
current-context: provisioner
clusters:
  - name: example
    cluster:
      server: https://kubernetes.example.test:6443
      certificate-authority-data: ${Buffer.from('-----BEGIN CERTIFICATE-----\n').toString('base64')}
users:
  - name: provisioner
    user:
      token: sa-token-value
contexts:
  - name: provisioner
    context:
      cluster: example
      user: provisioner
      namespace: agentconnect-control
`

describe('loadKubeconfig', () => {
  it('reads the current context into a bearer-token client config', () => {
    const access = loadKubeconfig(writeConfig(TOKEN_CONFIG))
    expect(access.server).toBe('https://kubernetes.example.test:6443')
    expect(access.namespace).toBe('agentconnect-control')
    expect(access.ca).toBe('-----BEGIN CERTIFICATE-----\n')
    expect(access.token()).toBe('sa-token-value')
  })

  it('re-reads a tokenFile per call, so a rotated projection is picked up', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-kubeconfig-'))
    const tokenPath = join(dir, 'token')
    writeFileSync(tokenPath, 'first\n')
    const path = join(dir, 'config')
    writeFileSync(
      path,
      `
apiVersion: v1
current-context: c
clusters: [{ name: k, cluster: { server: https://kubernetes.example.test:6443 } }]
users: [{ name: u, user: { tokenFile: token } }]
contexts: [{ name: c, context: { cluster: k, user: u } }]
`
    )
    const access = loadKubeconfig(path)
    expect(access.token()).toBe('first')
    writeFileSync(tokenPath, 'second\n')
    expect(access.token()).toBe('second')
  })

  it('defaults the namespace when the context does not name one', () => {
    const path = writeConfig(`
apiVersion: v1
current-context: c
clusters: [{ name: k, cluster: { server: https://kubernetes.example.test:6443 } }]
users: [{ name: u, user: { token: t } }]
contexts: [{ name: c, context: { cluster: k, user: u } }]
`)
    expect(loadKubeconfig(path).namespace).toBe('default')
  })

  it('refuses a user the bearer transport cannot authenticate', () => {
    const path = writeConfig(`
apiVersion: v1
current-context: c
clusters: [{ name: k, cluster: { server: https://kubernetes.example.test:6443 } }]
users: [{ name: u, user: { exec: { command: aws } } }]
contexts: [{ name: c, context: { cluster: k, user: u } }]
`)
    expect(() => loadKubeconfig(path)).toThrow(/exec credential plugin/)
  })

  it('names what is missing rather than half-configuring a client', () => {
    expect(() => loadKubeconfig('/nonexistent/kubeconfig')).toThrow(ClusterAccessError)
    expect(() => loadKubeconfig(writeConfig('apiVersion: v1\n'))).toThrow(/no current-context/)
    expect(() =>
      loadKubeconfig(
        writeConfig(`
apiVersion: v1
current-context: c
clusters: [{ name: other, cluster: { server: https://kubernetes.example.test:6443 } }]
users: [{ name: u, user: { token: t } }]
contexts: [{ name: c, context: { cluster: k, user: u } }]
`)
      )
    ).toThrow(/no cluster server/)
  })
})

describe('loadClusterAccess', () => {
  it('is off by default, so an existing deployment is untouched', () => {
    expect(loadClusterAccess({ CLUSTER_EXECUTION_MODE: 'off' })).toBeUndefined()
  })

  it('overrides the control namespace when the deployment names one', () => {
    const access = loadClusterAccess({
      CLUSTER_EXECUTION_MODE: 'kubeconfig',
      CLUSTER_KUBECONFIG_PATH: writeConfig(TOKEN_CONFIG),
      CLUSTER_CONTROL_NAMESPACE: 'agentconnect-other'
    })
    expect(access?.namespace).toBe('agentconnect-other')
    expect(access?.token()).toBe('sa-token-value')
  })
})
