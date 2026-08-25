-- Getting-started tutorial position: how many checklist steps the org has passed
-- (completed or skipped via Next). Advanced by the console's Get Started drawer.
ALTER TABLE "org" ADD COLUMN "gettingStartedStep" INTEGER NOT NULL DEFAULT 0;
