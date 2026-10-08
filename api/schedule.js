const { requireAdmin } = require('../lib/auth');
const { kv } = require('../lib/kv');

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const DEFAULTS = {
  mon: { active: true,  start1: '09:00', end1: '13:00', start2: '14:00', end2: '18:00' },
  tue: { active: true,  start1: '09:00', end1: '13:00', start2: '14:00', end2: '18:00' },
  wed: { active: true,  start1: '09:00', end1: '13:00', start2: '14:00', end2: '18:00' },
  thu: { active: true,  start1: '09:00', end1: '13:00', start2: '14:00', end2: '18:00' },
  fri: { active: true,  start1: '09:00', end1: '13:00', start2: '14:00', end2: '18:00' },
  sat: { active: false, start1: '',      end1: '',      start2: '',      end2: '' },
  sun: { active: false, start1: '',      end1: '',      start2: '',      end2: '' },
};

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

  // ── Regular schedule ──────────────────────────────────────
  if (req.method === 'GET') {
    const pipe = kv.pipeline();
    pipe.get('schedule');
    pipe.get('blockouts');
    const [stored, blockouts] = await pipe.exec();
    return res.status(200).json({ ...(stored || DEFAULTS), blockouts: blockouts || [] });
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
