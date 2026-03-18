-- CreateTable
CREATE TABLE `assetsimilarignorepair` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `assetAId` INTEGER NOT NULL,
    `assetBId` INTEGER NOT NULL,
    `reason` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `assetsimilarignorepair_updatedAt_idx`(`updatedAt` DESC),
    UNIQUE INDEX `assetsimilarignorepair_assetAId_assetBId_key`(`assetAId`, `assetBId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
