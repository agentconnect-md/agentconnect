-- A dedicated App's webhook secret, sealed beside its key (github-app-git-credentials.md §Dedicated Apps).
ALTER TABLE "github_app_secret" ADD COLUMN "webhookSecret" TEXT;
