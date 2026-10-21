// A Computer as the Control Plane returns it, for the console's tests.
import type { ComputerDto } from '@/lib/api'

export function computerFixture(over: Partial<ComputerDto> = {}): ComputerDto {
  return {
    id: 'c1',
    name: 'ubuntu-desk',
    ownerUserId: 'u1',
    kind: 'self-hosted',
    isolation: 'none',
    os: 'linux',
    osVersion: 'Ubuntu 26.04',
    session: 'x11',
    status: 'online',
    capabilities: {
      screenshot: true,
      input: true,
      textInput: 'full',
      humanActivity: 'pointer+keyboard',
      backgroundInput: false,
      accessibilityTree: true,
      viewer: true,
      displays: [{ id: '0', width: 1920, height: 1080, scale: 1 }],
      permissions: {}
    },
    doctor: null,
    desktopDaemonVersion: '0.2.0',
    driverVersion: '0.35.2',
    policy: {
      allowedAgents: [],
      allowedMembers: ['u1'],
      agentMode: 'control',
      approvals: { firstInputPerSession: true, launchApp: 'always', submitLikeKeys: true },
      redactApps: [],
      exposeDriverTools: false,
      leaseIdleSeconds: 120,
      leaseMaxSeconds: 1800
    },
    visibility: 'restricted',
    sharedWith: ['u1'],
    lastSeenAt: new Date().toISOString(),
    revokedAt: null,
    stoppedAt: null,
    stoppedByUserId: null,
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    canEdit: true,
    screenshotRetentionDays: 30,
    canEditPolicy: true,
    ...over
  }
}
