const { kv } = require('../lib/kv');
const { Resend } = require('resend');
const crypto = require('crypto');
const {
  checkPassword, signAdminToken, clearCookieToken,
  requireAdmin, createPasswordHash,
} = require('../lib/auth');

module.exports = async function handler(req, res) {
  // GET /api/auth → who am I
  if (req.method === 'GET') {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    return res.status(200).json({ email: admin.email });
  }

  // POST /api/auth → login / recover / reset
  if (req.method === 'POST') {
    const body   = req.body || {};
    const config = await kv.get('admin_config');

    // action: 'recover' — send reset link by email
    if (body.action === 'recover') {
      // Always return 200 to avoid email enumeration
      const submitted = (body.email || '').trim().toLowerCase();
      if (config && submitted && submitted === (config.email || '').toLowerCase()) {
        const settings   = (await kv.get('settings')) || {};
        const resendKey  = process.env.RESEND_API_KEY || settings.resendApiKey || '';
        if (resendKey) {
          const token = crypto.randomBytes(32).toString('hex');
          await kv.set(`recover:${token}`, config.email, { ex: 3600 });
          const proto = req.headers['x-forwarded-proto'] || 'https';
          const host  = req.headers['x-forwarded-host'] || req.headers.host;
          const link  = `${proto}://${host}/admin?reset=${token}`;
          const resend = new Resend(resendKey);
          await resend.emails.send({
            from: 'SlotBook <noreply@slotbook.cc>',
            to:   config.email,
            subject: 'Recuperação de password — SlotBook',
            html: `
              <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
                <h2 style="color:#B30000">SlotBook — Recuperar Password</h2>
                <p>Recebemos um pedido de recuperação de password para a tua conta.</p>
                <p>Clica no botão abaixo para definir uma nova password. O link é válido durante <strong>1 hora</strong>.</p>
                <p style="margin:28px 0">
                  <a href="${link}" style="background:#B30000;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600">
                    Repor password
                  </a>
                </p>
                <p style="color:#999;font-size:.85em">Se não pediste esta recuperação, ignora este email.</p>
              </div>
            `,
          }).catch(() => {}); // don't fail silently
        }
      }
      return res.status(200).json({ ok: true });
    }

    // action: 'reset' — apply new password with token
    if (body.action === 'reset') {
      const { token, newPassword } = body;
      if (!token || !newPassword) return res.status(400).json({ error: 'Campos em falta' });
      if (newPassword.length < 8) return res.status(400).json({ error: 'A password deve ter pelo menos 8 caracteres' });
      const email = await kv.get(`recover:${token}`);
      if (!email) return res.status(400).json({ error: 'Link inválido ou expirado. Pede um novo link.' });
      await kv.del(`recover:${token}`);
      const { salt, hash } = await createPasswordHash(newPassword);
      await kv.set('admin_config', { ...config, salt, hash });
      return res.status(200).json({ ok: true });
    }

    // Normal login
    if (!config) return res.status(403).json({ error: 'needsSetup', needsSetup: true });
    const { email, password } = body;
    if (!email || !password) return res.status(400).json({ error: 'Campos em falta' });
    if (email !== config.email) return res.status(401).json({ error: 'Credenciais inválidas' });
    const valid = await checkPassword(password, config);
    if (!valid) return res.status(401).json({ error: 'Credenciais inválidas' });
    await signAdminToken(res, email);
    return res.status(200).json({ ok: true });
  }

  // DELETE /api/auth → logout
  if (req.method === 'DELETE') {
    clearCookieToken(res);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).end();
};
