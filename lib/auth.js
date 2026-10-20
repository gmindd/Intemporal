const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { promisify } = require('util');
const { kv } = require('./kv');

const pbkdf2 = promisify(crypto.pbkdf2);

async function getJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  let secret = await kv.get('_jwt_secret');
  if (!secret) {
    secret = crypto.randomBytes(64).toString('hex');
    await kv.set('_jwt_secret', secret);
  }
  return secret;
}

async function createPasswordHash(password) {
  const salt = crypto.randomBytes(32).toString('hex');
  const hash = (await pbkdf2(password, salt, 100000, 64, 'sha512')).toString('hex');
  return { salt, hash };
}

async function checkPassword(password, stored) {
  const hash = (await pbkdf2(password, stored.salt, 100000, 64, 'sha512')).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(stored.hash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function getToken(req) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/(?:^|;\s*)sb_token=([^;]+)/);
  return match ? match[1] : null;
}

async function verifyAdmin(req) {
  const token = getToken(req);
  if (!token) return null;
  try {
    const secret = await getJwtSecret();
    return jwt.verify(token, secret);
  } catch {
    return null;
  }
}

// Sliding session: valid for SESSION_DAYS since the last use of the backoffice.
// The cookie is re-issued at most once per hour while the owner keeps using it.
const SESSION_DAYS = 7;
const RENEW_AFTER_S = 60 * 60;

async function requireAdmin(req, res) {
  const admin = await verifyAdmin(req);
  if (!admin) {
    res.status(401).json({ error: 'Sessão expirada. Inicia sessão novamente.', sessionExpired: true });
    return null;
  }
  if (admin.iat && Date.now() / 1000 - admin.iat > RENEW_AFTER_S && !res.headersSent) {
    await signAdminToken(res, admin.email);
  }
  return admin;
}

async function signAdminToken(res, email) {
  const secret = await getJwtSecret();
  const token = jwt.sign({ email, role: 'admin' }, secret, { expiresIn: `${SESSION_DAYS}d` });
  setCookieToken(res, token);
  return token;
}

// Secure only when the request really arrived over HTTPS (directly or via a reverse
// proxy such as Vercel or Coolify/Traefik). A Secure cookie on plain HTTP is silently
// dropped by the browser, which made login bounce back to the login screen.
function isHttps(req) {
  if (!req) return process.env.NODE_ENV === 'production';
  const proto = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim();
  return proto ? proto === 'https' : Boolean(req.socket?.encrypted);
}

function setCookieToken(res, token) {
  const secure = isHttps(res.req) ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    `sb_token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`
  );
}

function clearCookieToken(res) {
  res.setHeader('Set-Cookie',
    'sb_token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'
  );
}

module.exports = {
  getToken, verifyAdmin, requireAdmin, signAdminToken,
  createPasswordHash, checkPassword, setCookieToken, clearCookieToken,
};
