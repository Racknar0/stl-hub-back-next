-- CreateTable
CREATE TABLE `sitereview` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `rating` INTEGER NOT NULL,
    `text` VARCHAR(500) NULL,
    `displayName` VARCHAR(60) NOT NULL,
    `consent` BOOLEAN NOT NULL DEFAULT false,
    `language` VARCHAR(5) NOT NULL DEFAULT 'es',
    `downloads` INTEGER NOT NULL DEFAULT 0,
    `status` ENUM('PENDING', 'APPROVED', 'REJECTED') NOT NULL DEFAULT 'PENDING',
    `featured` BOOLEAN NOT NULL DEFAULT false,
    `reviewedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `sitereview_userId_key`(`userId`),
    INDEX `sitereview_status_featured_createdAt_idx`(`status`, `featured`, `createdAt` DESC),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `sitereview` ADD CONSTRAINT `sitereview_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
