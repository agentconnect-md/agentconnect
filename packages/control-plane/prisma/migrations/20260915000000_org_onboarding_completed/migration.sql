-- Org onboarding wizard completion: set once by an owner (finish or skip);
-- the console opens the wizard for owners of orgs where this is still false.
ALTER TABLE "org" ADD COLUMN "onboardingCompleted" BOOLEAN NOT NULL DEFAULT false;

-- Orgs that predate the flag and are already set up (a daemon connected, or an
-- agent configured + placed) are treated as onboarded; untouched fresh orgs keep
-- false and get the wizard.
UPDATE "org" o
SET "onboardingCompleted" = true
WHERE EXISTS (SELECT 1 FROM "daemon" d WHERE d."orgId" = o."id" AND d."status" <> 'provisioned')
   OR EXISTS (
     SELECT 1 FROM "agent" a
     WHERE a."orgId" = o."id"
       AND a."runtime" IS NOT NULL
       AND (a."daemonId" IS NOT NULL OR a."setId" IS NOT NULL)
   );
