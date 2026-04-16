-- CreateTable
CREATE TABLE `marketingvisit` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `marketingCampaignId` INTEGER NULL,
    `anonId` VARCHAR(191) NULL,
    `sessionId` VARCHAR(191) NULL,
    `pagePath` VARCHAR(255) NULL,
    `utmSource` VARCHAR(191) NULL,
    `utmMedium` VARCHAR(191) NULL,
    `utmCampaign` VARCHAR(191) NULL,
    `utmContent` VARCHAR(191) NULL,
    `utmTerm` VARCHAR(191) NULL,
    `clickGclid` VARCHAR(191) NULL,
    `clickFbclid` VARCHAR(191) NULL,
    `clickTtclid` VARCHAR(191) NULL,
    `clickMsclkid` VARCHAR(191) NULL,
    `trackingLandingUrl` VARCHAR(512) NULL,
    `trackingReferrer` VARCHAR(512) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `marketingvisit_marketingCampaignId_idx`(`marketingCampaignId`),
    INDEX `marketingvisit_createdAt_idx`(`createdAt` DESC),
    INDEX `marketingvisit_utmSource_utmCampaign_idx`(`utmSource`, `utmCampaign`),
    INDEX `marketingvisit_anonId_idx`(`anonId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `marketingvisit` ADD CONSTRAINT `marketingvisit_marketingCampaignId_fkey` FOREIGN KEY (`marketingCampaignId`) REFERENCES `marketingcampaign`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
