-- A project removal detaches every membership before the accounts it emptied
-- finish deleting at GitLab, which is asynchronous (gitlab-com-integration.md
-- §19.4). Without a durable record of what it is still owed, a removal resumed
-- after the FIRST account disappears would see no memberships left and release
-- the deployment-global claim while another account is still listed.
ALTER TABLE "gitlab_agent_account" ADD COLUMN "retiringForBindingId" UUID;

CREATE INDEX "gitlab_agent_account_retiringForBindingId_idx" ON "gitlab_agent_account"("retiringForBindingId");
