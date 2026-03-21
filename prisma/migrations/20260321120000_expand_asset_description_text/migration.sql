-- Expand asset descriptions to TEXT to support longer metadata
ALTER TABLE `asset`
  MODIFY `description` LONGTEXT NULL,
  MODIFY `descriptionEn` LONGTEXT NULL;
