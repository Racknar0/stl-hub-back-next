-- TikTok queda apagado por defecto: se quita de los reels que aún no se han publicado
-- (los ya publicados conservan su historial). Se puede volver a encender a mano en cada reel.
UPDATE `reelpost`
SET `platforms` = JSON_REMOVE(`platforms`, JSON_UNQUOTE(JSON_SEARCH(`platforms`, 'one', 'tiktok')))
WHERE `status` <> 'PUBLISHED'
  AND JSON_SEARCH(`platforms`, 'one', 'tiktok') IS NOT NULL;
