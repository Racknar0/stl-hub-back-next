-- CreateTable
CREATE TABLE `emailcontact` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `stage` ENUM('NEW', 'ACTIVE', 'DORMANT', 'OPTED_OUT') NOT NULL DEFAULT 'NEW',
    `lastSentAt` DATETIME(3) NULL,
    `lastOpenAt` DATETIME(3) NULL,
    `lastClickAt` DATETIME(3) NULL,
    `lastBounceAt` DATETIME(3) NULL,
    `reengagedAt` DATETIME(3) NULL,
    `reengagedOpen` BOOLEAN NOT NULL DEFAULT false,
    `optedOutAt` DATETIME(3) NULL,
    `optOutReason` ENUM('UNSUBSCRIBE', 'SPAM_COMPLAINT', 'HARD_BOUNCE', 'NO_RESPONSE', 'MANUAL') NULL,
    `stageUpdatedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `emailcontact_userId_key`(`userId`),
    INDEX `emailcontact_stage_idx`(`stage`),
    INDEX `emailcontact_lastOpenAt_idx`(`lastOpenAt` DESC),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `emaillog` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `contactId` INTEGER NOT NULL,
    `kind` ENUM('WELCOME_1', 'WELCOME_2', 'WELCOME_3', 'WELCOME_4', 'REENGAGE', 'NEWSLETTER', 'OTHER') NOT NULL,
    `subject` VARCHAR(255) NULL,
    `templateId` INTEGER NULL,
    `messageId` VARCHAR(255) NULL,
    `sentAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deliveredAt` DATETIME(3) NULL,
    `openedAt` DATETIME(3) NULL,
    `clickedAt` DATETIME(3) NULL,
    `bouncedAt` DATETIME(3) NULL,

    INDEX `emaillog_contactId_idx`(`contactId`),
    INDEX `emaillog_kind_idx`(`kind`),
    INDEX `emaillog_sentAt_idx`(`sentAt` DESC),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `emailevent` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `event` VARCHAR(40) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `messageId` VARCHAR(255) NULL,
    `payload` LONGTEXT NULL,
    `occurredAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `emailevent_email_idx`(`email`),
    INDEX `emailevent_event_idx`(`event`),
    INDEX `emailevent_occurredAt_idx`(`occurredAt` DESC),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `emailcontact` ADD CONSTRAINT `emailcontact_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `emaillog` ADD CONSTRAINT `emaillog_contactId_fkey` FOREIGN KEY (`contactId`) REFERENCES `emailcontact`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
