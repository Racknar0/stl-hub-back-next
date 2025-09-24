/*
  Warnings:

  - You are about to alter the column `status` on the `notification` table. The data in that column could be lost. The data in that column will be cast from `Enum(EnumId(4))` to `Enum(EnumId(6))`.

*/
-- AlterTable
ALTER TABLE `notification` MODIFY `status` ENUM('UNREAD', 'READ') NOT NULL DEFAULT 'UNREAD';
