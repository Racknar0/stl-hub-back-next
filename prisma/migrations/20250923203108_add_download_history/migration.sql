-- CreateTable
CREATE TABLE `DownloadHistory` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `assetId` INTEGER NOT NULL,
    `assetTitle` VARCHAR(191) NULL,
    `downloadedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `DownloadHistory_userId_idx`(`userId`),
    INDEX `DownloadHistory_downloadedAt_idx`(`downloadedAt` DESC),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
