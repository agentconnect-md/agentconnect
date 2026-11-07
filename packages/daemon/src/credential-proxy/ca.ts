// The credential proxy's certificate authority and the trust bundle a runtime verifies with (github-app-git-credentials.md, Phase 2, Trust).
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { getCACertificates } from 'node:tls'
import { dirname, join } from 'node:path'
import { generateCa } from '@anthropic-ai/sandbox-runtime'
import { tlsTrustEnv } from '../config/tls-trust-env.js'
import { PROXY_TRUST_VARS } from './trust-bundle.js'

export interface ProxyCa {
  /** The public half, the only directory a sandbox may read: the CA certificate and the bundle, never a key. */
  trustDir: string
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

/** Load the CA under `dir`, creating it once: the key stays in `dir` (0700), the certificate and bundle in its `trust` child, and the bundle is rewritten each start so new system roots reach it. */
export function loadProxyCa(dir: string): ProxyCa {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const trustDir = join(dir, 'trust')
  mkdirSync(trustDir, { recursive: true, mode: 0o755 })
  const certPath = join(trustDir, 'ca.crt')
  const keyPath = join(dir, 'ca.key')
  if (!existsSync(certPath) || !existsSync(keyPath)) {
    const ca = generateCa({ cn: 'AgentConnect credential proxy CA', validityDays: 3650 })
    writeAtomically(keyPath, ca.keyPem, 0o600)
    writeAtomically(certPath, ca.certPem, 0o644)
  }
  const certPem = readFileSync(certPath, 'utf8')
  const keyPem = readFileSync(keyPath, 'utf8')
  const bundlePath = join(trustDir, 'trust.pem')
  writeAtomically(bundlePath, `${[...upstreamAuthorities(), certPem.trim()].join('\n')}\n`, 0o644)
  return { trustDir, certPem, keyPem, certPath, keyPath, bundlePath }
}

const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g

/** The certificates in one PEM file, or none for a file that cannot be read. */
function pemCertificates(file: string): string[] {
  try {
    return readFileSync(file, 'utf8').match(PEM_CERTIFICATE) ?? []
  } catch {
    return []
  }
}

/** The operator's authorities as `tlsTrustEnv` names them (gitlab-com-integration.md §24.5): its bundle files, and the files of a certificate directory. */
export function operatorAuthorities(env: NodeJS.ProcessEnv = process.env): string[] {
  const trust = tlsTrustEnv(env)
  const files = [trust.NODE_EXTRA_CA_CERTS, trust.SSL_CERT_FILE, trust.GIT_SSL_CAINFO].filter(
    (file): file is string => file !== undefined
  )
  if (trust.SSL_CERT_DIR) {
    for (const dir of trust.SSL_CERT_DIR.split(':')) {
      try {
        for (const name of readdirSync(dir)) if (statSync(join(dir, name)).isFile()) files.push(join(dir, name))
      } catch {
        // A missing directory adds nothing, as it does for OpenSSL.
      }
    }
  }
  return files.flatMap(pemCertificates)
}

/** What a code host is verified with, upstream and in a runtime: the system roots plus the operator's authorities, since a self-managed instance often uses a private CA. */
export function upstreamAuthorities(env: NodeJS.ProcessEnv = process.env): string[] {
  const roots = [...getCACertificates('default'), ...getCACertificates('system'), ...operatorAuthorities(env)]
  return [...new Set(roots.map((pem) => pem.trim()))]
}

/** The variables that point a runtime's clients at the bundle: OpenSSL and Go, curl, git, Python's requests, and Node, which adds it to its own roots. */
export function proxyTrustEnv(ca: Pick<ProxyCa, 'bundlePath'>): Record<string, string> {
  return Object.fromEntries(PROXY_TRUST_VARS.map((name) => [name, ca.bundlePath]))
}
