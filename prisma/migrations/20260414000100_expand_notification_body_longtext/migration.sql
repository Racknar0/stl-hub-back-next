-- Expand notification body to avoid truncation of automation error details
ALTER TABLE `notification`
  MODIFY `body` LONGTEXT NULL;
