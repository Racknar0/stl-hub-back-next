-- CreateTable
CREATE TABLE `sitevisit` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `ipHash` VARCHAR(64) NULL,
    `userAgent` TEXT NULL,
    `path` VARCHAR(255) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `sitevisit_createdAt_idx`(`createdAt` DESC),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
