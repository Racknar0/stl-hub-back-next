-- CreateTable
CREATE TABLE `batchimport` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `folderName` VARCHAR(191) NOT NULL,
    `status` ENUM('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `totalItems` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `batchimport_folderName_key`(`folderName`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `batchimportitem` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `batchId` INTEGER NOT NULL,
    `folderName` VARCHAR(191) NOT NULL,
    `targetAccount` INTEGER NULL,
    `status` ENUM('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `error` TEXT NULL,
    `pesoMB` DOUBLE NOT NULL DEFAULT 0,
    `title` VARCHAR(191) NULL,
    `images` JSON NULL,
    `archiveFile` VARCHAR(191) NULL,
    `tags` JSON NULL,
    `categories` JSON NULL,
    `profiles` VARCHAR(191) NULL,
    `similarityApproved` BOOLEAN NOT NULL DEFAULT false,
    `createdAssetId` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `batchimportitem_batchId_idx`(`batchId`),
    INDEX `batchimportitem_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `batchimportitem` ADD CONSTRAINT `batchimportitem_batchId_fkey` FOREIGN KEY (`batchId`) REFERENCES `batchimport`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
