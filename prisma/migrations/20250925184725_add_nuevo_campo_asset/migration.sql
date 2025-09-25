-- AlterTable
ALTER TABLE `asset` ADD COLUMN `megaLinkAlive` BOOLEAN NULL,
    ADD COLUMN `megaLinkCheckedAt` DATETIME(3) NULL;
