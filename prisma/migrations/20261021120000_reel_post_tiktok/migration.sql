-- AlterTable
ALTER TABLE `reelpost` ADD COLUMN `tiktokCaption` TEXT NULL AFTER `facebookCaption`,
    ADD COLUMN `tiktokOptions` JSON NULL AFTER `tiktokCaption`;
