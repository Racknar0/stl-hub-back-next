-- AlterTable
ALTER TABLE `searchevent` ADD COLUMN `isAiSearch` BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE `planclickevent` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `planId` VARCHAR(10) NOT NULL,
    `userId` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `planclickevent_createdAt_idx`(`createdAt` DESC),
    INDEX `planclickevent_planId_idx`(`planId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
