import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadEnvFile } from 'node:process'
import { serveTenantAdmin } from './admin/server.js'

function loadDefaultEnvironment(): void {
  const candidates = [resolve(process.env.INIT_CWD ?? process.cwd(), '.env'), resolve(process.cwd(), '.env')]
  const path = candidates.find((candidate, index) => candidates.indexOf(candidate) === index && existsSync(candidate))
  if (path) loadEnvFile(path)
}

loadDefaultEnvironment()

serveTenantAdmin().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`tenant-admin: ${message}`)
  process.exitCode = 1
})
