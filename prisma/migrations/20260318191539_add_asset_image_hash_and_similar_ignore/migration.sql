-- CreateTable
CREATE TABLE `assetimagehash` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `assetId` INTEGER NOT NULL,
    `imagePath` VARCHAR(191) NOT NULL,
    `imageIndex` INTEGER NULL,
    `hashBits` VARCHAR(191) NOT NULL,
    `hashHex` VARCHAR(191) NOT NULL,
    `hashPrefix` VARCHAR(191) NULL,
    `hashAlgo` VARCHAR(191) NOT NULL DEFAULT 'ahash-v1',
    `hashVersion` INTEGER NOT NULL DEFAULT 1,
    `imageWidth` INTEGER NULL,
    `imageHeight` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `assetimagehash_assetId_idx`(`assetId`),
    INDEX `assetimagehash_hashPrefix_idx`(`hashPrefix`),
    INDEX `assetimagehash_updatedAt_idx`(`updatedAt` DESC),
    UNIQUE INDEX `assetimagehash_assetId_imagePath_key`(`assetId`, `imagePath`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `assetsimilarignoresignature` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `signature` VARCHAR(191) NOT NULL,
    `reason` VARCHAR(191) NULL,
    `assetIds` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `assetsimilarignoresignature_signature_key`(`signature`),
    INDEX `assetsimilarignoresignature_updatedAt_idx`(`updatedAt` DESC),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `assetimagehash` ADD CONSTRAINT `assetimagehash_assetId_fkey` FOREIGN KEY (`assetId`) REFERENCES `asset`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
