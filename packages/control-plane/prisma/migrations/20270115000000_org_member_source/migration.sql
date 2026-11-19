-- How new members reach an organization: by invitation, or by an address on its verified domains (docs/designs/organization-sso.md §4.3).
ALTER TABLE "org" ADD COLUMN "memberSource" TEXT NOT NULL DEFAULT 'invite';
