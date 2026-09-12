/**
 * The Gitea seam a suite hands `buildHttpApp` (gitea-integration.md §4, §6): the connection
 * service and the provisioner over the real Pg stores and the stateful fake edge, wired the way
 * `container.ts` wires them — the rules rebroadcast after a converge runs through the app's own
 * HookService, and the test-delivery wait is short so a blocked relay is a fast outcome.
 */
import type { PrismaClient } from '../../src/generated/prisma/client.js'
import type { Clock } from '../../src/domain/clock.js'
import { OrgId } from '../../src/domain/ids.js'
import { GiteaBindingService } from '../../src/gitea/binding.service.js'
import { GiteaConnectionService } from '../../src/gitea/connection.service.js'
import { GiteaProvisioner } from '../../src/gitea/provisioner.js'
import type { HttpDeps } from '../../src/http/deps.js'
import { unionGiteaWebhookEvents } from '../../src/gitea/webhook-events.js'
import { PgAgentRepo } from '../../src/persistence/repositories/agent.repo.js'
import { PgHookRepo } from '../../src/persistence/repositories/hook.repo.js'
import { PgCodeHostRepositoryRepo } from '../../src/persistence/repositories/code-host-repository.repo.js'
import {
  PgGiteaConnectionRepo,
  PgGiteaConnectionSecretStore,
  PgGiteaRepositoryBindingRepo,
  PgGiteaWebhookSecretStore
} from '../../src/persistence/repositories/gitea.repo.js'
import type { SecretCipher } from '../../src/secrets/cipher.js'
import type { HookRecord } from '../../src/persistence/ports.js'
import { FakeGitea, type FakeGiteaOptions } from './gitea-api.js'

export interface GiteaSeamOptions {
  fake?: FakeGiteaOptions
  publicRelayUrl?: string
  /** How long the saga waits for the relay to report the test delivery; default 300ms. */
  testDeliveryWaitMs?: number
}

export interface GiteaSeam {
  fake: FakeGitea
  connections: GiteaConnectionService
  provisioner: GiteaProvisioner
  /** Binding on first use (§6) over the same stores. */
  bindingService: GiteaBindingService
  /** The bundle a suite hands `buildHttpApp` as `depsOverrides.gitea`. */
  httpDeps: NonNullable<HttpDeps['gitea']>
  api: FakeGitea['api']
  connectionRepo: PgGiteaConnectionRepo
  bindings: PgGiteaRepositoryBindingRepo
  webhookSecrets: PgGiteaWebhookSecretStore
  /** Late-bound: the app's HookService, once `buildHttpApp` has produced it. */
  broadcast: { current?: (hook: HookRecord) => Promise<void> }
  /** Every in-flight converge the routes kicked, so a test can outwait them before its assertions. */
  settled(): Promise<void>
}

export function buildGiteaSeam(
  prisma: PrismaClient,
  cipher: SecretCipher,
  clock: Clock,
  opts: GiteaSeamOptions = {}
): GiteaSeam {
  const fake = new FakeGitea(opts.fake)
  const connectionRepo = new PgGiteaConnectionRepo(prisma)
  const bindings = new PgGiteaRepositoryBindingRepo(prisma)
  const webhookSecrets = new PgGiteaWebhookSecretStore(prisma, cipher)
  const hookRepo = new PgHookRepo(prisma)
  const broadcast: GiteaSeam['broadcast'] = {}
  const inFlight = new Set<Promise<void>>()
  const track = (run: Promise<void>): Promise<void> => {
    inFlight.add(run)
    return run.finally(() => inFlight.delete(run))
  }
  const rebroadcast = async (orgId: string, repoId: bigint): Promise<void> => {
    for (const row of await hookRepo.listForOrgKind(OrgId(orgId), 'gitea')) {
      if (row.repoId === repoId) await broadcast.current?.(row)
    }
  }
  const connections = new GiteaConnectionService({
    connections: connectionRepo,
    secrets: new PgGiteaConnectionSecretStore(prisma, cipher),
    bindings,
    cipher,
    clock,
    api: fake.api,
    onBindingsDegraded: async (orgId, rows) => {
      for (const row of rows) await rebroadcast(orgId, row.repoId)
    }
  })
  const provisioner = new GiteaProvisioner({
    connections: connectionRepo,
    tokens: connections,
    bindings,
    webhookSecrets,
    catalog: new PgCodeHostRepositoryRepo(prisma),
    clock,
    publicRelayUrl: opts.publicRelayUrl ?? 'https://relay.example.test',
    desiredWebhookEvents: async (orgId, repoId) =>
      unionGiteaWebhookEvents(await hookRepo.listForOrgKind(OrgId(orgId), 'gitea'), repoId),
    syncWorkspacePaths: async (orgId, repoId, repoPath, cloneUrl) => {
      await new PgAgentRepo(prisma).refreshCodeHostRepositoryPath(OrgId(orgId), 'gitea', repoId, repoPath, cloneUrl)
    },
    onConverged: rebroadcast,
    api: fake.api,
    testDeliveryWaitMs: opts.testDeliveryWaitMs ?? 300
  })
  const convergeRepository = provisioner.convergeRepository.bind(provisioner)
  provisioner.convergeRepository = (orgId, repoId, convergeOpts) =>
    track(convergeRepository(orgId, repoId, convergeOpts))
  // The routes also kick a parked cleanup fire-and-forget after a token replacement.
  const disconnect = provisioner.disconnect.bind(provisioner)
  provisioner.disconnect = (orgId, bindingId) => {
    const run = disconnect(orgId, bindingId)
    void track(run.then(() => undefined))
    return run
  }
  const settled = async (): Promise<void> => {
    while (inFlight.size > 0) {
      await Promise.allSettled([...inFlight])
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
  const bindingService = new GiteaBindingService({
    connections: connectionRepo,
    tokens: connections,
    bindings,
    provisioner,
    api: fake.api
  })
  return {
    fake,
    connections,
    provisioner,
    bindingService,
    httpDeps: { connections, provisioner, bindings: bindingService, api: fake.api },
    api: fake.api,
    connectionRepo,
    bindings,
    webhookSecrets,
    broadcast,
    settled
  }
}
