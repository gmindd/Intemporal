const { requireAdmin } = require('../lib/auth');
const { kv } = require('../lib/kv');

module.exports = async function handler(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  if (req.method === 'GET') {
    const services = (await kv.get('services')) || [];
    return res.status(200).json({ services });
  }

  if (req.method === 'POST') {
    const { services } = req.body || {};
    if (!Array.isArray(services)) return res.status(400).json({ error: 'Formato inválido' });

    for (const [i, svc] of services.entries()) {
      if (!svc.name?.trim())
        return res.status(400).json({ error: `Serviço ${i + 1}: o campo "nome" é obrigatório.` });
      const dur = parseInt(svc.duration, 10);
      if (!svc.duration || isNaN(dur) || dur < 1)
        return res.status(400).json({ error: `Serviço ${i + 1}: o campo "duração" é obrigatório e deve ser um número positivo.` });
    }

    const OPTIONAL = ['description', 'price', 'photo'];
    const LABELS   = { description: 'descrição', price: 'preço', photo: 'foto (URL)' };
    for (const field of OPTIONAL) {
      const filled = services.filter(s => s[field]?.trim());
      if (filled.length > 0 && filled.length < services.length) {
        return res.status(400).json({
          error: `O campo "${LABELS[field]}" está preenchido em ${filled.length} de ${services.length} serviço(s), mas não em todos. Para garantir uma apresentação uniforme no site, todos os serviços devem ter este campo preenchido — ou nenhum deve ter.`,
        });
      }
    }

    const clean = services.map((s, i) => ({
      id:          s.id || `svc-${Date.now()}-${i}`,
      name:        s.name.trim(),
      duration:    parseInt(s.duration, 10),
      description: s.description?.trim() || '',
      price:       s.price?.trim() || '',
      photo:       s.photo?.trim() || '',
    }));

    await kv.set('services', clean);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).end();
};
