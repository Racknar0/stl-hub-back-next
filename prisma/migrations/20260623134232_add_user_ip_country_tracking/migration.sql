-- AlterTable
ALTER TABLE `user` ADD COLUMN `registerIp` VARCHAR(45) NULL,
    ADD COLUMN `registerCountry` VARCHAR(2) NULL,
    ADD COLUMN `lastLoginIp` VARCHAR(45) NULL,
    ADD COLUMN `lastLoginCountry` VARCHAR(2) NULL;
