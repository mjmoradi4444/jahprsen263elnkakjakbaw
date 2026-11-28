import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import { createApiRouter } from './server/routes';

const PORT = Number(process.env.PORT || 3000);

async function startServer(): Promise<void> {
  const app = express();
  app.disable('x-powered-by');

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
