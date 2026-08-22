/*
  Warnings:

  - You are about to drop the column `lastRoutedModel` on the `LlmStatus` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "LlmStatus" DROP COLUMN "lastRoutedModel",
ADD COLUMN     "limitedModel" TEXT;
