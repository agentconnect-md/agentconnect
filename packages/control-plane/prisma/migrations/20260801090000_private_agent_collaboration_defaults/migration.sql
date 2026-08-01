-- New agents start with no inbound or outbound peer grants. Existing agents
-- retain their explicitly persisted policies; this changes column defaults only.
ALTER TABLE "public"."agent"
  ALTER COLUMN "callPolicy" SET DEFAULT 'selected',
  ALTER COLUMN "outboundPolicy" SET DEFAULT 'selected';
