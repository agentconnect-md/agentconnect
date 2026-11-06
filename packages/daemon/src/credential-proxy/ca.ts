// The credential proxy's certificate authority and the trust bundle a runtime verifies with (github-app-git-credentials.md, Phase 2, Trust).
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { getCACertificates } from 'node:tls'
import { dirname, join } from 'node:path'
import { generateCa } from '@anthropic-ai/sandbox-runtime'

export interface ProxyCa {
  certPem: string
  keyPem: string
  certPath: string
  keyPath: string
  /** The system roots plus this CA: `SSL_CERT_FILE` and the like replace a tool's roots, so the CA alone would break every other host. */
  bundlePath: string
}

function writeAtomically(file: string, content: string, mode: number): void {
  const temporary = join(dirname(file), `.${randomBytes(6).toString('hex')}.tmp`)
  writeFileSync(temporary, content, { mode, flag: 'wx' })
  chmodSync(temporary, mode)
  renameSync(temporary, file)
}

/** Load the CA under `dir`, creating it once; the key stays 0600 and the bundle is rewritten each start so new system roots reach it. */
export function loadProxyCa(dir: string): ProxyCa {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o755)
  const certPath = join(dir, 'ca.crt')
  const keyPath = join(dir, 'ca.key')
  if (!existsSync(certPath) || !existsSync(keyPath)) {
    const ca = generateCa({ cn: 'AgentConnect credential proxy CA', validityDays: 3650 })
    writeAtomically(keyPath, ca.keyPem, 0o600)
    writeAtomically(certPath, ca.certPem, 0o644)
  }
  const certPem = readFileSync(certPath, 'utf8')
  const keyPem = readFileSync(keyPath, 'utf8')
  const roots = new Set([...getCACertificates('default'), ...getCACertificates('system')])
  const bundlePath = join(dir, 'trust.pem')
  writeAtomically(bundlePath, `${[...roots, certPem.trim()].join('\n')}\n`, 0o644)
  return { certPem, keyPem, certPath, keyPath, bundlePath }
}

/** The variables that point a runtime's clients at the bundle: OpenSSL and Go, curl, git, Python's requests, and Node. */
export function proxyTrustEnv(ca: Pick<ProxyCa, 'bundlePath' | 'certPath'>): Record<string, string> {
  return {
    SSL_CERT_FILE: ca.bundlePath,
    CURL_CA_BUNDLE: ca.bundlePath,
    GIT_SSL_CAINFO: ca.bundlePath,
    REQUESTS_CA_BUNDLE: ca.bundlePath,
    // Node adds these to its own roots; the bundle keeps any operator authority the daemon itself trusts.
    NODE_EXTRA_CA_CERTS: ca.bundlePath
  }
}
