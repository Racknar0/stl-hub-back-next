-- CreateTable
CREATE TABLE `searchevent` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NULL,
    `queryOriginal` VARCHAR(512) NOT NULL,
    `queryNorm` VARCHAR(191) NOT NULL,
    `queryNormNoAccents` VARCHAR(191) NOT NULL,
    `resultCount` INTEGER NOT NULL,
    `clickCount` INTEGER NOT NULL DEFAULT 0,
    `lastClickedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `searchevent_createdAt_idx`(`createdAt` DESC),
    INDEX `searchevent_userId_idx`(`userId`),
    INDEX `searchevent_queryNormNoAccents_idx`(`queryNormNoAccents`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `searchclick` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `searchEventId` INTEGER NOT NULL,
    `assetId` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `searchclick_assetId_idx`(`assetId`),
    INDEX `searchclick_createdAt_idx`(`createdAt` DESC),
    UNIQUE INDEX `searchclick_searchEventId_assetId_key`(`searchEventId`, `assetId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `searchevent` ADD CONSTRAINT `searchevent_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `searchclick` ADD CONSTRAINT `searchclick_searchEventId_fkey` FOREIGN KEY (`searchEventId`) REFERENCES `searchevent`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
