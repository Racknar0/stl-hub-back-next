-- CreateTable
CREATE TABLE `megaAccount` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `alias` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `baseFolder` VARCHAR(191) NOT NULL,
    `priority` INTEGER NOT NULL DEFAULT 1,
    `status` ENUM('CONNECTED', 'ERROR', 'EXPIRED', 'SUSPENDED') NOT NULL DEFAULT 'ERROR',
    `statusMessage` VARCHAR(191) NULL,
    `suspended` BOOLEAN NOT NULL DEFAULT false,
    `storageUsedMB` INTEGER NOT NULL DEFAULT 0,
    `storageTotalMB` INTEGER NOT NULL DEFAULT 0,
    `bandwidthUsedMB` INTEGER NOT NULL DEFAULT 0,
    `bandwidthPeriodAt` DATETIME(3) NULL,
    `errors24h` INTEGER NOT NULL DEFAULT 0,
    `lastCheckAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `megaAccount_alias_key`(`alias`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `accountCredential` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `accountId` INTEGER NOT NULL,
    `encData` LONGBLOB NOT NULL,
    `encIv` LONGBLOB NOT NULL,
    `encTag` LONGBLOB NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `accountCredential_accountId_key`(`accountId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `accountCredential` ADD CONSTRAINT `accountCredential_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `megaAccount`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
