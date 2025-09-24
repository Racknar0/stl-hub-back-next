-- Replace priority column with type enum (main|backup)
ALTER TABLE `megaAccount` ADD COLUMN `type` ENUM('main','backup') NOT NULL DEFAULT 'main';
UPDATE `megaAccount` SET `type` = 'main' WHERE `type` IS NULL; -- safety
ALTER TABLE `megaAccount` DROP COLUMN `priority`;
