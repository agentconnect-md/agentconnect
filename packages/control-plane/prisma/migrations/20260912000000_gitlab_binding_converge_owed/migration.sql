-- A GitLab convergence that loses a lease fence writes nothing: the binding
-- keeps the state it had, because a race is not a verdict about it. Something
-- must still come back for it, and an in-process timer does not survive a
-- restart — so the obligation is recorded here, neutrally, and a sweep
-- rediscovers it (gitlab-com-integration.md §10.2).
ALTER TABLE "gitlab_project_binding" ADD COLUMN "convergeOwedAt" TIMESTAMPTZ(6);

CREATE INDEX "gitlab_project_binding_convergeOwedAt_idx" ON "gitlab_project_binding"("convergeOwedAt");
