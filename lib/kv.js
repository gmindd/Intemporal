const { kv: _kv } = require('@vercel/kv');
const NS = process.env.SITE_KEY ? `${process.env.SITE_KEY}:` : '';
const k = key => `${NS}${key}`;

// Thin pipeline wrapper that applies the same namespace prefix to every command
function makePipeline() {
  const p = _kv.pipeline();
  return {
    get:     (key)           => p.get(k(key)),
    set:     (key, val, opt) => p.set(k(key), val, opt),
    del:     (key)           => p.del(k(key)),
    lrange:  (key, s, e)     => p.lrange(k(key), s, e),
    lpush:   (key, ...vals)  => p.lpush(k(key), ...vals),
    ltrim:   (key, s, e)     => p.ltrim(k(key), s, e),
    hgetall: (key)           => p.hgetall(k(key)),
    exec:    ()              => p.exec(),
  };
}

const kv = {
  get:      (key)            => _kv.get(k(key)),
  set:      (key, val, opt)  => _kv.set(k(key), val, opt),
  del:      (key)            => _kv.del(k(key)),
  lrange:   (key, s, e)      => _kv.lrange(k(key), s, e),
  lpush:    (key, ...vals)   => _kv.lpush(k(key), ...vals),
  ltrim:    (key, s, e)      => _kv.ltrim(k(key), s, e),
  // Hash commands: each field is written on its own (no read-modify-write races)
  hset:     (key, obj)       => _kv.hset(k(key), obj),
  hgetall:  (key)            => _kv.hgetall(k(key)),
  hdel:     (key, ...fields) => _kv.hdel(k(key), ...fields),
  pipeline: ()               => makePipeline(),
  // Read-only helpers for the backup export (raw keys, namespace included)
  ns:       NS,
  scanAll:  async () => {
    const keys = [];
    let cursor = '0';
    do {
      const [next, batch] = await _kv.scan(cursor, { match: `${NS}*`, count: 500 });
      keys.push(...batch);
      cursor = String(next);
    } while (cursor !== '0');
    return keys;
  },
  raw: _kv,
};

module.exports = { kv };
