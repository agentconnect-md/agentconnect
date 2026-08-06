import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadEnvFile } from 'node:process'
import { serveSetupServer } from './server/index.js'

function loadDefaultEnvironment(): void {
  const candidates = [resolve(process.env.INIT_CWD ?? process.cwd(), '.env'), resolve(process.cwd(), '.env')]
  const path = candidates.find((candidate, index) => candidates.indexOf(candidate) === index && existsSync(candidate))
  if (path) loadEnvFile(path)
}

loadDefaultEnvironment()

serveSetupServer().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`setup-server: ${message}`)
  process.exitCode = 1
})
