CREATE TABLE `megaAccountBackup` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `mainAccountId` INT NOT NULL,
  `backupAccountId` INT NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_main_backup` (`mainAccountId`,`backupAccountId`),
  KEY `idx_backupAccountId` (`backupAccountId`),
  CONSTRAINT `fk_mainAccount` FOREIGN KEY (`mainAccountId`) REFERENCES `megaAccount`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_backupAccount` FOREIGN KEY (`backupAccountId`) REFERENCES `megaAccount`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
