-- CreateTable
CREATE TABLE `telegramdownloadjob` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `channelName` VARCHAR(255) NOT NULL,
    `startId` INTEGER NOT NULL,
    `endId` INTEGER NOT NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'RUNNING',
    `resumeCount` INTEGER NOT NULL DEFAULT 0,
    `lastError` TEXT NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finishedAt` DATETIME(3) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `telegramdownloadjob_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
