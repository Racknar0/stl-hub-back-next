-- DropForeignKey
ALTER TABLE `megaaccountbackup` DROP FOREIGN KEY `fk_backupAccount`;

-- DropForeignKey
ALTER TABLE `megaaccountbackup` DROP FOREIGN KEY `fk_mainAccount`;

-- AddForeignKey
ALTER TABLE `megaAccountBackup` ADD CONSTRAINT `megaAccountBackup_mainAccountId_fkey` FOREIGN KEY (`mainAccountId`) REFERENCES `megaAccount`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `megaAccountBackup` ADD CONSTRAINT `megaAccountBackup_backupAccountId_fkey` FOREIGN KEY (`backupAccountId`) REFERENCES `megaAccount`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER TABLE `megaaccountbackup` RENAME INDEX `idx_backupAccountId` TO `megaAccountBackup_backupAccountId_idx`;

-- RenameIndex
ALTER TABLE `megaaccountbackup` RENAME INDEX `uniq_main_backup` TO `megaAccountBackup_mainAccountId_backupAccountId_key`;
