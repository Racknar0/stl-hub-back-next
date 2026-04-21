-- AlterTable
ALTER TABLE `sitevisit` ADD COLUMN `sessionId` VARCHAR(128) NULL,
    ADD COLUMN `visitorId` VARCHAR(128) NULL;

-- CreateIndex
CREATE INDEX `sitevisit_sessionId_idx` ON `sitevisit`(`sessionId`);

-- CreateIndex
CREATE INDEX `sitevisit_visitorId_idx` ON `sitevisit`(`visitorId`);
