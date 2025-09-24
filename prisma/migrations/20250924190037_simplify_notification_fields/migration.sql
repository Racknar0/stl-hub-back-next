/*
  Warnings:

  - You are about to drop the column `authorId` on the `notification` table. All the data in the column will be lost.
  - You are about to drop the column `priority` on the `notification` table. All the data in the column will be lost.
  - You are about to drop the column `publishAt` on the `notification` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX `Notification_priority_status_idx` ON `notification`;

-- DropIndex
DROP INDEX `Notification_publishAt_idx` ON `notification`;

-- AlterTable
ALTER TABLE `notification` DROP COLUMN `authorId`,
    DROP COLUMN `priority`,
    DROP COLUMN `publishAt`;
