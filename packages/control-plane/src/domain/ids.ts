/**
 * Branded id types (design §2 `domain/ids.ts`).
 *
 * These are nominal aliases over `string`/`bigint` so a `DaemonId` can't be
 * passed where an `AgentId` is expected, without any runtime cost. The wire
 * carries plain UUID strings; we brand them at the persistence/domain boundary.
 *
 * Fencing counters (`sessionEpoch`, `routingEpoch`, per-agent `seq`) are
 * `bigint` to match the `BigInt @db.BigInt` columns — monotonic, never reused.
 */

declare const brand: unique symbol
type Brand<T, B extends string> = T & { readonly [brand]: B }

export type DaemonId = Brand<string, 'DaemonId'>
export type AgentId = Brand<string, 'AgentId'>
export type LaunchId = Brand<string, 'LaunchId'>
export type LeaseId = Brand<string, 'LeaseId'>
export type CronId = Brand<string, 'CronId'>
export type HookId = Brand<string, 'HookId'>
export type IntegrationId = Brand<string, 'IntegrationId'>
export type BotId = Brand<string, 'BotId'>
export type SessionId = Brand<string, 'SessionId'>
export type WorkspaceId = Brand<string, 'WorkspaceId'>
export type OrgId = Brand<string, 'OrgId'>

/** A monotonic fencing epoch (sessionEpoch / routingEpoch). */
export type Epoch = Brand<bigint, 'Epoch'>
/** A per-agent monotonic sequence number. */
export type Seq = Brand<bigint, 'Seq'>

// ── constructors (the branding happens here, at the boundary) ──
export const DaemonId = (s: string): DaemonId => s as DaemonId
export const AgentId = (s: string): AgentId => s as AgentId
export const LaunchId = (s: string): LaunchId => s as LaunchId
export const LeaseId = (s: string): LeaseId => s as LeaseId
export const CronId = (s: string): CronId => s as CronId
export const HookId = (s: string): HookId => s as HookId
export const IntegrationId = (s: string): IntegrationId => s as IntegrationId
export const BotId = (s: string): BotId => s as BotId
export const SessionId = (s: string): SessionId => s as SessionId
export const WorkspaceId = (s: string): WorkspaceId => s as WorkspaceId
export const OrgId = (s: string): OrgId => s as OrgId
export const Epoch = (n: bigint): Epoch => n as Epoch
export const Seq = (n: bigint): Seq => n as Seq
