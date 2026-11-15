-- CreateTable
CREATE TABLE `shortlink` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(32) NOT NULL,
    `targetUrl` TEXT NOT NULL,
    `source` VARCHAR(40) NOT NULL,
    `label` VARCHAR(255) NULL,
    `refType` VARCHAR(30) NULL,
    `refId` INTEGER NULL,
    `clicks` INTEGER NOT NULL DEFAULT 0,
    `lastClickAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `shortlink_code_key`(`code`),
    INDEX `shortlink_source_idx`(`source`),
    INDEX `shortlink_refType_refId_idx`(`refType`, `refId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
