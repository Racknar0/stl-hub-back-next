-- AlterTable
ALTER TABLE `payment` ADD COLUMN `clickFbclid` VARCHAR(191) NULL,
    ADD COLUMN `clickGclid` VARCHAR(191) NULL,
    ADD COLUMN `clickMsclkid` VARCHAR(191) NULL,
    ADD COLUMN `clickTtclid` VARCHAR(191) NULL,
    ADD COLUMN `marketingCampaignId` INTEGER NULL,
    ADD COLUMN `trackingLandingUrl` VARCHAR(512) NULL,
    ADD COLUMN `trackingReferrer` VARCHAR(512) NULL,
    ADD COLUMN `utmCampaign` VARCHAR(191) NULL,
    ADD COLUMN `utmContent` VARCHAR(191) NULL,
    ADD COLUMN `utmMedium` VARCHAR(191) NULL,
    ADD COLUMN `utmSource` VARCHAR(191) NULL,
    ADD COLUMN `utmTerm` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `user` ADD COLUMN `clickFbclid` VARCHAR(191) NULL,
    ADD COLUMN `clickGclid` VARCHAR(191) NULL,
    ADD COLUMN `clickMsclkid` VARCHAR(191) NULL,
    ADD COLUMN `clickTtclid` VARCHAR(191) NULL,
    ADD COLUMN `marketingCampaignId` INTEGER NULL,
    ADD COLUMN `utmCampaign` VARCHAR(191) NULL,
    ADD COLUMN `utmContent` VARCHAR(191) NULL,
    ADD COLUMN `utmFirstAt` DATETIME(3) NULL,
    ADD COLUMN `utmLandingUrl` VARCHAR(512) NULL,
    ADD COLUMN `utmLastAt` DATETIME(3) NULL,
    ADD COLUMN `utmMedium` VARCHAR(191) NULL,
    ADD COLUMN `utmReferrer` VARCHAR(512) NULL,
    ADD COLUMN `utmSource` VARCHAR(191) NULL,
    ADD COLUMN `utmTerm` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `marketingcampaign` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `slug` VARCHAR(191) NOT NULL,
    `source` VARCHAR(191) NULL,
    `medium` VARCHAR(191) NULL,
    `content` VARCHAR(191) NULL,
    `term` VARCHAR(191) NULL,
    `landingPath` VARCHAR(191) NULL,
    `notes` TEXT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `marketingcampaign_slug_key`(`slug`),
    INDEX `marketingcampaign_isActive_idx`(`isActive`),
    INDEX `marketingcampaign_source_medium_idx`(`source`, `medium`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `payment_marketingCampaignId_idx` ON `payment`(`marketingCampaignId`);

-- CreateIndex
CREATE INDEX `payment_utmSource_utmCampaign_idx` ON `payment`(`utmSource`, `utmCampaign`);

-- CreateIndex
CREATE INDEX `user_marketingCampaignId_idx` ON `user`(`marketingCampaignId`);

-- AddForeignKey
ALTER TABLE `user` ADD CONSTRAINT `user_marketingCampaignId_fkey` FOREIGN KEY (`marketingCampaignId`) REFERENCES `marketingcampaign`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment` ADD CONSTRAINT `payment_marketingCampaignId_fkey` FOREIGN KEY (`marketingCampaignId`) REFERENCES `marketingcampaign`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
