-- AlterTable
ALTER TABLE `reelpost` MODIFY `scheduledAt` DATETIME(3) NULL,
    ADD COLUMN `assetTitle` VARCHAR(255) NULL AFTER `assetId`,
    ADD COLUMN `subject` VARCHAR(255) NULL AFTER `link`,
    ADD COLUMN `facebookCaption` TEXT NULL AFTER `caption`,
    ADD COLUMN `aiStatus` VARCHAR(12) NOT NULL DEFAULT 'PROCESSING' AFTER `aiGenerated`,
    ADD COLUMN `aiError` TEXT NULL AFTER `aiStatus`,
    ADD COLUMN `approved` BOOLEAN NOT NULL DEFAULT false AFTER `aiError`;
