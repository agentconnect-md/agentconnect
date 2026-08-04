import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { z } from 'zod'

export const DEFAULT_CONFIG_PATH = 'agentconnect.setup.yaml'
export const SETUP_API_VERSION = 'setup.agentconnect.md/v1alpha1'

export const SetupModeSchema = z.enum(['local', 'local-auth', 'external'])
export type SetupMode = z.infer<typeof SetupModeSchema>

const safeUrl = z
  .string()
  .url()
  .superRefine((value, ctx) => {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      ctx.addIssue({ code: 'custom', message: 'URLs must use HTTP or HTTPS' })
    }
    if (url.username || url.password) {
      ctx.addIssue({ code: 'custom', message: 'URLs must not contain credentials' })
    }
    if (url.search) ctx.addIssue({ code: 'custom', message: 'URLs must not contain query parameters' })
    if (url.hash) ctx.addIssue({ code: 'custom', message: 'URLs must not contain fragments' })
  })

const loopbackUrl = safeUrl.refine((value) => {
  const hostname = new URL(value).hostname.replace(/^\[|\]$/g, '')
  return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '127.0.0.1' || hostname === '::1'
}, 'local modes accept loopback URLs only')

const httpsUrl = safeUrl.refine((value) => new URL(value).protocol === 'https:', 'external URLs must use HTTPS')
const oidcIssuer = safeUrl.refine(
  (value) => new URL(value).pathname.replace(/\/$/, '').endsWith('/oidc'),
  'Logto issuer must end in /oidc'
)

const metadata = {
  apiVersion: z.literal(SETUP_API_VERSION),
  kind: z.literal('AgentConnectSetup')
}

const localServices = z
  .object({
    web: loopbackUrl,
    controlPlane: loopbackUrl,
    relay: loopbackUrl
  })
  .strict()

export const SetupConfigSchema = z.discriminatedUnion('mode', [
  z
    .object({
      ...metadata,
      mode: z.literal('local'),
      services: localServices
    })
    .strict(),
  z
    .object({
      ...metadata,
      mode: z.literal('local-auth'),
      services: localServices,
      auth: z.object({ issuer: oidcIssuer.and(loopbackUrl) }).strict()
    })
    .strict(),
  z
    .object({
      ...metadata,
      mode: z.literal('external'),
      services: z
        .object({
          web: httpsUrl,
          controlPlane: httpsUrl,
          relay: httpsUrl.optional()
        })
        .strict(),
      auth: z.object({ issuer: oidcIssuer.and(httpsUrl) }).strict()
    })
    .strict()
])

export type SetupConfig = z.infer<typeof SetupConfigSchema>

export interface ExternalConfigInput {
  web?: string
  controlPlane?: string
  relay?: string
  issuer?: string
}

export function createSetupConfig(mode: SetupMode, input: ExternalConfigInput = {}): SetupConfig {
  if (mode === 'local') {
    return SetupConfigSchema.parse({
      apiVersion: SETUP_API_VERSION,
      kind: 'AgentConnectSetup',
      mode,
      services: {
        web: 'http://localhost:3000',
        controlPlane: 'http://localhost:8080',
        relay: 'http://localhost:8090'
      }
    })
  }

  if (mode === 'local-auth') {
    return SetupConfigSchema.parse({
      apiVersion: SETUP_API_VERSION,
      kind: 'AgentConnectSetup',
      mode,
      services: {
        web: 'http://localhost:3000',
        controlPlane: 'http://localhost:8080',
        relay: 'http://localhost:8090'
      },
      auth: { issuer: 'http://login.agentconnect.localhost:3001/oidc' }
    })
  }

  const missing = [
    ['--web-url', input.web],
    ['--control-plane-url', input.controlPlane],
    ['--issuer', input.issuer]
  ]
    .filter(([, value]) => !value)
    .map(([flag]) => flag)

  if (missing.length > 0) throw new Error(`external mode requires ${missing.join(', ')}`)

  return SetupConfigSchema.parse({
    apiVersion: SETUP_API_VERSION,
    kind: 'AgentConnectSetup',
    mode,
    services: {
      web: input.web,
      controlPlane: input.controlPlane,
      ...(input.relay ? { relay: input.relay } : {})
    },
    auth: { issuer: input.issuer }
  })
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`).join('; ')
}

export async function loadSetupConfig(path: string): Promise<SetupConfig> {
  const absolute = resolve(path)
  let source: string
  try {
    source = await readFile(absolute, 'utf8')
  } catch (error) {
    throw new Error(`cannot read ${absolute}: ${(error as Error).message}`)
  }

  let parsed: unknown
  try {
    parsed = parseYaml(source)
  } catch (error) {
    throw new Error(`invalid YAML in ${absolute}: ${(error as Error).message}`)
  }

  const result = SetupConfigSchema.safeParse(parsed)
  if (!result.success) throw new Error(`invalid setup config: ${formatIssues(result.error)}`)
  return result.data
}

export async function writeSetupConfig(path: string, config: SetupConfig): Promise<string> {
  const absolute = resolve(path)
  await mkdir(dirname(absolute), { recursive: true })
  const source = stringifyYaml(config, { lineWidth: 0 })
  try {
    await writeFile(absolute, source, { encoding: 'utf8', flag: 'wx', mode: 0o644 })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST') throw new Error(`${absolute} already exists; move it or choose another --config path`)
    throw error
  }
  return absolute
}
