-- CreateIndex
CREATE INDEX `asset_status_createdAt_idx` ON `asset`(`status`, `createdAt` DESC);

-- CreateIndex
CREATE INDEX `asset_status_downloads_idx` ON `asset`(`status`, `downloads` DESC);

-- CreateIndex
CREATE INDEX `asset_isPremium_idx` ON `asset`(`isPremium`);
