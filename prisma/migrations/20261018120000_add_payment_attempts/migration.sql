-- CreateTable
CREATE TABLE `paymentattempt` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NULL,
    `provider` VARCHAR(20) NOT NULL,
    `planId` VARCHAR(10) NOT NULL,
    `amount` DOUBLE NULL,
    `currency` VARCHAR(8) NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'STARTED',
    `statusDetail` VARCHAR(120) NULL,
    `paymentMethod` VARCHAR(80) NULL,
    `externalCheckoutId` VARCHAR(120) NULL,
    `externalPaymentId` VARCHAR(120) NULL,
    `paymentId` INTEGER NULL,
    `lastError` TEXT NULL,
    `marketingCampaignId` INTEGER NULL,
    `utmSource` VARCHAR(120) NULL,
    `utmMedium` VARCHAR(120) NULL,
    `utmCampaign` VARCHAR(160) NULL,
    `anonId` VARCHAR(64) NULL,
    `sessionId` VARCHAR(64) NULL,
    `deviceType` VARCHAR(20) NULL,
    `userAgent` VARCHAR(255) NULL,
    `checkoutCreatedAt` DATETIME(3) NULL,
    `returnedAt` DATETIME(3) NULL,
    `paidAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `paymentattempt_createdAt_idx`(`createdAt` DESC),
    INDEX `paymentattempt_provider_status_idx`(`provider`, `status`),
    INDEX `paymentattempt_externalCheckoutId_idx`(`externalCheckoutId`),
    INDEX `paymentattempt_externalPaymentId_idx`(`externalPaymentId`),
    INDEX `paymentattempt_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `paymentattemptevent` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `attemptId` INTEGER NOT NULL,
    `type` VARCHAR(40) NOT NULL,
    `source` VARCHAR(20) NOT NULL,
    `status` VARCHAR(40) NULL,
    `detail` VARCHAR(255) NULL,
    `data` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `paymentattemptevent_attemptId_createdAt_idx`(`attemptId`, `createdAt`),
    INDEX `paymentattemptevent_type_createdAt_idx`(`type`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `paymentwebhooklog` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `provider` VARCHAR(20) NOT NULL,
    `topic` VARCHAR(80) NULL,
    `externalId` VARCHAR(120) NULL,
    `attemptId` INTEGER NULL,
    `processed` BOOLEAN NOT NULL DEFAULT false,
    `httpStatus` INTEGER NULL,
    `error` TEXT NULL,
    `payload` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `paymentwebhooklog_provider_createdAt_idx`(`provider`, `createdAt`),
    INDEX `paymentwebhooklog_externalId_idx`(`externalId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `paymentattemptevent` ADD CONSTRAINT `paymentattemptevent_attemptId_fkey` FOREIGN KEY (`attemptId`) REFERENCES `paymentattempt`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

