-- CreateTable
CREATE TABLE `AssetReplica` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `assetId` INTEGER NOT NULL,
    `accountId` INTEGER NOT NULL,
    `status` ENUM('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `megaLink` VARCHAR(191) NULL,
    `remotePath` VARCHAR(191) NULL,
    `errorMessage` VARCHAR(191) NULL,
    `startedAt` DATETIME(3) NULL,
    `finishedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `AssetReplica_accountId_idx`(`accountId`),
    INDEX `AssetReplica_status_idx`(`status`),
    INDEX `AssetReplica_createdAt_idx`(`createdAt` DESC),
    UNIQUE INDEX `AssetReplica_assetId_accountId_key`(`assetId`, `accountId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `AssetReplica` ADD CONSTRAINT `AssetReplica_assetId_fkey` FOREIGN KEY (`assetId`) REFERENCES `asset`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AssetReplica` ADD CONSTRAINT `AssetReplica_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `megaAccount`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
