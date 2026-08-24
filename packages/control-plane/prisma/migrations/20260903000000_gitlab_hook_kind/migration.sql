-- GitLab code-host hooks (gitlab-com-integration.md §8.3): the provider
-- discriminator joins the enum; common cadence/label/session/review fields are
-- reused as-is, and GitLab-only state stays on gitlab_project_binding.
ALTER TYPE "HookKind" ADD VALUE IF NOT EXISTS 'gitlab';
