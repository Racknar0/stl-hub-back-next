-- Evita que cambios operativos/masivos alteren asset.updatedAt.
-- Solo se actualiza cuando cambian campos de contenido real del asset.
DROP TRIGGER IF EXISTS `asset_guard_updated_at_bu`;

CREATE TRIGGER `asset_guard_updated_at_bu`
BEFORE UPDATE ON `asset`
FOR EACH ROW
SET NEW.`updatedAt` = IF(
  NOT (
    NEW.`title` <=> OLD.`title`
    AND NEW.`titleEn` <=> OLD.`titleEn`
    AND NEW.`slug` <=> OLD.`slug`
    AND NEW.`description` <=> OLD.`description`
    AND NEW.`archiveName` <=> OLD.`archiveName`
    AND NEW.`archiveSizeB` <=> OLD.`archiveSizeB`
    AND NEW.`fileSizeB` <=> OLD.`fileSizeB`
  ),
  CURRENT_TIMESTAMP(3),
  OLD.`updatedAt`
);
