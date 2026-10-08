const { kv } = require('../lib/kv');
const { createPasswordHash, signAdminToken } = require('../lib/auth');

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    const config = await kv.get('admin_config');
    return res.status(200).json({ needsSetup: !config });
  }

  if (req.method === 'POST') {
    const existing = await kv.get('admin_config');
    if (existing) return res.status(403).json({ error: 'Configuração já realizada' });

    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email e password são obrigatórios' });
    if (password.length < 8) return res.status(400).json({ error: 'Password deve ter pelo menos 8 caracteres' });

    const { salt, hash } = await createPasswordHash(password);
    await kv.set('admin_config', { email, salt, hash });

    await signAdminToken(res, email);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).end();
};
