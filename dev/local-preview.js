/* ─────────────────────────────────────────────────────────
   Local preview with FAKE data, for reviewing changes before
   they go live. Never touches the production database:
   '@vercel/kv' is replaced by an in-memory store (saved to
   dev/.local-data.json), and email / Google Calendar / Google
   reviews credentials are removed from the environment.

   Run:   npm run preview:local      → http://localhost:3000
   Backoffice login (local only): teste@intemporal.test / preview-local-123
   Start over with fresh fake data: delete dev/.local-data.json

   With a COPY of the real data (made with `npm run backup`):
          npm run preview:local -- --backup backups/<ficheiro>.json
   The copy is loaded into memory on your computer only; the real
   database is never contacted. Every start reloads the backup, so
   nothing done in this preview is kept. The login is replaced by the
   local one above, and the email key and Google Calendar link are
   removed, so no client gets an email or calendar invite.
   ───────────────────────────────────────────────────────── */
const fs     = require('fs');
const path   = require('path');
const Module = require('module');

const backupArg = process.argv.indexOf('--backup');
const BACKUP_FILE = backupArg > -1 ? path.resolve(process.argv[backupArg + 1] || '') : null;
const DATA_FILE = path.join(__dirname, BACKUP_FILE ? '.local-data-backup.json' : '.local-data.json');

// ── Never reach real services from the preview ──────────────
for (const key of Object.keys(process.env)) {
  if (/^(KV_|UPSTASH_|REDIS_)/.test(key)) delete process.env[key];
}
['RESEND_API_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_PLACES_API_KEY',
 'GOOGLE_PLACE_ID', 'JWT_SECRET', 'SITE_URL'].forEach(k => delete process.env[k]);
process.env.PORT = process.env.PREVIEW_PORT || '3000';
// Same key namespace as production (set before lib/kv is first required)
process.env.SITE_KEY = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8')).env.SITE_KEY;

// ── In-memory KV with the same behaviour as @vercel/kv ──────
let store = {};
try { store = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { store = null; }
const save = () => fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 1));

// @vercel/kv serialises values as JSON and parses them back on read
const ser   = v => (typeof v === 'string' ? v : JSON.stringify(v));
const deser = v => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return v; } };
const range = (arr, s, e) => arr.slice(s < 0 ? Math.max(0, arr.length + s) : s, e < 0 ? arr.length + e + 1 : e + 1);

const ops = {
  get:     k => (k in store ? deser(store[k]) : null),
  set:     (k, v, opt = {}) => { if (opt.nx && k in store) return null; store[k] = ser(v); save(); return 'OK'; },
  del:     (...ks) => { let n = 0; ks.forEach(k => { if (k in store) { delete store[k]; n++; } }); save(); return n; },
  lrange:  (k, s, e) => range(Array.isArray(store[k]) ? store[k] : [], s, e).map(deser),
  lpush:   (k, ...vals) => { const l = Array.isArray(store[k]) ? store[k] : []; vals.forEach(v => l.unshift(ser(v))); store[k] = l; save(); return l.length; },
  ltrim:   (k, s, e) => { if (Array.isArray(store[k])) { store[k] = range(store[k], s, e); save(); } return 'OK'; },
  hset:    (k, obj) => { const h = (store[k] && typeof store[k] === 'object' && !Array.isArray(store[k])) ? store[k] : {}; let n = 0; for (const [f, v] of Object.entries(obj)) { if (!(f in h)) n++; h[f] = ser(v); } store[k] = h; save(); return n; },
  hgetall: k => { const h = store[k]; if (!h || typeof h !== 'object' || Array.isArray(h) || !Object.keys(h).length) return null; return Object.fromEntries(Object.entries(h).map(([f, v]) => [f, deser(v)])); },
  hdel:    (k, ...fs) => { const h = store[k]; let n = 0; if (h && typeof h === 'object') fs.forEach(f => { if (f in h) { delete h[f]; n++; } }); save(); return n; },
  scan:    (cursor, opts = {}) => {
    const re = new RegExp('^' + String(opts.match || '*').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    return ['0', Object.keys(store).filter(k => re.test(k))];
  },
  type:    k => (!(k in store) ? 'none' : Array.isArray(store[k]) ? 'list' : typeof store[k] === 'object' ? 'hash' : 'string'),
};

const mockKv = { ...Object.fromEntries(Object.entries(ops).map(([n, fn]) => [n, async (...a) => fn(...a)])) };
mockKv.pipeline = () => {
  const queue = [];
  const p = new Proxy({}, {
    get: (_, name) => name === 'exec'
      ? async () => queue.map(([n, a]) => ops[n](...a))
      : (...a) => { queue.push([name, a]); return p; },
  });
  return p;
};

const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === '@vercel/kv') return { kv: mockKv, createClient: () => mockKv };
  return realLoad.call(this, request, ...rest);
};

// ── Copy of the real data from a backup file ────────────────
async function loadBackup() {
  const NS = process.env.SITE_KEY ? `${process.env.SITE_KEY}:` : '';
  const backup = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8'));
  store = {};
  for (const [key, { type, value }] of Object.entries(backup.keys || {})) {
    if (type === 'list')        store[NS + key] = (value || []).map(ser);
    else if (type === 'hash')   store[NS + key] = Object.fromEntries(Object.entries(value || {}).map(([f, v]) => [f, ser(v)]));
    else if (type === 'string') store[NS + key] = ser(value);
  }
  // Local login instead of the owner's, and no way to reach clients or Google
  const { createPasswordHash } = require('../lib/auth');
  const { salt, hash } = await createPasswordHash('preview-local-123');
  store[NS + 'admin_config'] = ser({ email: 'teste@intemporal.test', salt, hash });
  ['google_tokens', 'google_client_id', 'google_client_secret', '_jwt_secret'].forEach(k => delete store[NS + k]);
  if (store[NS + 'settings']) {
    const s = deser(store[NS + 'settings']);
    delete s.resendApiKey;
    store[NS + 'settings'] = ser(s);
  }
  save();
  const n = Array.isArray(store[NS + 'bookings']) ? store[NS + 'bookings'].length : 0;
  console.log(`Cópia dos dados reais carregada de ${BACKUP_FILE} (${n} marcações). Nada é gravado na base de dados real.`);
}

// ── Fake data (only the first time) ─────────────────────────
async function seed() {
  if (BACKUP_FILE) return loadBackup();
  if (store) return;
  store = {};
  const NS = 'SLOTBOOK-PRO:';
  const { createPasswordHash } = require('../lib/auth');
  const { salt, hash } = await createPasswordHash('preview-local-123');
  const put = (k, v) => { store[NS + k] = ser(v); };

  put('admin_config', { email: 'teste@intemporal.test', salt, hash });
  put('settings', {
    businessName: 'Intemporal Barbearia', address: 'Rua de Palme 277', businessPhone: '+351 912 000 000',
    businessEmail: 'geral@intemporal.test', slotStep: 20, duration: 30, rescheduleHours: 24,
    socialInstagram: 'https://www.instagram.com/intemporal.barbearia/',
  });
  const DAY = { active: true, start1: '09:00', end1: '13:00', start2: '14:30', end2: '19:30' };
  put('schedule', { mon: { active: false, start1: '', end1: '', start2: '', end2: '' }, tue: DAY, wed: DAY, thu: DAY, fri: DAY,
                    sat: { active: true, start1: '09:00', end1: '13:00', start2: '', end2: '' },
                    sun: { active: false, start1: '', end1: '', start2: '', end2: '' } });
  put('services', [
    { id: 's1', name: 'Corte', duration: 30, price: '12€', description: 'Corte à tesoura ou máquina, lavagem e finalização.', color: '#3e63dd' },
    { id: 's2', name: 'Barba', duration: 20, price: '8€', description: 'Barba aparada e contornos à navalha.', color: '#30a46c' },
    { id: 's3', name: 'Corte + Barba', duration: 50, price: '18€', description: 'O serviço completo.', color: '#e5484d' },
    { id: 's4', name: 'Corte infantil', duration: 30, price: '10€', description: 'Até aos 12 anos.', color: '#f5a524' },
  ]);

  // Bookings spread over the coming days (newest first, as in production)
  const pad = n => String(n).padStart(2, '0');
  const ptDate = d => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  const names = ['João Silva', 'Pedro Costa', 'Miguel Santos', 'Rui Ferreira', 'Tiago Oliveira', 'André Martins', 'Bruno Sousa', 'Carlos Pereira'];
  const bookings = [];
  let n = 0;
  for (let offset = -2; offset <= 9; offset++) {
    const d = new Date(); d.setDate(d.getDate() + offset);
    const dow = d.getDay();
    if (dow === 0 || dow === 1) continue;
    ['10:00', '11:20', '15:00', '17:40'].slice(0, 2 + (offset % 3 === 0 ? 2 : 0)).forEach(time => {
      const svc = [['s1', 'Corte', 30], ['s2', 'Barba', 20], ['s3', 'Corte + Barba', 50], ['s4', 'Corte infantil', 30]][n % 4];
      const name = names[n % names.length];
      bookings.push({
        id: `${Date.now() - n * 1000}seed${n}`, name,
        email: n % 3 === 2 ? '' : `${name.split(' ')[0].toLowerCase()}@exemplo.test`,
        phone: n % 4 === 3 ? '' : `91${pad(n)}00${pad(n)}0`,
        message: '', date: ptDate(d), time, service: svc[1], serviceId: svc[0], serviceDuration: svc[2],
        source: n % 2 ? 'admin' : 'online', manageToken: `seedtoken${n}`, createdAt: new Date().toISOString(),
      });
      n++;
    });
  }
  store[NS + 'bookings'] = bookings.reverse().map(b => JSON.stringify(b));
  save();
  console.log('Dados fictícios criados em dev/.local-data.json');
}

seed().then(() => {
  require('../server.js');
  console.log(BACKUP_FILE
    ? '\nPRÉ-VISUALIZAÇÃO LOCAL com uma CÓPIA dos dados reais (a base de dados real não é usada).'
    : '\nPRÉ-VISUALIZAÇÃO LOCAL com dados fictícios (a base de dados real não é usada).');
  console.log('Backoffice: http://localhost:' + process.env.PORT + '/admin  (teste@intemporal.test / preview-local-123)\n');
});
