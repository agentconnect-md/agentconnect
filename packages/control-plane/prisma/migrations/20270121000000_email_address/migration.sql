-- Every address an Email integration has taken, kept after its bot row is gone so the address is never issued twice.

-- CreateTable
CREATE TABLE "email_address" (
    "address" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_address_pkey" PRIMARY KEY ("address")
);
