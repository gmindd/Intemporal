/* ─────────────────────────────────────────────────────────
   Backup export (backoffice → Configurações). Read-only: lists every
   key of this site and downloads them as one JSON file. Nothing is
   changed in the database.
   Left out: the session secret and short-lived tokens (recreated
   automatically and must not sit in a file).
   ───────────────────────────────────────────────────────── */
const { requireAdmin } = require('../lib/auth');
const { kv } = require('../lib/kv');

const SKIP = [/^_jwt_secret$/, /^recover:/, /^oauth_state:/];

async function readKey(fullKey) {
  const type = await kv.raw.type(fullKey);
  if (type === 'list')   return { type, value: await kv.raw.lrange(fullKey, 0, -1) };
  if (type === 'hash')   return { type, value: await kv.raw.hgetall(fullKey) };
  if (type === 'string') return { type, value: await kv.raw.get(fullKey) };
  return { type, value: null };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const data = {};
  for (const fullKey of (await kv.scanAll()).sort()) {
    const key = fullKey.slice(kv.ns.length);
    if (SKIP.some(re => re.test(key))) continue;
    data[key] = await readKey(fullKey);
  }

  const bookings = data.bookings && Array.isArray(data.bookings.value) ? data.bookings.value.length : 0;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="intemporal-backup-${stamp}.json"`);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(JSON.stringify({
    exportedAt: new Date().toISOString(),
    namespace: kv.ns,
    bookingsCount: bookings,
    keys: data,
  }, null, 1));
};
