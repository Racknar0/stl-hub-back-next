-- AlterTable
ALTER TABLE `reelpost` ADD COLUMN `youtubeDescription` TEXT NULL AFTER `title`,
    ADD COLUMN `onScreenText` VARCHAR(120) NULL AFTER `caption`;
