const { kv } = require('../lib/kv');
const SlotLogic = require('../assets/js/slots.js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();

  const { resource, date } = req.query;

  // ── Occupied time on a given date (3 reads → 1 pipeline) ──
  // Ranges are in minutes from midnight; the browser builds the slots with SlotLogic.
  if (resource === 'slots') {
    if (!/^\d{2}\/\d{2}\/\d{4}$/.test(date || '')) return res.status(400).json({ error: 'date required (DD/MM/YYYY)' });

    const pipe = kv.pipeline();
    pipe.get('settings');
    pipe.lrange('bookings', 0, 1999);
    pipe.get('blockouts');
    const [settings, raw, blockouts] = await pipe.exec();

    const bookings = (raw || []).map(b => (typeof b === 'string' ? JSON.parse(b) : b));
    const bookedSegments = SlotLogic.bookedSegmentsFor(bookings, date, (settings || {}).duration || 30)
      .map(({ start, end }) => ({ start, end, kind: 'booked' }));
    const blockedRanges = SlotLogic.blockedRangesFor(SlotLogic.ptToISO(date), blockouts);

    return res.status(200).json({ bookedSegments, blockedRanges, now: SlotLogic.lisbonNow() });
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
