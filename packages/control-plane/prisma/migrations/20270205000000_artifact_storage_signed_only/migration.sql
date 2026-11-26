-- Every revision is read through signed URLs (artifacts.md §5.2, §14 step 2); a row still holding `public` fails the cast.
CREATE TYPE "ArtifactStorageMode_new" AS ENUM ('signed');
ALTER TABLE "artifact_revision" ALTER COLUMN "storageMode" TYPE "ArtifactStorageMode_new" USING ("storageMode"::text::"ArtifactStorageMode_new");
ALTER TYPE "ArtifactStorageMode" RENAME TO "ArtifactStorageMode_old";
ALTER TYPE "ArtifactStorageMode_new" RENAME TO "ArtifactStorageMode";
DROP TYPE "ArtifactStorageMode_old";
