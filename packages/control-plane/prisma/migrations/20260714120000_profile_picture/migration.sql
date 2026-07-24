-- A user-uploaded photo is stored in the icon object store. This nullable timestamp
-- marks it as active and provides a version token for its cache-busted public URL;
-- `picture` remains the OIDC-provider fallback and is still refreshed at sign-in.
ALTER TABLE "public"."app_user" ADD COLUMN "profilePictureUpdatedAt" TIMESTAMPTZ(6);
