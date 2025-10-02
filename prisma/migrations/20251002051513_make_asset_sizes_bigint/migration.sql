/*
  Warnings:

  - You are about to alter the column `archiveSizeB` on the `asset` table. The data in that column could be lost. The data in that column will be cast from `Int` to `UnsignedBigInt`.
  - You are about to alter the column `fileSizeB` on the `asset` table. The data in that column could be lost. The data in that column will be cast from `Int` to `UnsignedBigInt`.

*/
-- AlterTable
ALTER TABLE `asset` MODIFY `archiveSizeB` BIGINT UNSIGNED NULL,
    MODIFY `fileSizeB` BIGINT UNSIGNED NULL;
