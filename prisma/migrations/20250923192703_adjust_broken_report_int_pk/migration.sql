/*
  Warnings:

  - The primary key for the `brokenreport` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to alter the column `id` on the `brokenreport` table. The data in that column could be lost. The data in that column will be cast from `VarChar(191)` to `Int`.
  - You are about to alter the column `assetId` on the `brokenreport` table. The data in that column could be lost. The data in that column will be cast from `VarChar(191)` to `Int`.

*/
-- AlterTable
ALTER TABLE `brokenreport` DROP PRIMARY KEY,
    MODIFY `id` INTEGER NOT NULL AUTO_INCREMENT,
    MODIFY `assetId` INTEGER NOT NULL,
    ADD PRIMARY KEY (`id`);
