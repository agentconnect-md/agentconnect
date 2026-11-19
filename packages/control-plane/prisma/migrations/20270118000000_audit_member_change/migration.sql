-- Member changes (added, role changed, removed, left) are audited.
ALTER TYPE "AuditKind" ADD VALUE IF NOT EXISTS 'member_change';
