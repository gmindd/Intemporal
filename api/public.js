const { kv } = require('../lib/kv');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();

  const { resource, date } = req.query;

  // ── Occupied slots for a given date (3 reads → 1 pipeline) ──
  if (resource === 'slots') {
    if (!date) return res.status(400).json({ error: 'date required' });
    const parts   = date.split('/');
    const dateISO = parts.length === 3 ? `${parts[2]}-${parts[1]}-${parts[0]}` : date;

    const pipe = kv.pipeline();
    pipe.get('settings');
    pipe.lrange('bookings', 0, 999);
    pipe.get('blockouts');
    const [settings, raw, blockoutsRaw] = await pipe.exec();

    const defaultDur  = (settings || {}).duration || 30;
    const timeToMin   = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
    const dayBookings = (raw || [])
      .map(b => (typeof b === 'string' ? JSON.parse(b) : b))
      .filter(b => b.date === date);

    const occupied      = dayBookings.map(b => b.time);
    const bookedSegments = dayBookings.map(b => ({
      start: timeToMin(b.time),
      end:   timeToMin(b.time) + (b.serviceDuration || defaultDur),
    }));

    const blockedRanges = (blockoutsRaw || [])
      .filter(b => dateISO >= b.startDate && dateISO <= b.endDate)
      .map(b => ({
        startTime: dateISO === b.startDate ? (b.startTime || '00:00') : '00:00',
        endTime:   dateISO === b.endDate   ? (b.endTime   || '24:00') : '24:00',
      }));

    return res.status(200).json({ occupied, bookedSegments, blockedRanges });
  }

  // ── Public settings (2 reads → 1 pipeline) ────────────────
  const pipe = kv.pipeline();
  pipe.get('settings');
  pipe.get('services');
  const [stored, allServices] = await pipe.exec();

  const s = stored || {};
  const services = (allServices || []).map(svc => {
    const out = { id: svc.id, name: svc.name, duration: svc.duration };
    if (svc.description) out.description = svc.description;
    if (svc.price)       out.price       = svc.price;
    if (svc.photo)       out.photo       = svc.photo;
    return out;
  });

  return res.status(200).json({
    address:         s.address         || '',
    businessName:    s.businessName    || '',
    duration:        s.duration        || 30,
    slotStep:        s.slotStep        || 20,
    bookingEnabled:  s.bookingEnabled !== false, // default true
    businessPhone:   s.businessPhone   || '',
    businessEmail:   s.businessEmail   || '',
    socialFacebook:  s.socialFacebook  || '',
    socialInstagram: s.socialInstagram || '',
    socialYoutube:   s.socialYoutube   || '',
    socialX:         s.socialX         || '',
    services,
  });
};
