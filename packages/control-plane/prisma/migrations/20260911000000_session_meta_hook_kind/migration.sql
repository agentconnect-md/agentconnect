-- Trigger-identity snapshot: the hook kind a session fired from, frozen at creation.
-- Additive and nullable, with no backfill: existing rows keep resolving through the
-- live hook definition, so this changes nothing until new sessions are written.
ALTER TABLE "session_meta" ADD COLUMN "hookKind" "HookKind";
