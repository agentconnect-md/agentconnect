-- AgentConnect — example seed data for a local development Postgres.
-- Idempotent: safe to run multiple times (ON CONFLICT DO NOTHING / upserts).
-- Apply AFTER the Prisma migration has created the schema, e.g.:
--   pnpm --filter @agentconnect/control-plane exec prisma migrate deploy
--   psql "$DATABASE_URL" -f seed-example.sql
-- Body-locality holds: no message bodies here, only control-plane metadata.

BEGIN;

-- ── Tenancy (matches prisma/seed.ts default org/user) ───────────────────────
INSERT INTO "org" ("id","name","slug","updatedAt")
VALUES ('org_default00000000000000000','Default','-', now())
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "app_user" ("id","email","displayName")
VALUES ('usr_owner000000000000000000','owner@agentconnect.local','Owner')
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "membership" ("id","orgId","userId","role")
VALUES ('mbr_owner_default0000000000','org_default00000000000000000','usr_owner000000000000000000','owner')
ON CONFLICT ("id") DO NOTHING;

-- An extra teammate user, for multi-user dev UI testing
INSERT INTO "app_user" ("id","email","displayName")
VALUES ('usr_dev0000000000000000000','dev@agentconnect.local','Dev Teammate')
ON CONFLICT ("id") DO NOTHING;
INSERT INTO "membership" ("id","orgId","userId","role")
VALUES ('mbr_dev_default00000000000','org_default00000000000000000','usr_dev0000000000000000000','collaborator')
ON CONFLICT ("id") DO NOTHING;

-- ── Daemon (one registered, ready, alive) ───────────────────────────────────
INSERT INTO "daemon"
  ("id","orgId","host","agentVersion","capabilities","maxAgents","sessionEpoch","routingEpoch",
   "status","health","load","activeSessions","lastSeenAt","updatedAt")
VALUES
  ('11111111-1111-4111-8111-111111111111','org_default00000000000000000','dev-laptop.local','0.0.0',
   '{"platforms":["slack"],"runtimes":["claude","codex"],"acp":true,"features":[]}'::jsonb,
   8, 1, 1, 'ready','ok','{"cpu":0.12,"mem":0.34,"agents":2}'::jsonb, 2, now(), now())
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "runtime_profile" ("id","daemonId","runtime","version","models","contextWindow","acpSupport","toolCalling")
VALUES
  ('rtp_claude0000000000000000','11111111-1111-4111-8111-111111111111','claude','1.0.0',
   ARRAY['claude-opus-4-8','claude-sonnet-4-6'], 200000, 'full', true),
  ('rtp_codex00000000000000000','11111111-1111-4111-8111-111111111111','codex','1.0.0',
   ARRAY['codex-latest'], 128000, 'partial', true)
ON CONFLICT ("id") DO NOTHING;

-- ── Agents (one active + placed on the daemon, one inactive) ────────────────
INSERT INTO "agent"
  ("id","orgId","name","runtime","status","daemonId","workspaceMode","gitRepo","gitBranch","agentDir","capabilities","permissions","updatedAt")
VALUES
  ('22222222-2222-4222-8222-222222222222','org_default00000000000000000','reviewer','claude','active',
   '11111111-1111-4111-8111-111111111111','github','https://github.com/example-org/example-repo','main',NULL,
   ARRAY['message.send','task.claim','attachment.put'], '{"policy":"ask","autoApprove":[]}'::jsonb, now()),
  ('33333333-3333-4333-8333-333333333333','org_default00000000000000000','triager','claude','inactive',
   NULL,'scratch',NULL,NULL,NULL,
   ARRAY['message.send'], '{"policy":"ask","autoApprove":[]}'::jsonb, now())
ON CONFLICT ("id") DO NOTHING;

-- ── A launch + an active assignment (routing table) ─────────────────────────
INSERT INTO "agent_launch"
  ("id","agentId","daemonId","runtime","mode","acpSessionId","activeCapabilities","status","launchEpoch","startedAt")
VALUES
  ('44444444-4444-4444-8444-444444444444','22222222-2222-4222-8222-222222222222',
   '11111111-1111-4111-8111-111111111111','claude','long_lived','acp-sess-001',
   ARRAY['message.send','task.claim','attachment.put'],'running',1, now())
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "assignment"
  ("id","platform","channel","thread","agentId","daemonId","workspaceId",
   "assignedEpoch","assignedSeq","routingEpoch","state","bindRules","updatedAt")
VALUES
  ('asg_demo0000000000000000000','slack','C0DEMO0001',NULL,
   '22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',
   1, 1, 1, 'active', '[{"match":{"kind":"mention"}}]'::jsonb, now())
ON CONFLICT ("id") DO NOTHING;

-- ── A converged session milestone (metadata only — NO message bodies) ───────
INSERT INTO "session_meta"
  ("id","agentId","launchId","platform","channel","thread","phase","link","summary",
   "activityState","lastActivityAt","startedAt","updatedAt")
VALUES
  ('55555555-5555-4555-8555-555555555555','22222222-2222-4222-8222-222222222222',
   '44444444-4444-4444-8444-444444444444','slack','C0DEMO0001','1718000000.000100',
   'plan','https://app.example/sessions/55555555','Reviewing PR #3: drafted a plan',
   'thinking', now(), now(), now())
ON CONFLICT ("id") DO NOTHING;

-- ── A cron definition ───────────────────────────────────────────────────────
INSERT INTO "cron_def"
  ("id","orgId","agentId","schedule","timezone","targetPlatform","targetChannel","trigger","enabled","updatedAt")
VALUES
  ('66666666-6666-4666-8666-666666666666','org_default00000000000000000',
   '22222222-2222-4222-8222-222222222222','0 9 * * 1-5','UTC','slack','C0DEMO0001',
   'Daily standup: summarize open PRs', true, now())
ON CONFLICT ("id") DO NOTHING;

-- ── An audit row (append-only feed) ─────────────────────────────────────────
INSERT INTO "audit_event" ("orgId","kind","daemonId","agentId","frameType","message")
VALUES ('org_default00000000000000000','route_assign','11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222','route/assign','seed: example assignment');

COMMIT;

-- Quick verification:
--   SELECT 'daemons' k, count(*) FROM "daemon"
--   UNION ALL SELECT 'agents', count(*) FROM "agent"
--   UNION ALL SELECT 'assignments', count(*) FROM "assignment"
--   UNION ALL SELECT 'sessions', count(*) FROM "session_meta"
--   UNION ALL SELECT 'crons', count(*) FROM "cron_def";
