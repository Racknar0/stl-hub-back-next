-- CreateTable
CREATE TABLE `shortlinkclick` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `shortLinkId` INTEGER NOT NULL,
    `source` VARCHAR(40) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `shortlinkclick_createdAt_idx`(`createdAt`),
    INDEX `shortlinkclick_shortLinkId_idx`(`shortLinkId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
