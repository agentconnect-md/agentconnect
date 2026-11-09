ALTER TABLE "agent" ADD COLUMN "workspaceAttestedByUserId" TEXT;

ALTER TABLE "agent" ADD CONSTRAINT "agent_workspaceAttestedByUserId_fkey"
  FOREIGN KEY ("workspaceAttestedByUserId") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
