/*
  Warnings:

  - A unique constraint covering the columns `[slugEn]` on the table `category` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[slugEn]` on the table `tag` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE `asset` ADD COLUMN `titleEn` VARCHAR(191) NULL,
    ADD COLUMN `titleEs` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `category` ADD COLUMN `nameEn` VARCHAR(191) NULL,
    ADD COLUMN `slugEn` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `tag` ADD COLUMN `nameEn` VARCHAR(191) NULL,
    ADD COLUMN `slugEn` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `_assetTocategory` (
    `A` INTEGER NOT NULL,
    `B` INTEGER NOT NULL,

    UNIQUE INDEX `_assetTocategory_AB_unique`(`A`, `B`),
    INDEX `_assetTocategory_B_index`(`B`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `category_slugEn_key` ON `category`(`slugEn`);

-- CreateIndex
CREATE UNIQUE INDEX `tag_slugEn_key` ON `tag`(`slugEn`);

-- AddForeignKey
ALTER TABLE `_assetTocategory` ADD CONSTRAINT `_assetTocategory_A_fkey` FOREIGN KEY (`A`) REFERENCES `asset`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `_assetTocategory` ADD CONSTRAINT `_assetTocategory_B_fkey` FOREIGN KEY (`B`) REFERENCES `category`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
