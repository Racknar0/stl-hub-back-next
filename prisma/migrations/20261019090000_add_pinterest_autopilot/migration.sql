-- AlterTable
ALTER TABLE `pinterestpinqueue` ADD COLUMN `origin` VARCHAR(20) NULL;

-- CreateTable
CREATE TABLE `pinterestassetreview` (
    `assetId` INTEGER NOT NULL,
    `imagePath` VARCHAR(512) NOT NULL,
    `verdict` VARCHAR(12) NOT NULL,
    `scores` JSON NULL,
    `reason` VARCHAR(255) NULL,
    `reviewedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `pinterestassetreview_verdict_reviewedAt_idx`(`verdict`, `reviewedAt` DESC),
    PRIMARY KEY (`assetId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `pinterestautopilotrun` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `day` VARCHAR(10) NOT NULL,
    `dryRun` BOOLEAN NOT NULL DEFAULT false,
    `status` VARCHAR(12) NOT NULL,
    `summary` JSON NULL,
    `trends` JSON NULL,
    `error` TEXT NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finishedAt` DATETIME(3) NULL,

    INDEX `pinterestautopilotrun_startedAt_idx`(`startedAt` DESC),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
