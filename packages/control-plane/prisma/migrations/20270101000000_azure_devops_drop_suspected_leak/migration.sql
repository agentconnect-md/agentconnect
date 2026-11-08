-- A rotation always keeps the old key for 36 hours after promotion.
ALTER TABLE "azure_devops_hook_secret" DROP COLUMN "nextSuspectedLeak";
