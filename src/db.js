import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

// Usar carpeta data relativa al cwd del backend
const DATA_DIR = path.join(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'app.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS broken_reports (
    id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL,
    note TEXT,
    status TEXT NOT NULL DEFAULT 'NEW',
    created_at TEXT NOT NULL,
    ip TEXT,
    ua TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_broken_reports_created_at ON broken_reports(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_broken_reports_asset ON broken_reports(asset_id);
`);
