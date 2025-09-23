/*
  Warnings:

  - You are about to drop the column `category` on the `asset` table. All the data in the column will be lost.
  - You are about to drop the column `tags` on the `asset` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE `asset` DROP COLUMN `category`,
    DROP COLUMN `tags`;

-- CreateTable
CREATE TABLE `_assetTotag` (
    `A` INTEGER NOT NULL,
    `B` INTEGER NOT NULL,

    UNIQUE INDEX `_assetTotag_AB_unique`(`A`, `B`),
    INDEX `_assetTotag_B_index`(`B`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `_assetTotag` ADD CONSTRAINT `_assetTotag_A_fkey` FOREIGN KEY (`A`) REFERENCES `asset`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `_assetTotag` ADD CONSTRAINT `_assetTotag_B_fkey` FOREIGN KEY (`B`) REFERENCES `tag`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
