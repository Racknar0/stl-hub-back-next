-- CreateTable
CREATE TABLE `asset` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `title` VARCHAR(191) NOT NULL,
    `slug` VARCHAR(191) NOT NULL,
    `description` VARCHAR(191) NULL,
    `category` VARCHAR(191) NULL,
    `tags` JSON NULL,
    `isPremium` BOOLEAN NOT NULL DEFAULT false,
    `megaLink` VARCHAR(191) NULL,
    `archiveName` VARCHAR(191) NULL,
    `archiveSizeB` INTEGER NULL,
    `images` JSON NULL,
    `status` ENUM('DRAFT', 'PROCESSING', 'PUBLISHED', 'FAILED') NOT NULL DEFAULT 'DRAFT',
    `accountId` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `asset_slug_key`(`slug`),
    INDEX `asset_accountId_idx`(`accountId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `asset` ADD CONSTRAINT `asset_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `megaAccount`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
