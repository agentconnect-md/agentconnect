/**
 * The seam a package that embeds the Control Plane adds to it through (system-detailed-design.md §2.4).
 *
 * Core calls each member and knows nothing of what is behind it: it never asks which package, or why, a route or a
 * capability exists. Everything here is optional, and a Control Plane started with no extension behaves as before.
 */
import type { FastifyPluginAsync } from 'fastify'
import type { PrismaClient } from './generated/prisma/client.js'
import type { Clock } from './domain/clock.js'
import type { DirectoryMemberRepo } from './persistence/ports.js'

/** How the console treats a settings area an extension provides: shown and editable, or shown and read-only. An area it does not name is hidden. */
export type OrgCapabilityState = 'active' | 'read_only'

export interface ControlPlaneExtension {
  /** Routes under `/api/v1/orgs/:orgId`, registered after sign-in and the organization guard, so `req.orgCtx` is set. */
  orgRoutes?: FastifyPluginAsync
  /** Routes outside the organization subtree, mounted at `/api/v1` and again at the public `/v1`. No sign-in runs in front of them: they authenticate their own callers. */
  rootRoutes?: FastifyPluginAsync
  /** The state of each settings area this extension provides for one organization (`GET /orgs/:orgId/capabilities`). */
  capabilities?(orgId: string): Promise<Record<string, OrgCapabilityState>>
}

/** What core hands an extension when the graph is assembled. Shared tables are changed through core's commands, never written directly. */
export interface ControlPlaneExtensionContext {
  /** The database: an extension's own tables live in the same schema and migration line. */
  prisma: PrismaClient
  clock: Clock
  /** The membership changes an organization's directory makes (resource-visibility.md §8.8). */
  directoryMembers: DirectoryMemberRepo
}

export type ControlPlaneExtensionFactory = (context: ControlPlaneExtensionContext) => ControlPlaneExtension
