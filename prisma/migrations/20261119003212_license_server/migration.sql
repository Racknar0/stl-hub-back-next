-- CreateTable
CREATE TABLE `license_product` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(64) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `license_product_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `license_serial` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `productId` INTEGER NOT NULL,
    `serialHash` CHAR(64) NOT NULL,
    `masked` VARCHAR(40) NOT NULL,
    `note` VARCHAR(255) NULL,
    `installationId` VARCHAR(128) NULL,
    `activatedAt` DATETIME(3) NULL,
    `lastValidatedAt` DATETIME(3) NULL,
    `resetCount` INTEGER NOT NULL DEFAULT 0,
    `revokedAt` DATETIME(3) NULL,
    `revokeReason` VARCHAR(255) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `license_serial_serialHash_key`(`serialHash`),
    INDEX `license_serial_productId_createdAt_idx`(`productId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `license_serial` ADD CONSTRAINT `license_serial_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `license_product`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
