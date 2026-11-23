-- AlterTable
ALTER TABLE `reelpost` ADD COLUMN `autoTextsAt` DATETIME(3) NULL,
    ADD COLUMN `textMode` VARCHAR(10) NOT NULL DEFAULT 'auto',
    ADD COLUMN `trendInfo` JSON NULL;

-- CreateTable
CREATE TABLE `trendtopic` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `collectedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `source` VARCHAR(20) NOT NULL,
    `term` VARCHAR(200) NOT NULL,
    `score` INTEGER NULL,

    INDEX `trendtopic_collectedAt_idx`(`collectedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
