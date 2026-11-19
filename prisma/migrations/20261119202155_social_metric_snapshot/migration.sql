-- CreateTable
CREATE TABLE `socialmetricsnapshot` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `takenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `postId` VARCHAR(24) NOT NULL,
    `network` VARCHAR(16) NOT NULL,
    `account` VARCHAR(120) NOT NULL,
    `publishedAt` DATETIME(3) NOT NULL,
    `views` INTEGER NULL,
    `reach` INTEGER NULL,
    `likes` INTEGER NULL,
    `comments` INTEGER NULL,
    `shares` INTEGER NULL,
    `saves` INTEGER NULL,
    `clicks` INTEGER NULL,

    INDEX `socialmetricsnapshot_takenAt_idx`(`takenAt`),
    INDEX `socialmetricsnapshot_postId_network_account_takenAt_idx`(`postId`, `network`, `account`, `takenAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
