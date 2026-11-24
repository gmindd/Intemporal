/* ─────────────────────────────────────────────────────────
   Read-only backup of the production database, to run on your
   own computer BEFORE a deploy. It only reads: nothing is
   written, changed or deleted in the database.

   The database can hold several sites (each with its own key
   prefix, set by SITE_KEY). Every site found is saved to its own
   file, and a summary shows which one has the current bookings.

   1. In Coolify, copy the values of KV_REST_API_URL and
      KV_REST_API_TOKEN (Environment Variables of this app).
   2. In PowerShell, in the project folder:
        $env:KV_REST_API_URL="..."; $env:KV_REST_API_TOKEN="..."
        node scripts\backup-kv.js
   3. The files are saved in backups/ (kept out of git). Keep them
      somewhere safe: they contain client data.
   ───────────────────────────────────────────────────────── */
const fs   = require('fs');
const path = require('path');

const url   = process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
if (!url || !token) {
  console.error('Faltam as variáveis KV_REST_API_URL e KV_REST_API_TOKEN (copia-as do Coolify).');
  process.exit(1);
}

const { createClient } = require('@vercel/kv');
const redis = createClient({ url, token });

// Keys every site of this app has; they reveal the site prefixes in use
const MARKERS = ['bookings', 'settings', 'admin_config', 'schedule', 'services'];

const parse = v => (typeof v === 'string' ? (() => { try { return JSON.parse(v); } catch { return v; } })() : v);
const toISO = datePt => String(datePt || '').split('/').reverse().join('-');

(async () => {
  const all = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, { match: '*', count: 500 });
    all.push(...batch);
    cursor = String(next);
  } while (cursor !== '0');

  // Site prefixes: 'PREFIX:' in front of a marker key ('' = no prefix)
  const prefixes = new Set();
  for (const k of all) {
    for (const m of MARKERS) {
      if (k === m) prefixes.add('');
      else if (k.endsWith(':' + m)) prefixes.add(k.slice(0, -m.length));
    }
  }
  const named = [...prefixes].filter(Boolean).sort((a, b) => b.length - a.length);
  const owner = k => named.find(p => k.startsWith(p)) ?? '';

  const dir = path.join(__dirname, '..', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const today = new Date().toISOString().slice(0, 10);

  console.log(`\nBase de dados: ${all.length} chaves no total.\n`);
  for (const ns of [...prefixes].sort()) {
    const keys = all.filter(k => owner(k) === ns).sort();
    const data = {};
    for (const fullKey of keys) {
      const type = await redis.type(fullKey);
      let value = null;
      if (type === 'list')        value = await redis.lrange(fullKey, 0, -1);
      else if (type === 'hash')   value = await redis.hgetall(fullKey);
      else if (type === 'string') value = await redis.get(fullKey);
      data[fullKey.slice(ns.length)] = { type, value };
    }

    const bookings = (data.bookings && Array.isArray(data.bookings.value) ? data.bookings.value : []).map(parse);
    const dates = bookings.map(b => toISO(b.date)).filter(Boolean).sort();
    const future = dates.filter(d => d >= today).length;
    const label = ns ? ns.replace(/:$/, '') : 'sem-prefixo';
    const file = path.join(dir, `backup-${stamp}-${label.replace(/[^\w.-]/g, '_')}.json`);
    fs.writeFileSync(file, JSON.stringify({ exportedAt: new Date().toISOString(), namespace: ns, bookingsCount: bookings.length, keys: data }, null, 1));

    console.log(`Site "${label}"`);
    console.log(`  ${keys.length} chaves · ${bookings.length} marcações · ${future} futuras` +
      (dates.length ? ` · de ${dates[0]} a ${dates[dates.length - 1]}` : ''));
    console.log(`  Guardado em ${file}\n`);
  }
  if (!prefixes.size) console.log('Não foi encontrado nenhum site nesta base de dados.');
})().catch(err => {
  console.error('Erro no backup:', err.message);
  process.exit(1);
});
