-- AlterTable
ALTER TABLE `reelpost` ADD COLUMN `horizontalUsesCount` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `lastUsedInHorizontal` DATETIME(3) NULL;

-- CreateTable
CREATE TABLE `horizontalcompilation` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `title` VARCHAR(255) NOT NULL,
    `description` TEXT NOT NULL,
    `tags` JSON NULL,
    `channelId` VARCHAR(100) NOT NULL,
    `channelName` VARCHAR(100) NULL,
    `youtubeVideoId` VARCHAR(100) NULL,
    `youtubeUrl` VARCHAR(255) NULL,
    `videoPath` VARCHAR(512) NULL,
    `durationSec` DOUBLE NULL,
    `fileSizeB` INTEGER NULL,
    `heroPostId` INTEGER NULL,
    `modelIds` JSON NOT NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'PUBLISHED',
    `fbSynced` BOOLEAN NOT NULL DEFAULT false,
    `fbPostId` VARCHAR(100) NULL,
    `errorMessage` TEXT NULL,
    `publishedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `horizontalcompilation_channelId_idx`(`channelId`),
    INDEX `horizontalcompilation_status_idx`(`status`),
    INDEX `horizontalcompilation_publishedAt_idx`(`publishedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
