/**
 * Safe, side-effect-free deployment-config subpath for operator tooling.
 *
 * Importing the package root starts the Control Plane process, so Setup Server
 * uses this narrow composition facade instead. The typed service remains the
 * only place that validates the document, seals secrets, computes fingerprints,
 * and applies an atomic replacement.
 */
import { createPrisma, disconnectPrisma } from './persistence/prisma.js'
import { PgDeploymentConfigStore } from './persistence/repositories/deployment-config.repo.js'
import { makeSecretCipher, type SecretCipherConfig } from './secrets/cipher.js'

export {
  DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1,
  DEPLOYMENT_CONFIG_SCHEMA_VERSION,
  DEPLOYMENT_SECRET_KEYS,
  GITLAB_BASE_URL_LOCKED_REASON,
  DeploymentConfigConflictError,
  DeploymentConfigGiteaBaseUrlLockedError,
  DeploymentConfigGitlabBaseUrlLockedError,
  DeploymentConfigMissingSecretsError,
  DeploymentConfigSecretRefreshRequiredError,
  DeploymentConfigValuesV1Schema,
  DeploymentSecretKeySchema,
  DeploymentSecretPatchSchema
} from './persistence/deployment-config.js'
export { deploymentAdminClaimKey } from './persistence/deployment-config.js'
export type {
  DeploymentConfigAdmin,
  DeploymentConfigReplaceInput,
  DeploymentConfigRuntime,
  DeploymentConfigStore,
  DeploymentConfigValuesV1,
  DeploymentSecretAdminStatus,
  DeploymentSecretKey,
  DeploymentSecretPatch
} from './persistence/deployment-config.js'
export type { SecretCipherConfig } from './secrets/cipher.js'

export interface OpenDeploymentConfigStoreOptions extends SecretCipherConfig {
  databaseUrl: string
  /** The deployment's `GITLAB_BASE_URL` fallback: with no persisted document it
   *  is the axis already in effect, so the first write is fenced against it. */
  gitlabBaseUrl?: string
  /** The same for `GITEA_BASE_URL` (gitea-integration.md §3). */
  giteaBaseUrl?: string
}

/** An organization as Setup offers it for the SSO connector's new members. */
export interface DeploymentOrganization {
  id: string
  name: string | null
  slug: string
}

export interface DeploymentOrganizations {
  list(): Promise<DeploymentOrganization[]>
}

export interface DeploymentConfigStoreHandle {
  store: PgDeploymentConfigStore
  organizations: DeploymentOrganizations
  close(): Promise<void>
}

/** Open exactly the DB + SecretCipher slice shared by CP and setup tooling. */
export function openDeploymentConfigStore(options: OpenDeploymentConfigStoreOptions): DeploymentConfigStoreHandle {
  const prisma = createPrisma(options.databaseUrl)
  const store = new PgDeploymentConfigStore(
    prisma,
    makeSecretCipher(options),
    options.gitlabBaseUrl,
    options.giteaBaseUrl
  )
  const organizations: DeploymentOrganizations = {
    list: () =>
      prisma.org.findMany({ select: { id: true, name: true, slug: true }, orderBy: { createdAt: 'asc' }, take: 500 })
  }
  return { store, organizations, close: disconnectPrisma }
}
