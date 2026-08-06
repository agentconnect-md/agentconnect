/**
 * `loadShredConfig` — the MINIMAL configuration the shred workload needs
 * (docs/designs/per-org-secret-encryption.md §6).
 *
 * Deliberately not `loadConfig()`. The control plane's parser demands the CP's
 * own settings — `API_KEY_PEPPER`, and under `SECRET_CIPHER=vault-transit` a CP
 * `VAULT_TOKEN` or `VAULT_JWT_ROLE` — so reusing it would force a least-
 * privilege shred workload to be handed the control plane's credential (or fake
 * one) just to start. That would hand back exactly the separation this job
 * exists to create: a Vault role binds to a service account, so the destructive
 * capability is only genuinely apart when the workload, its identity and its
 * configuration are all its own.
 *
 * What it therefore reads: where the database is, where Vault is, and this
 * job's OWN credential. Nothing else. The transit target is NOT read from here —
 * each tombstone carries the mount and key name pinned when its organization was
 * deleted, so a mount or prefix rotation cannot redirect a destroy.
 */
import { z } from 'zod'
import type { VaultAuth } from './vault-http.js'

const ShredConfigSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    VAULT_ADDR: z.string().url(),
    VAULT_NAMESPACE: z.string().optional(),
    // This job's own identity — never the control plane's.
    SECRET_SHRED_VAULT_TOKEN: z.string().optional(),
    SECRET_SHRED_VAULT_JWT_ROLE: z.string().optional(),
    SECRET_SHRED_VAULT_JWT_PATH: z.string().default('/var/run/secrets/kubernetes.io/serviceaccount/token'),
    SECRET_SHRED_VAULT_AUTH_MOUNT: z.string().default('kubernetes')
  })
  .superRefine((config, ctx) => {
    const modes = [config.SECRET_SHRED_VAULT_TOKEN, config.SECRET_SHRED_VAULT_JWT_ROLE].filter(
      (v) => v !== undefined
    ).length
    if (modes !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SECRET_SHRED_VAULT_TOKEN'],
        message:
          'the shred job needs exactly one of SECRET_SHRED_VAULT_TOKEN or SECRET_SHRED_VAULT_JWT_ROLE — its OWN Vault identity, never the control plane’s'
      })
    }
  })

export type ShredConfig = z.infer<typeof ShredConfigSchema>

export function loadShredConfig(env: NodeJS.ProcessEnv = process.env): ShredConfig {
  const parsed = ShredConfigSchema.safeParse(env)
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    throw new Error(`invalid shred configuration — ${detail}`)
  }
  return parsed.data
}

/** This job's Vault credential. Never falls back to the control plane's. */
export function shredVaultAuth(config: ShredConfig): VaultAuth {
  if (config.SECRET_SHRED_VAULT_TOKEN) return { method: 'token', token: config.SECRET_SHRED_VAULT_TOKEN }
  return {
    method: 'jwt',
    role: config.SECRET_SHRED_VAULT_JWT_ROLE!,
    jwtPath: config.SECRET_SHRED_VAULT_JWT_PATH,
    authMount: config.SECRET_SHRED_VAULT_AUTH_MOUNT
  }
}
