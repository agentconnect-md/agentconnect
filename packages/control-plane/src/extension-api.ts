/**
 * `@agentconnect.md/control-plane/extension-api` — everything a package that embeds the Control Plane imports from it.
 *
 * Such a package is the process entry: it calls `startControlPlane({ extension })` and reaches core through the names
 * here and nothing else. Importing this module starts nothing.
 */
export { startControlPlane, type StartControlPlaneOptions } from './start.js'
export type {
  ControlPlaneExtension,
  ControlPlaneExtensionContext,
  ControlPlaneExtensionFactory,
  OrgCapabilityState
} from './extension.js'
export type {
  DirectoryMemberCommandResult,
  DirectoryMemberRecord,
  DirectoryMemberRepo,
  DirectoryProvisionInput,
  OrgMemberRole
} from './persistence/ports.js'
