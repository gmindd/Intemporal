const { requireAdmin, checkPassword, createPasswordHash, clearCookieToken } = require('../lib/auth');
const { kv } = require('../lib/kv');

module.exports = async function handler(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  if (req.method === 'GET') {
    const stored = (await kv.get('settings')) || {};
    const config = (await kv.get('admin_config')) || {};
    return res.status(200).json({
      settings: {
        notificationEmail: stored.notificationEmail ?? config.email ?? '',
        notifyBookings:    stored.notifyBookings    ?? true,
        notifyContact:     stored.notifyContact     ?? true,
        hasResendKey:      Boolean(stored.resendApiKey || process.env.RESEND_API_KEY),
        duration:          stored.duration          ?? 30,
        bookingEnabled:    stored.bookingEnabled    !== false,
        slotStep:          stored.slotStep          ?? 20,
        address:           stored.address           ?? '',
        businessName:      stored.businessName      ?? '',
        serviceName:       stored.serviceName       ?? '',
        businessPhone:     stored.businessPhone     ?? '',
        businessEmail:     stored.businessEmail     ?? '',
        socialFacebook:    stored.socialFacebook    ?? '',
        socialInstagram:   stored.socialInstagram   ?? '',
        socialYoutube:     stored.socialYoutube     ?? '',
        socialX:           stored.socialX           ?? '',
        waTplToday:        stored.waTplToday        ?? '',
        waTplNext:         stored.waTplNext         ?? '',
      },
    });
  }

  if (req.method === 'POST') {
    // Partial update: only fields present in the body are changed
    const b        = req.body || {};
    const existing = (await kv.get('settings')) || {};
    const settings = { ...existing };

    const STRING_FIELDS = [
      'notificationEmail', 'address', 'businessName', 'serviceName',
      'businessPhone', 'businessEmail',
      'socialFacebook', 'socialInstagram', 'socialYoutube', 'socialX',
      'waTplToday', 'waTplNext',
    ];
    for (const f of STRING_FIELDS) {
      if (typeof b[f] === 'string') settings[f] = b[f].trim();
    }
    if (b.notifyBookings !== undefined) settings.notifyBookings = Boolean(b.notifyBookings);
    if (b.notifyContact  !== undefined) settings.notifyContact  = Boolean(b.notifyContact);
    if (b.bookingEnabled !== undefined) settings.bookingEnabled = Boolean(b.bookingEnabled);
    if (b.duration       !== undefined) settings.duration       = parseInt(b.duration, 10) || 30;
    if (b.slotStep       !== undefined) settings.slotStep       = Math.min(120, Math.max(5, parseInt(b.slotStep, 10) || 20));
    if (b.resendApiKey && b.resendApiKey.startsWith('re_')) {
      settings.resendApiKey = b.resendApiKey.trim();
    }

    await kv.set('settings', settings);
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'PUT') {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Campos em falta' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'Nova password deve ter pelo menos 8 caracteres' });

    const config = await kv.get('admin_config');
    const valid = await checkPassword(currentPassword, config);
    if (!valid) return res.status(401).json({ error: 'Password atual incorreta' });

    const { salt, hash } = await createPasswordHash(newPassword);
    await kv.set('admin_config', { ...config, salt, hash });
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'DELETE') {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    const KEYS = ['admin_config','settings','schedule','blockouts','services',
                  '_jwt_secret','google_tokens','google_client_id','google_client_secret'];
    await Promise.all(KEYS.map(k => kv.del(k)));
    try { await kv.del('bookings'); } catch {}
    clearCookieToken(res);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).end();
};
