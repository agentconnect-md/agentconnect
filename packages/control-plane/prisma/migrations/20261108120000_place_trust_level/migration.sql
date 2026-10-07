-- Why the platform detected a place as external (assistant-mode.md §5.3); null is internal, so existing rows stay internal.
ALTER TABLE "integration_channel" ADD COLUMN "externalReason" TEXT;
