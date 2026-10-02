-- The shared session-content store a daemon writes (RegisterReq.contentStore.id): members of a group that report
-- the same one serve one another's sessions. Null for a private store and for a daemon that predates it.
ALTER TABLE "daemon" ADD COLUMN IF NOT EXISTS "contentStoreId" TEXT;
