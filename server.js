/* ─────────────────────────────────────────────────────────
   Standalone Node server for self-hosting (VPS, Docker,
   Railpack/Nixpacks…). Mirrors what Vercel does for this
   project: serves the static pages, mounts every api/*.js
   handler and applies the rewrites from vercel.json.
   On Vercel this file is ignored.
   ───────────────────────────────────────────────────────── */
const path    = require('path');
const fs      = require('fs');
const express = require('express');

const ROOT = __dirname;
const PORT = process.env.PORT || 3000;

// Env defaults that vercel.json would otherwise inject
const vercelConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
for (const [key, val] of Object.entries(vercelConfig.env || {})) {
  if (process.env[key] === undefined) process.env[key] = val;
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ── API handlers (api/<name>.js → /api/<name>) ─────────────
const handlers = {};
for (const file of fs.readdirSync(path.join(ROOT, 'api'))) {
  if (file.endsWith('.js')) handlers[file.slice(0, -3)] = require(path.join(ROOT, 'api', file));
}

function runHandler(name, extraQuery = {}) {
  return async (req, res, next) => {
    const handler = handlers[name];
    if (!handler) return next();
    Object.assign(req.query, extraQuery);
    try {
      await handler(req, res);
    } catch (err) {
      console.error(`[api/${name}]`, err);
      if (!res.headersSent) res.status(500).json({ error: 'Erro interno do servidor.' });
    }
  };
}

// ── Rewrites from vercel.json ───────────────────────────────
for (const { source, destination } of vercelConfig.rewrites || []) {
  const url = new URL(destination, 'http://localhost');
  const apiMatch = url.pathname.match(/^\/api\/([\w-]+)$/);
  if (apiMatch) {
    app.all(source, runHandler(apiMatch[1], Object.fromEntries(url.searchParams)));
  } else {
    app.get(source, (req, res) => res.sendFile(path.join(ROOT, url.pathname)));
  }
}

app.all('/api/:name', (req, res, next) => runHandler(req.params.name)(req, res, next));

// ── Static pages (only public folders — never api/, lib/ or config) ──
app.get(['/', '/index.html'], (req, res) => res.sendFile(path.join(ROOT, 'index.html')));
app.use('/admin', express.static(path.join(ROOT, 'admin'), { extensions: ['html'] }));

// Vercel Analytics script does not exist outside Vercel
app.get('/_vercel/insights/script.js', (req, res) => res.type('js').send(''));

app.use((req, res) => res.status(404).sendFile(path.join(ROOT, 'index.html')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Intemporal Barbearia a correr em http://0.0.0.0:${PORT}`);
});
