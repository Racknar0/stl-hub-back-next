-- AlterTable
ALTER TABLE `brokenreport` ADD COLUMN `userId` INTEGER NULL;

-- CreateTable
CREATE TABLE `usernotification` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `body` LONGTEXT NULL,
    `isRead` BOOLEAN NOT NULL DEFAULT false,
    `assetId` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `usernotification_userId_idx`(`userId`),
    INDEX `usernotification_createdAt_idx`(`createdAt` DESC),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `brokenreport_userId_idx` ON `brokenreport`(`userId`);

-- AddForeignKey
ALTER TABLE `brokenreport` ADD CONSTRAINT `brokenreport_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `usernotification` ADD CONSTRAINT `usernotification_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
