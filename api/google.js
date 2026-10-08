const crypto = require('crypto');
const { requireAdmin, getToken } = require('../lib/auth');
const {
  buildAuthUrl, hasCredentials, exchangeCode,
  getAuthorizedClient, disconnectCalendar,
} = require('../lib/google');
const { kv } = require('../lib/kv');

module.exports = async function handler(req, res) {
  const { action } = req.query;
  if (action === 'auth')        return handleAuth(req, res);
  if (action === 'callback')    return handleCallback(req, res);
  if (action === 'credentials') return handleCredentials(req, res);
  if (action === 'disconnect')  return handleDisconnect(req, res);
  if (action === 'status')      return handleStatus(req, res);
  if (action === 'test')        return handleTest(req, res);
  return res.status(404).end();
};

async function handleAuth(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  if (!await hasCredentials()) return res.status(400).json({ error: 'Credenciais Google não configuradas' });
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || `${proto}://${host}/api/google/callback`;
  const state = crypto.randomBytes(16).toString('hex');
  await kv.set(`oauth_state:${state}`, redirectUri, { ex: 600 });
  return res.redirect(302, await buildAuthUrl(redirectUri, state));
}

async function handleCallback(req, res) {
  const token = getToken(req);
  if (!token) return res.redirect(302, '/admin?error=auth');
  const { code, state, error } = req.query;
  if (error) return res.redirect(302, '/admin/dashboard?error=google_denied');
  const stateKey  = `oauth_state:${state}`;
  const redirectUri = await kv.get(stateKey);
  if (!redirectUri) return res.redirect(302, '/admin/dashboard?error=invalid_state');
  await kv.del(stateKey);
  try {
    await exchangeCode(code, redirectUri);
    return res.redirect(302, '/admin/dashboard?success=google_connected');
  } catch (err) {
    console.error('[Google callback]', err.message);
    return res.redirect(302, '/admin/dashboard?error=google_failed');
  }
}

async function handleCredentials(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  if (req.method === 'GET') {
    const clientId     = process.env.GOOGLE_CLIENT_ID     || await kv.get('google_client_id');
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET || await kv.get('google_client_secret');
    return res.status(200).json({ hasCredentials: Boolean(clientId && clientSecret) });
  }
  if (req.method === 'POST') {
    const { clientId, clientSecret } = req.body || {};
    if (!clientId || !clientSecret) return res.status(400).json({ error: 'Campos em falta' });
    await kv.set('google_client_id', clientId.trim());
    await kv.set('google_client_secret', clientSecret.trim());
    return res.status(200).json({ ok: true });
  }
  return res.status(405).end();
}

async function handleDisconnect(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  if (req.method !== 'DELETE') return res.status(405).end();
  await disconnectCalendar();
  return res.status(200).json({ ok: true });
}

async function handleStatus(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const tokens   = await kv.get('google_tokens');
  const hasCreds = await hasCredentials();
  const proto    = req.headers['x-forwarded-proto'] || 'https';
  const host     = req.headers['x-forwarded-host'] || req.headers.host;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || `${proto}://${host}/api/google/callback`;
  return res.status(200).json({ connected: Boolean(tokens), hasCredentials: hasCreds, redirectUri });
}

async function handleTest(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const tokens = await kv.get('google_tokens');
  if (!tokens) return res.status(200).json({ ok: false, error: 'Sem tokens — Google Calendar não ligado.' });
  const tokenInfo = {
    hasAccessToken:  Boolean(tokens.access_token),
    hasRefreshToken: Boolean(tokens.refresh_token),
    expiry:  tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : 'desconhecido',
    expired: tokens.expiry_date ? tokens.expiry_date < Date.now() : 'desconhecido',
  };
  try {
    const { google } = require('googleapis');
    const auth = await getAuthorizedClient();
    const calendar = google.calendar({ version: 'v3', auth });
    const { data } = await calendar.calendarList.list({ maxResults: 1 });
    return res.status(200).json({
      ok: true, tokenInfo,
      calendars: (data.items || []).map(c => ({ id: c.id, summary: c.summary })),
    });
  } catch (err) {
    return res.status(200).json({ ok: false, tokenInfo, error: err.message, code: err.code });
  }
}
