-- CreateTable: daily_freebie
-- Tabla separada para rastrear qué assets son gratuitos cada día.
-- Sustituye la rotación masiva de asset.isPremium por inserts/deletes ligeros.
CREATE TABLE `daily_freebie` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `assetId` INTEGER NOT NULL,
    `date` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `daily_freebie_date_idx`(`date`),
    UNIQUE INDEX `daily_freebie_assetId_date_key`(`assetId`, `date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `daily_freebie` ADD CONSTRAINT `daily_freebie_assetId_fkey` FOREIGN KEY (`assetId`) REFERENCES `asset`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
