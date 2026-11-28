import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable, Writable } from 'node:stream';
import Database from 'better-sqlite3';
import { ZipArchive } from 'archiver';
import yauzl from 'yauzl';
import { db } from './db';
import { fetchFileFromStorage, LOCAL_UPLOADS_DIR, resolveConfinedLocalPath } from './storage';

/**
 * Full backup / restore of the portal.
 *
 * A backup is a ZIP with:
 *   manifest.json      – format marker, creation time, record counts
 *   database.sqlite    – consistent online snapshot of the whole SQLite database
 *   files/<fileId>     – every uploaded binary (invoices, check images, signatures), whether it is
 *                        stored on local disk or in Supabase Storage
 *
 * Backups contain everything, including PIN hashes, so every entry point is CEO-only (enforced in
 * routes.ts) and the backup directory lives inside DATA_DIR, which is never served over HTTP.
 */

export const BACKUP_FORMAT = 'jahanparseh-portal-backup';
export const BACKUP_FORMAT_VERSION = 1;

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
export const BACKUPS_DIR = path.join(DATA_DIR, 'backups');

const AUTO_BACKUPS_TO_KEEP = 7;
const SAFETY_BACKUPS_TO_KEEP = 3;
const MAX_RESTORE_ENTRY_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB uncompressed per entry
const FILE_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

/** Tables copied on restore, parents before children. `sessions` is deliberately excluded. */
const RESTORE_TABLES = [
  'settings',
  'files',
  'orders',
  'order_documents',
  'checks',
  'check_attachments',
  'procurement_items',
  'audit_logs',
  'customer_codes',
] as const;

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  version: number;
  createdAt: string;
  counts: Record<string, number>;
  files: number;
  missingFiles: string[];
}

function tehranDateKey(d = new Date()): string {
  // en-CA gives YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran' }).format(d);
}

function ensureBackupsDir(): void {
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
}

function tableCounts(database: Database.Database): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const t of ['users', ...RESTORE_TABLES]) {
    try {
      counts[t] = (database.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    } catch {
      counts[t] = 0;
    }
  }
  return counts;
}

/** Appends one stream to the archive and resolves once archiver has fully consumed it. */
function appendAndWait(archive: ZipArchive, source: Readable | Buffer | string, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onEntry = (entry: { name: string }) => {
      if (entry.name === name) {
        archive.off('entry', onEntry as (...args: unknown[]) => void);
        archive.off('error', onError as (...args: unknown[]) => void);
        resolve();
      }
    };
    const onError = (err: Error) => {
      archive.off('entry', onEntry as (...args: unknown[]) => void);
      reject(err);
    };
    archive.on('entry', onEntry);
    archive.on('error', onError);
    archive.append(source, { name, date: new Date() });
  });
}

/**
 * Streams a complete backup ZIP into `output`. Files are added one at a time so a large backup
 * never holds more than one binary in memory.
 */
export async function writeBackup(output: Writable): Promise<BackupManifest> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-backup-'));
  const snapshotPath = path.join(tmpDir, 'database.sqlite');
  try {
    // Consistent online snapshot (safe while the app keeps writing).
    await db.backup(snapshotPath);
    const snapshot = new Database(snapshotPath, { readonly: true });
    const counts = tableCounts(snapshot);
    const fileRows = snapshot
      .prepare(`SELECT id, storage_provider, storage_bucket, storage_path, stored_filename FROM files ORDER BY id`)
      .all() as Array<{
      id: string;
      storage_provider: string;
      storage_bucket: string;
      storage_path: string;
      stored_filename: string;
    }>;
    snapshot.close();

    const archive = new ZipArchive({ zlib: { level: 6 } });
    const done = pipeline(archive, output);

    await appendAndWait(archive, fs.createReadStream(snapshotPath), 'database.sqlite');

    const missingFiles: string[] = [];
    let fileCount = 0;
    for (const f of fileRows) {
      if (!FILE_ID_RE.test(f.id)) continue;
      const stored = await fetchFileFromStorage({
        storageProvider: f.storage_provider,
        storageBucket: f.storage_bucket,
        storagePath: f.storage_path,
        storedFilename: f.stored_filename,
      }).catch(() => null);
      if (!stored) {
        missingFiles.push(f.id);
        continue;
      }
      await appendAndWait(archive, stored.stream as Readable, `files/${f.id}`);
      fileCount++;
    }

    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      version: BACKUP_FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      counts,
      files: fileCount,
      missingFiles,
    };
    await appendAndWait(archive, JSON.stringify(manifest, null, 2), 'manifest.json');
    await archive.finalize();
    await done;
    return manifest;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Writes a backup into DATA_DIR/backups atomically (temp file + rename). */
export async function writeBackupToDisk(fileName: string): Promise<{ path: string; manifest: BackupManifest }> {
  ensureBackupsDir();
  const finalPath = path.join(BACKUPS_DIR, fileName);
  const tmpPath = `${finalPath}.partial`;
  try {
    const manifest = await writeBackup(fs.createWriteStream(tmpPath));
    fs.renameSync(tmpPath, finalPath);
    return { path: finalPath, manifest };
  } catch (err) {
    fs.rmSync(tmpPath, { force: true });
    throw err;
  }
}

export interface StoredBackupInfo {
  name: string;
  kind: 'auto' | 'safety';
  sizeBytes: number;
  createdAt: string;
}

export function listStoredBackups(): StoredBackupInfo[] {
  if (!fs.existsSync(BACKUPS_DIR)) return [];
  return fs
    .readdirSync(BACKUPS_DIR)
    .filter((n) => /^(auto|pre-restore)-[0-9A-Za-z-]+\.zip$/.test(n))
    .map((name) => {
      const st = fs.statSync(path.join(BACKUPS_DIR, name));
      return {
        name,
        kind: name.startsWith('auto-') ? ('auto' as const) : ('safety' as const),
        sizeBytes: st.size,
        createdAt: st.mtime.toISOString(),
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Resolves a stored backup by name, refusing anything outside the backups folder. */
export function resolveStoredBackup(name: string): string | null {
  if (!/^(auto|pre-restore)-[0-9A-Za-z-]+\.zip$/.test(name)) return null;
  const p = path.join(BACKUPS_DIR, name);
  return fs.existsSync(p) ? p : null;
}

function pruneBackups(prefix: string, keep: number): void {
  const all = listStoredBackups().filter((b) => b.name.startsWith(prefix));
  for (const old of all.slice(keep)) {
    fs.rmSync(path.join(BACKUPS_DIR, old.name), { force: true });
  }
}

let autoBackupRunning = false;

/** Creates today's automatic backup if it does not exist yet, then keeps only the newest 7. */
export async function runDailyBackupIfDue(): Promise<void> {
  if (autoBackupRunning) return;
  const name = `auto-${tehranDateKey()}.zip`;
  if (resolveStoredBackup(name)) return;
  autoBackupRunning = true;
  try {
    const { manifest } = await writeBackupToDisk(name);
    pruneBackups('auto-', AUTO_BACKUPS_TO_KEEP);
    console.log(`[Backup] Daily backup ${name} written (${manifest.files} files).`);
  } catch (err) {
    console.error('[Backup] Daily backup failed:', err instanceof Error ? err.message : err);
  } finally {
    autoBackupRunning = false;
  }
}

export function startDailyBackupScheduler(): void {
  if (process.env.DISABLE_AUTO_BACKUP === '1') return;
  // First run shortly after startup, then check every 30 minutes (one backup per Tehran day).
  setTimeout(() => void runDailyBackupIfDue(), 60_000).unref();
  setInterval(() => void runDailyBackupIfDue(), 30 * 60_000).unref();
}

// ==================== Restore ====================

export class RestoreError extends Error {}

function openZip(zipPath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: false, strictFileNames: true }, (err, zip) => {
      if (err || !zip) reject(new RestoreError('فایل پشتیبان قابل خواندن نیست (ZIP معتبر نیست).'));
      else resolve(zip);
    });
  });
}

function readEntryStream(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) reject(err || new Error('stream'));
      else resolve(stream);
    });
  });
}

/**
 * Extracts only the expected entries (manifest.json, database.sqlite, files/<safe id>) into a
 * fresh temp folder. Any other path is ignored, so a crafted ZIP cannot write outside it.
 */
async function extractBackup(zipPath: string, intoDir: string): Promise<{ manifest: BackupManifest; fileIds: string[] }> {
  const zip = await openZip(zipPath);
  const fileIds: string[] = [];
  let manifestJson = '';
  let hasDb = false;

  try {
    await new Promise<void>((resolve, reject) => {
      zip.on('error', reject);
      zip.on('end', resolve);
      zip.on('entry', async (entry: yauzl.Entry) => {
        try {
          const name = entry.fileName;
          if (entry.uncompressedSize > MAX_RESTORE_ENTRY_BYTES) {
            throw new RestoreError('یکی از فایل‌های داخل پشتیبان بیش از حد بزرگ است.');
          }
          if (name === 'manifest.json') {
            if (entry.uncompressedSize > 10 * 1024 * 1024) throw new RestoreError('manifest نامعتبر است.');
            const chunks: Buffer[] = [];
            for await (const c of await readEntryStream(zip, entry)) chunks.push(c as Buffer);
            manifestJson = Buffer.concat(chunks).toString('utf8');
          } else if (name === 'database.sqlite') {
            await pipeline(await readEntryStream(zip, entry), fs.createWriteStream(path.join(intoDir, 'database.sqlite')));
            hasDb = true;
          } else if (name.startsWith('files/')) {
            const id = name.slice('files/'.length);
            if (FILE_ID_RE.test(id)) {
              fs.mkdirSync(path.join(intoDir, 'files'), { recursive: true });
              await pipeline(await readEntryStream(zip, entry), fs.createWriteStream(path.join(intoDir, 'files', id)));
              fileIds.push(id);
            }
          }
          zip.readEntry();
        } catch (e) {
          reject(e);
        }
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }

  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(manifestJson) as BackupManifest;
  } catch {
    throw new RestoreError('این فایل، نسخه پشتیبان پرتال نیست (manifest پیدا نشد).');
  }
  if (manifest.format !== BACKUP_FORMAT || !hasDb) {
    throw new RestoreError('این فایل، نسخه پشتیبان پرتال نیست.');
  }
  if (manifest.version > BACKUP_FORMAT_VERSION) {
    throw new RestoreError('این نسخه پشتیبان با نسخه جدیدتری از برنامه ساخته شده است؛ ابتدا برنامه را به‌روز کنید.');
  }
  return { manifest, fileIds };
}

function columnsOf(database: Database.Database, schema: string, table: string): string[] {
  return (database.prepare(`PRAGMA ${schema}.table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

export interface RestoreSummary {
  backupCreatedAt: string;
  counts: Record<string, number>;
  filesRestored: number;
  safetyBackup: string;
}

/**
 * Replaces all business data with the backup's content without restarting the server:
 *  1. writes a safety backup of the current state,
 *  2. extracts the ZIP into a temp folder (only whitelisted entries),
 *  3. writes every file binary to local disk (the restored server never depends on the old storage),
 *  4. copies all tables in one transaction (columns matched by name, so older backups still load),
 *  5. updates accounts in place (keeps the restoring CEO's session) and ends every other session.
 */
export async function restoreFromBackup(zipPath: string, keepSessionTokenHash: string): Promise<RestoreSummary> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-restore-'));
  try {
    const { manifest, fileIds } = await extractBackup(zipPath, tmpDir);
    const bkDbPath = path.join(tmpDir, 'database.sqlite');

    // Validate the database before touching anything.
    let bkFiles: Array<{ id: string; storage_path: string; stored_filename: string }>;
    try {
      const probe = new Database(bkDbPath, { readonly: true, fileMustExist: true });
      for (const t of ['users', 'orders', 'files', 'checks']) {
        probe.prepare(`SELECT COUNT(*) FROM ${t}`).get();
      }
      bkFiles = probe.prepare(`SELECT id, storage_path, stored_filename FROM files`).all() as typeof bkFiles;
      probe.close();
    } catch {
      throw new RestoreError('دیتابیس داخل فایل پشتیبان خراب یا ناقص است.');
    }

    const safetyName = `pre-restore-${new Date().toISOString().replace(/[:.]/g, '-').replace('T', '-').slice(0, 19)}-${crypto.randomUUID().slice(0, 4)}.zip`;
    await writeBackupToDisk(safetyName);
    pruneBackups('pre-restore-', SAFETY_BACKUPS_TO_KEEP);

    // Place binaries on local disk at their original storage path (confined to the uploads dir).
    const available = new Set(fileIds);
    const localPathById = new Map<string, string>();
    for (const f of bkFiles) {
      if (!available.has(f.id)) continue;
      const rel = f.storage_path && resolveConfinedLocalPath(f.storage_path) ? f.storage_path : `restored/${f.stored_filename || f.id}`;
      const dest = resolveConfinedLocalPath(rel);
      if (!dest) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(tmpDir, 'files', f.id), dest);
      localPathById.set(f.id, rel.replace(/\\/g, '/').replace(/^\/+/, ''));
    }

    db.prepare(`ATTACH DATABASE ? AS bk`).run(bkDbPath);
    try {
      const restore = db.transaction(() => {
        // Children first when deleting, parents first when inserting.
        for (const t of [...RESTORE_TABLES].reverse()) db.prepare(`DELETE FROM main.${t}`).run();
        for (const t of RESTORE_TABLES) {
          const bkCols = new Set(columnsOf(db, 'bk', t));
          if (bkCols.size === 0) continue; // table did not exist in that backup version
          const cols = columnsOf(db, 'main', t).filter((c) => bkCols.has(c));
          const list = cols.map((c) => `"${c}"`).join(', ');
          db.prepare(`INSERT INTO main.${t} (${list}) SELECT ${list} FROM bk.${t}`).run();
        }

        // Accounts: update in place (deleting would cascade-delete every session).
        const userCols = columnsOf(db, 'bk', 'users').filter((c) => c !== 'id' && columnsOf(db, 'main', 'users').includes(c));
        db.prepare(
          `UPDATE main.users SET ${userCols.map((c) => `"${c}" = b."${c}"`).join(', ')} FROM bk.users AS b WHERE main.users.id = b.id`,
        ).run();
        // Everyone except the restoring CEO must sign in again with the restored PINs.
        db.prepare(`DELETE FROM main.sessions WHERE token_hash != ?`).run(keepSessionTokenHash);

        // Point every restored file at the local copy written above.
        const setLocal = db.prepare(
          `UPDATE main.files SET storage_provider = 'local', storage_bucket = '', storage_path = ?, storage_url = ? WHERE id = ?`,
        );
        for (const [id, rel] of localPathById) setLocal.run(rel, `/api/files/${id}`, id);
        db.prepare(
          `UPDATE main.order_documents SET file_url = '/api/files/' || file_id WHERE file_id IN (SELECT id FROM main.files WHERE storage_provider = 'local')`,
        ).run();
        db.prepare(
          `UPDATE main.check_attachments SET file_url = '/api/files/' || file_id WHERE file_id IN (SELECT id FROM main.files WHERE storage_provider = 'local')`,
        ).run();
        db.prepare(
          `UPDATE main.orders SET signature_url = '/api/files/' || signature_file_id WHERE signature_file_id IN (SELECT id FROM main.files WHERE storage_provider = 'local')`,
        ).run();
      });
      restore();
    } finally {
      db.prepare(`DETACH DATABASE bk`).run();
    }

    return {
      backupCreatedAt: manifest.createdAt,
      counts: tableCounts(db),
      filesRestored: localPathById.size,
      safetyBackup: safetyName,
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export { LOCAL_UPLOADS_DIR };
