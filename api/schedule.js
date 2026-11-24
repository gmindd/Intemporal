const { requireAdmin } = require('../lib/auth');
const { kv } = require('../lib/kv');

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const { DEFAULT_SCHEDULE: DEFAULTS } = require('../assets/js/slots.js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── Blockouts sub-resource ─────────────────────────────────
  if (req.query.blockouts === '1') {
    if (req.method === 'GET') {
      const blockouts = (await kv.get('blockouts')) || [];
      return res.status(200).json({ blockouts });
    }

    if (req.method === 'POST') {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      const { label, startDate, startTime, endDate, endTime } = req.body || {};
      if (!startDate || !endDate) return res.status(400).json({ error: 'Data de início e fim são obrigatórias' });
      if (startDate > endDate)    return res.status(400).json({ error: 'Data de início posterior à data de fim' });
      const blockouts = (await kv.get('blockouts')) || [];
      blockouts.push({
        id:        Date.now().toString(),
        label:     (label     || '').trim(),
        startDate: startDate.trim(),
        startTime: (startTime || '').trim(),
        endDate:   endDate.trim(),
        endTime:   (endTime   || '').trim(),
      });
      await kv.set('blockouts', blockouts);
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'DELETE') {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'id required' });
      const blockouts = ((await kv.get('blockouts')) || []).filter(b => b.id !== id);
      await kv.set('blockouts', blockouts);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).end();
  }

  // ── Exceptional working days sub-resource ─────────────────
  // A date with its own opening hours that replaces the weekly schedule,
  // e.g. opening on a day off. Stored under its own key ('workdays').
  if (req.query.workdays === '1') {
    if (req.method === 'POST') {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      const b = req.body || {};
      const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
      const isTime = v => /^\d{2}:\d{2}$/.test(v || '');
      const date = String(b.date || '').trim();
      const [start1, end1, start2, end2] = ['start1', 'end1', 'start2', 'end2'].map(f => String(b[f] || '').trim());
      if (!isDate(date)) return res.status(400).json({ error: 'Indica a data.' });
      if (!isTime(start1) || !isTime(end1) || end1 <= start1) {
        return res.status(400).json({ error: 'Indica um horário válido (a hora de fim tem de ser depois da de início).' });
      }
      if ((start2 || end2) && (!isTime(start2) || !isTime(end2) || end2 <= start2 || start2 < end1)) {
        return res.status(400).json({ error: 'O segundo período é inválido (tem de começar depois do primeiro terminar).' });
      }
      const workdays = ((await kv.get('workdays')) || []).filter(w => w.date !== date); // one entry per date
      workdays.push({ id: Date.now().toString(), date, label: String(b.label || '').trim().slice(0, 80), start1, end1, start2, end2 });
      workdays.sort((a, b2) => a.date.localeCompare(b2.date));
      await kv.set('workdays', workdays);
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'DELETE') {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'id required' });
      const workdays = ((await kv.get('workdays')) || []).filter(w => w.id !== id);
      await kv.set('workdays', workdays);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).end();
  }

  // ── Regular schedule ──────────────────────────────────────
  if (req.method === 'GET') {
    const pipe = kv.pipeline();
    pipe.get('schedule');
    pipe.get('blockouts');
    pipe.get('workdays');
    const [stored, blockouts, workdays] = await pipe.exec();
    return res.status(200).json({ ...(stored || DEFAULTS), blockouts: blockouts || [], workdays: workdays || [] });
  }

  if (req.method === 'POST') {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    const body     = req.body || {};
    const schedule = {};
    for (const day of DAYS) {
      const d = body[day] || {};
      schedule[day] = {
        active: Boolean(d.active),
        start1: (d.start1 || '').trim(),
        end1:   (d.end1   || '').trim(),
        start2: (d.start2 || '').trim(),
        end2:   (d.end2   || '').trim(),
      };
    }
    await kv.set('schedule', schedule);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).end();
};
