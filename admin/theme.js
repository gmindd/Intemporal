/* ─────────────────────────────────────────────────────────
   Backoffice colours chosen in Configurações → Cores.
   Loaded in <head> of every backoffice page so the last saved
   colours (remembered in this browser) apply before the page
   is drawn; the dashboard refreshes them from the server.
   ───────────────────────────────────────────────────────── */
(function () {
  function hexToRgb(hex) {
    var n = parseInt(hex.slice(1), 16);
    return [n >> 16, (n >> 8) & 255, n & 255];
  }
  function toHex(rgb) {
    return '#' + rgb.map(function (v) { return ('0' + Math.max(0, Math.min(255, Math.round(v))).toString(16)).slice(-2); }).join('');
  }
  function mix(hex, target, f) { // f = 0 → hex, 1 → target
    var a = hexToRgb(hex), b = hexToRgb(target);
    return toHex(a.map(function (v, i) { return v + (b[i] - v) * f; }));
  }
  function isLight(hex) {
    var c = hexToRgb(hex);
    return (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255 > 0.6;
  }
  var ok = function (v) { return /^#[0-9a-fA-F]{6}$/.test(v || ''); };

  window.applyAdminColors = function (c) {
    c = c || {};
    var v = [];
    if (ok(c.page))   v.push('--cream:' + c.page);
    if (ok(c.card))   { v.push('--cream2:' + c.card); v.push('--cream3:' + mix(c.card, '#000000', 0.06)); }
    if (ok(c.bar))    { v.push('--dark:' + c.bar); v.push('--dark2:' + mix(c.bar, isLight(c.bar) ? '#000000' : '#ffffff', 0.06)); }
    if (ok(c.title))  v.push('--title:' + c.title);
    if (ok(c.text))   v.push('--text:' + c.text);
    if (ok(c.text2))  { v.push('--text2:' + c.text2); v.push('--text3:' + mix(c.text2, ok(c.page) ? c.page : '#faf7f2', 0.35)); }
    if (ok(c.accent)) {
      var rgb = hexToRgb(c.accent);
      v.push('--gold:' + c.accent);
      v.push('--gold-l:' + mix(c.accent, '#000000', 0.2));
      v.push('--gold-dim:rgba(' + rgb.join(',') + ',.10)');
    }
    var el = document.getElementById('adminColors');
    if (!el) { el = document.createElement('style'); el.id = 'adminColors'; document.head.appendChild(el); }
    el.textContent = v.length ? ':root{' + v.join(';') + '}' : '';
    // A light top bar needs dark text
    document.documentElement.classList.toggle('admin-light-bar', ok(c.bar) && isLight(c.bar));
  };

  window.rememberAdminColors = function (c) {
    try {
      if (c && Object.keys(c).length) localStorage.setItem('adminColors', JSON.stringify(c));
      else localStorage.removeItem('adminColors');
    } catch (e) {}
  };

  try {
    var saved = JSON.parse(localStorage.getItem('adminColors') || 'null');
    if (saved) window.applyAdminColors(saved);
  } catch (e) {}
})();
