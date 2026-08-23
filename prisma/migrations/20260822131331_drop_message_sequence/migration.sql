/*
  Warnings:

  - You are about to drop the column `sequence` on the `Message` table. All the data in the column will be lost.

  Ordering is `(createdAt DESC, id DESC)` on the composite index, which the cursor already
  encodes. The column was written by nothing and every row held the default.

  Compatibility: deploy the code that stops selecting `sequence` FIRST. A running old instance
  selecting the dropped column errors on every message read.

  Rollback: ALTER TABLE "Message" ADD COLUMN "sequence" BIGINT NOT NULL DEFAULT 0;
  Restores the shape, not the values — which is lossless here, since the values were all 0.
*/
-- AlterTable
ALTER TABLE "Message" DROP COLUMN "sequence";
