import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import { createApiRouter } from './server/routes';
import { mirrorUsersAndSettingsToSupabase, restoreFromSupabaseIfEmpty } from './server/supabase-restore';
import { startDailyBackupScheduler } from './server/backup';

const PORT = Number(process.env.PORT || 3000);

// `npm start` passes --production so production mode works the same on Linux hosts and Windows
// (setting NODE_ENV inline in an npm script does not work in the Windows shell).
if (process.argv.includes('--production')) {
  process.env.NODE_ENV = 'production';
}

// Safety net: a stray async error in one request (e.g. a client disconnecting mid-download) must be
// logged, never take the whole portal down for everyone. Data writes are transactional, so
// continuing is safe.
process.on('unhandledRejection', (reason) => {
  const code = (reason as { code?: string })?.code;
  if (code === 'ERR_STREAM_PREMATURE_CLOSE') {
    console.warn('[Server] A download was cancelled by the browser.');
    return;
  }
  console.error('[Server] Unhandled async error (server keeps running):', reason);
});

async function startServer(): Promise<void> {
  // If the disk was wiped (host without persistent storage), pull data back from Supabase first.
  await restoreFromSupabaseIfEmpty();
  void mirrorUsersAndSettingsToSupabase();
  // One automatic full backup per Tehran day in DATA_DIR/backups (newest 7 kept).
  startDailyBackupScheduler();

  const app = express();
  app.disable('x-powered-by');
  // Behind a reverse proxy (Liara, Render, Railway, Nginx...) set TRUST_PROXY=1 so the login
  // rate limiter sees each client's real IP instead of locking everyone out via the proxy's IP.
  if (process.env.TRUST_PROXY === '1') {
    app.set('trust proxy', 1);
  }

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));

  // Mount authenticated REST & SSE API
  app.use('/api', createApiRouter());

  // 404 JSON fallback for unknown /api routes
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'مسیر API یافت نشد.' });
  });

  if (process.env.NODE_ENV === 'production') {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
