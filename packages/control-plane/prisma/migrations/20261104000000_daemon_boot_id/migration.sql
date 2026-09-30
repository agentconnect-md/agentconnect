ALTER TABLE "daemon" ADD COLUMN "bootId" UUID;
ALTER TABLE "daemon_lifecycle_op" ADD COLUMN "commandBootId" UUID;
