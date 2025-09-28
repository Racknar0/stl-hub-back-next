-- Cambiar casing de tablas para que coincidan con Prisma
-- notification  ->  Notification  (dos pasos)
RENAME TABLE `stl_hub`.`notification` TO `stl_hub`.`__tmp_notification_casefix`;
RENAME TABLE `stl_hub`.`__tmp_notification_casefix` TO `stl_hub`.`Notification`;

-- megaaccount  ->  megaAccount  (dos pasos)
RENAME TABLE `stl_hub`.`megaaccount` TO `stl_hub`.`__tmp_megaaccount_casefix`;
RENAME TABLE `stl_hub`.`__tmp_megaaccount_casefix` TO `stl_hub`.`megaAccount`;