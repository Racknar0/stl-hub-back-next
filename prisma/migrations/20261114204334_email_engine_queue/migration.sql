/*
  Warnings:

  - A unique constraint covering the columns `[dedupeKey]` on the table `emaillog` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE `emaillog` ADD COLUMN `attempts` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `dedupeKey` VARCHAR(120) NULL,
    ADD COLUMN `lastError` VARCHAR(255) NULL,
    ADD COLUMN `scheduledFor` DATETIME(3) NULL,
    ADD COLUMN `status` ENUM('QUEUED', 'SENT', 'FAILED', 'SKIPPED') NOT NULL DEFAULT 'QUEUED',
    MODIFY `sentAt` DATETIME(3) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `emaillog_dedupeKey_key` ON `emaillog`(`dedupeKey`);

-- CreateIndex
CREATE INDEX `emaillog_status_scheduledFor_idx` ON `emaillog`(`status`, `scheduledFor`);
