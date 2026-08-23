-- The observed facts about the GitLab instance this deployment talks to
-- (gitlab-com-integration.md §24.2): the authenticated version read at first
-- credentialed contact, refreshed on the reconciliation pass. Keyed on the
-- normalized base URL, so a re-target after a full disconnect never inherits
-- another instance's version.
CREATE TABLE "gitlab_instance_state" (
    "baseUrl" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "enterprise" BOOLEAN NOT NULL DEFAULT false,
    "observedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "gitlab_instance_state_pkey" PRIMARY KEY ("baseUrl")
);
