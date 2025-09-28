-- DropForeignKey
ALTER TABLE `accountcredential` DROP FOREIGN KEY `accountCredential_accountId_fkey`;

-- DropForeignKey
ALTER TABLE `assetreplica` DROP FOREIGN KEY `AssetReplica_accountId_fkey`;

-- DropForeignKey
ALTER TABLE `assetreplica` DROP FOREIGN KEY `AssetReplica_assetId_fkey`;

-- DropForeignKey
ALTER TABLE `megaaccountbackup` DROP FOREIGN KEY `megaAccountBackup_backupAccountId_fkey`;

-- DropForeignKey
ALTER TABLE `megaaccountbackup` DROP FOREIGN KEY `megaAccountBackup_mainAccountId_fkey`;

-- DropForeignKey
ALTER TABLE `payment` DROP FOREIGN KEY `Payment_userId_fkey`;

-- AddForeignKey
ALTER TABLE `megaaccountbackup` ADD CONSTRAINT `megaaccountbackup_mainAccountId_fkey` FOREIGN KEY (`mainAccountId`) REFERENCES `megaaccount`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `megaaccountbackup` ADD CONSTRAINT `megaaccountbackup_backupAccountId_fkey` FOREIGN KEY (`backupAccountId`) REFERENCES `megaaccount`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `accountcredential` ADD CONSTRAINT `accountcredential_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `megaaccount`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `assetreplica` ADD CONSTRAINT `assetreplica_assetId_fkey` FOREIGN KEY (`assetId`) REFERENCES `asset`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `assetreplica` ADD CONSTRAINT `assetreplica_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `megaaccount`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment` ADD CONSTRAINT `payment_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- RenameIndex
ALTER TABLE `accountcredential` RENAME INDEX `accountCredential_accountId_key` TO `accountcredential_accountId_key`;

-- RenameIndex
ALTER TABLE `assetreplica` RENAME INDEX `AssetReplica_accountId_idx` TO `assetreplica_accountId_idx`;

-- RenameIndex
ALTER TABLE `assetreplica` RENAME INDEX `AssetReplica_assetId_accountId_key` TO `assetreplica_assetId_accountId_key`;

-- RenameIndex
ALTER TABLE `assetreplica` RENAME INDEX `AssetReplica_createdAt_idx` TO `assetreplica_createdAt_idx`;

-- RenameIndex
ALTER TABLE `assetreplica` RENAME INDEX `AssetReplica_status_idx` TO `assetreplica_status_idx`;

-- RenameIndex
ALTER TABLE `brokenreport` RENAME INDEX `BrokenReport_assetId_idx` TO `brokenreport_assetId_idx`;

-- RenameIndex
ALTER TABLE `brokenreport` RENAME INDEX `BrokenReport_createdAt_idx` TO `brokenreport_createdAt_idx`;

-- RenameIndex
ALTER TABLE `downloadhistory` RENAME INDEX `DownloadHistory_downloadedAt_idx` TO `downloadhistory_downloadedAt_idx`;

-- RenameIndex
ALTER TABLE `downloadhistory` RENAME INDEX `DownloadHistory_userId_idx` TO `downloadhistory_userId_idx`;

-- RenameIndex
ALTER TABLE `megaaccount` RENAME INDEX `megaAccount_alias_key` TO `megaaccount_alias_key`;

-- RenameIndex
ALTER TABLE `megaaccountbackup` RENAME INDEX `megaAccountBackup_backupAccountId_idx` TO `megaaccountbackup_backupAccountId_idx`;

-- RenameIndex
ALTER TABLE `megaaccountbackup` RENAME INDEX `megaAccountBackup_mainAccountId_backupAccountId_key` TO `megaaccountbackup_mainAccountId_backupAccountId_key`;

-- RenameIndex
ALTER TABLE `notification` RENAME INDEX `Notification_status_idx` TO `notification_status_idx`;

-- RenameIndex
ALTER TABLE `payment` RENAME INDEX `Payment_externalOrderId_idx` TO `payment_externalOrderId_idx`;

-- RenameIndex
ALTER TABLE `payment` RENAME INDEX `Payment_provider_idx` TO `payment_provider_idx`;
