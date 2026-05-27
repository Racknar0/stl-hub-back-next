-- CreateTable
CREATE TABLE `telegramchannel` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `label` VARCHAR(191) NULL,
    `avatarUrl` VARCHAR(191) NULL,
    `addedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastCheckedAt` DATETIME(3) NULL,
    `newFiles` INTEGER NOT NULL DEFAULT 0,
    `totalSize` VARCHAR(191) NOT NULL DEFAULT '0 B',
    `totalSizeBytes` BIGINT UNSIGNED NOT NULL DEFAULT 0,
    `maxId` INTEGER NOT NULL DEFAULT 0,
    `hasError` BOOLEAN NOT NULL DEFAULT false,
    `errorMessage` TEXT NULL,
    `lastMsgId` INTEGER NULL,
    `lastFileName` VARCHAR(512) NULL,
    `lastDownloadedAt` DATETIME(3) NULL,
    `lastDownloadUrl` VARCHAR(512) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `telegramchannel_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
