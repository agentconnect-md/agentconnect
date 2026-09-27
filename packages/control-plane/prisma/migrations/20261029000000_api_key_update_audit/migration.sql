-- An audit kind for editing a key's settings in place (daemon-api-key-auth.md §6); regeneration reuses api_key_rotate.

-- AlterEnum
ALTER TYPE "AuditKind" ADD VALUE 'api_key_update';
