/* ═══════════════════════════════════════════════════════
   SLOTBOOK — admin.js (dashboard)
   ═══════════════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', () => {
  guardAuth();
  initTabs();
  initLogout();
  initWhatsapp();
  loadBookings();
  loadSchedule();
  loadServices();
  loadCalendarStatus();
  loadSettings();
  initPasswordForm();
  handleURLParams();
  initGcalInstructions();
});

/* ── Auth guard ─────────────────────────────────────────── */
async function guardAuth() {
  try {
    const res = await apiFetch('/api/auth');
    if (!res.ok) return location.replace('/admin');
    const { email } = await res.json();
    const el = document.getElementById('dbUser');
    if (el) el.textContent = email;
  } catch {
    location.replace('/admin');
  }
}

/* ── Tabs ───────────────────────────────────────────────── */
function initTabs() {
  const tabs     = document.querySelectorAll('.dbt');
  const sections = document.querySelectorAll('.db-section');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const id = tab.dataset.tab;

      tabs.forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
      sections.forEach(s => s.classList.remove('active'));

      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      document.getElementById(`tab-${id}`)?.classList.add('active');
    });
  });
}

/* ── Logout ─────────────────────────────────────────────── */
function initLogout() {
  document.getElementById('logoutBtn')?.addEventListener('click', async () => {
    await apiFetch('/api/auth', { method: 'DELETE' });
    location.replace('/admin');
  });
}

/* ── Bookings ───────────────────────────────────────────── */
async function loadBookings() {
  document.getElementById('refreshBtn')?.addEventListener('click', fetchBookings);
  await fetchBookings();
}

async function fetchBookings() {
  const stateEl = document.getElementById('bookingsState');
  const gridEl  = document.getElementById('weekGrid');
  const emptyEl = document.getElementById('bookingsEmpty');

  stateEl.textContent = 'A carregar…';
  stateEl.style.display = 'block';
  gridEl.innerHTML = '';
  emptyEl.style.display = 'none';

  try {
    const res = await apiFetch('/api/bookings');
    if (!res.ok) throw new Error('Erro ' + res.status);
    const { bookings } = await res.json();

    _waData.bookings = bookings || [];
    renderWaPanel();

    stateEl.style.display = 'none';

    // Build 7-day window: today + 6 days
    const days = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const DAY_NAMES = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
    for (let i = 0; i < 7; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() + i);
      const dd   = String(d.getDate()).padStart(2, '0');
      const mm   = String(d.getMonth() + 1).padStart(2, '0');
      const yyyy = d.getFullYear();
      days.push({
        key:   `${dd}/${mm}/${yyyy}`,
        label: i === 0 ? 'Hoje' : i === 1 ? 'Amanhã' : DAY_NAMES[d.getDay()],
        date:  `${dd}/${mm}`,
      });
    }

    // Group bookings by date key
    const byDay = {};
    (bookings || []).forEach(b => { (byDay[b.date] = byDay[b.date] || []).push(b); });
    days.forEach(d => { if (!byDay[d.key]) byDay[d.key] = []; });

    // Sort each day by time
    days.forEach(d => byDay[d.key].sort((a, b) => a.time.localeCompare(b.time)));

    const totalBookings = days.reduce((s, d) => s + byDay[d.key].length, 0);
    if (totalBookings === 0) { emptyEl.style.display = 'block'; return; }

    days.forEach((d, i) => {
      const col = document.createElement('div');
      col.className = 'wg-col' + (i === 0 ? ' wg-today' : '');

      const head = document.createElement('div');
      head.className = 'wg-head';
      head.innerHTML = `<span class="wg-label">${d.label}</span><span class="wg-date">${d.date}</span>`;
      col.appendChild(head);

      const body = document.createElement('div');
      body.className = 'wg-body';

      if (byDay[d.key].length === 0) {
        const empty = document.createElement('div');
        empty.className = 'wg-empty';
        empty.textContent = '—';
        body.appendChild(empty);
      } else {
        byDay[d.key].forEach(b => {
          const card = document.createElement('div');
          card.className = 'wg-card';
          card.innerHTML = `
            <div class="wg-time">
              ${esc(b.time)}${b.serviceDuration ? `<span class="wg-dur"> · ${b.serviceDuration} min</span>` : ''}
              <button class="wg-edit-btn" data-id="${esc(b.id)}" data-date="${esc(b.date)}" data-time="${esc(b.time)}" title="Editar marcação">✏</button>
            </div>
            <div class="wg-name">${esc(b.name)}</div>
            <div class="wg-svc">${esc(b.service || '—')}</div>
            <a class="wg-email" href="mailto:${esc(b.email)}">${esc(b.email)}</a>
            ${b.phone ? `<div class="wg-phone">${esc(b.phone)}</div>` : ''}
            ${b.message ? `<div class="wg-msg" title="${esc(b.message)}">${esc(b.message)}</div>` : ''}
          `;
          body.appendChild(card);
        });
      }

      col.appendChild(body);
      gridEl.appendChild(col);
    });
  } catch (err) {
    stateEl.textContent = 'Erro ao carregar marcações: ' + err.message;
  }
}

/* ── WhatsApp reminders panel ───────────────────────────── */
const WA_TPL_TODAY_DEFAULT = 'Olá {nome}! 👋 Lembramos a sua marcação de hoje às {hora} — {servico} — em {negocio}, {morada}. Até já!';
const WA_TPL_NEXT_DEFAULT  = 'Olá {nome}! 👋 Lembramos a sua marcação de {servico} no dia {data} às {hora} em {negocio}, {morada}. Qualquer questão contacte-nos: {telefone}. Até breve!';

const _waData = { bookings: null, schedule: null, settings: null };

function initWhatsapp() {
  document.getElementById('waRefreshBtn')?.addEventListener('click', fetchBookings);

  // Rebuild the wa.me links live as the templates are edited
  document.getElementById('waTplToday')?.addEventListener('input', renderWaPanel);
  document.getElementById('waTplNext')?.addEventListener('input', renderWaPanel);

  document.getElementById('waTplSave')?.addEventListener('click', async () => {
    const btn   = document.getElementById('waTplSave');
    const msgEl = document.getElementById('waTplMsg');
    btn.disabled = true;
    btn.textContent = 'A guardar…';
    msgEl.className = 'sf-msg';
    msgEl.textContent = '';
    try {
      const res = await apiFetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          waTplToday: document.getElementById('waTplToday').value,
          waTplNext:  document.getElementById('waTplNext').value,
        }),
      });
      if (!res.ok) throw new Error('Erro ' + res.status);
      msgEl.className = 'sf-msg ok';
      msgEl.textContent = 'Templates guardados.';
    } catch (err) {
      msgEl.className = 'sf-msg err';
      msgEl.textContent = 'Erro ao guardar: ' + err.message;
    }
    btn.disabled = false;
    btn.textContent = 'Guardar templates';
  });
}

function waDateKey(d) {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}

function waIsWorkingDay(d) {
  const KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const day  = (_waData.schedule || {})[KEYS[d.getDay()]];
  if (!day || !day.active || (!day.start1 && !day.start2)) return false;

  // Skip days fully covered by a blockout (no partial times on the boundary days)
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const fullDayBlocked = ((_waData.schedule || {}).blockouts || []).some(b =>
    iso >= b.startDate && iso <= b.endDate &&
    (iso > b.startDate || !b.startTime) &&
    (iso < b.endDate   || !b.endTime)
  );
  return !fullDayBlocked;
}

function waNextBusinessDay() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  for (let i = 1; i <= 14; i++) {
    d.setDate(d.getDate() + 1);
    if (waIsWorkingDay(d)) return new Date(d);
  }
  return null;
}

function waPhoneDigits(raw) {
  let p = (raw || '').replace(/[^\d+]/g, '');
  if (p.startsWith('+'))       p = p.slice(1);
  else if (p.startsWith('00')) p = p.slice(2);
  // 9-digit national number → assume Portugal
  if (/^[29]\d{8}$/.test(p)) p = '351' + p;
  return p;
}

function waFillTemplate(tpl, b) {
  const s = _waData.settings || {};
  return tpl
    .replaceAll('{nome}',     b.name  || '')
    .replaceAll('{hora}',     b.time  || '')
    .replaceAll('{data}',     b.date  || '')
    .replaceAll('{servico}',  b.service || '')
    .replaceAll('{duracao}',  b.serviceDuration ? `${b.serviceDuration} min` : '')
    .replaceAll('{negocio}',  s.businessName  || '')
    .replaceAll('{telefone}', s.businessPhone || '')
    .replaceAll('{morada}',   s.address       || '')
    .replaceAll('{email}',    s.businessEmail || '');
}

function waRenderList(el, bookings, tpl) {
  el.innerHTML = '';
  if (!bookings.length) {
    el.innerHTML = '<div class="wa-empty">Sem marcações.</div>';
    return;
  }
  bookings.slice().sort((a, b) => a.time.localeCompare(b.time)).forEach(b => {
    const item = document.createElement('div');
    item.className = 'wa-item';

    const digits = waPhoneDigits(b.phone);
    const btnHtml = digits
      ? `<a class="wa-send-btn" target="_blank" rel="noopener"
           href="https://wa.me/${digits}?text=${encodeURIComponent(waFillTemplate(tpl, b))}">
           <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
           Enviar</a>`
      : '<span class="wa-send-btn disabled">Sem telefone</span>';

    item.innerHTML = `
      <div class="wa-item-info">
        <div class="wa-item-time">${esc(b.time)}</div>
        <div class="wa-item-name">${esc(b.name)}</div>
        <div class="wa-item-svc">${esc(b.service || '—')}</div>
        ${b.phone ? `<div class="wa-item-phone">${esc(b.phone)}</div>` : ''}
      </div>
      ${btnHtml}
    `;
    el.appendChild(item);
  });
}

function renderWaPanel() {
  // Wait until bookings, schedule and settings are all loaded
  if (!_waData.bookings || !_waData.schedule || !_waData.settings) return;

  const stateEl = document.getElementById('waState');
  const colsEl  = document.querySelector('.wa-cols');
  if (!stateEl || !colsEl) return;
  stateEl.style.display = 'none';
  colsEl.style.display  = '';

  const tplToday = document.getElementById('waTplToday').value || WA_TPL_TODAY_DEFAULT;
  const tplNext  = document.getElementById('waTplNext').value  || WA_TPL_NEXT_DEFAULT;

  const today    = new Date();
  today.setHours(0, 0, 0, 0);
  const todayKey = waDateKey(today);
  const next     = waNextBusinessDay();
  const nextKey  = next ? waDateKey(next) : null;

  const DAY_NAMES = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
  document.getElementById('waTodayDate').textContent = `· ${todayKey}`;
  document.getElementById('waNextDate').textContent  = next
    ? `· ${DAY_NAMES[next.getDay()]}, ${nextKey}`
    : '· sem dias úteis configurados';

  const all = _waData.bookings;
  waRenderList(document.getElementById('waTodayList'), all.filter(b => b.date === todayKey), tplToday);
  waRenderList(document.getElementById('waNextList'),  nextKey ? all.filter(b => b.date === nextKey) : [], tplNext);
}

/* ── Schedule + Blockouts ───────────────────────────────── */
async function loadSchedule() {
  try {
    const res  = await fetch('/api/schedule');
    const data = await res.json();
    _waData.schedule = data;
    renderWaPanel();
    applyScheduleToGrid(data);
    renderBlockouts(data.blockouts || []);
  } catch {
    // use defaults already in DOM
  }

  document.querySelectorAll('.sched-row').forEach(row => {
    const toggle = row.querySelector('.sg-active');
    updateRowState(row, toggle.checked);
    toggle.addEventListener('change', () => updateRowState(row, toggle.checked));
  });

  document.getElementById('saveScheduleBtn')?.addEventListener('click', saveSchedule);
}

function applyScheduleToGrid(schedule) {
  document.querySelectorAll('.sched-row').forEach(row => {
    const day = row.dataset.day;
    const cfg = schedule[day];
    if (!cfg) return;
    row.querySelector('.sg-active').checked  = cfg.active;
    row.querySelector('.start1').value       = cfg.start1 || '';
    row.querySelector('.end1').value         = cfg.end1   || '';
    row.querySelector('.start2').value       = cfg.start2 || '';
    row.querySelector('.end2').value         = cfg.end2   || '';
    updateRowState(row, cfg.active);
  });
}

function updateRowState(row, active) {
  row.classList.toggle('sg-inactive', !active);
  row.querySelectorAll('.sg-t').forEach(i => i.disabled = !active);
}

async function saveSchedule() {
  const btn   = document.getElementById('saveScheduleBtn');
  const msgEl = document.getElementById('schedMsg');
  btn.disabled    = true;
  btn.textContent = 'A guardar…';
  msgEl.className = 'sf-msg';
  msgEl.textContent = '';

  const schedule = {};
  document.querySelectorAll('.sched-row').forEach(row => {
    schedule[row.dataset.day] = {
      active: row.querySelector('.sg-active').checked,
      start1: row.querySelector('.start1').value,
      end1:   row.querySelector('.end1').value,
      start2: row.querySelector('.start2').value,
      end2:   row.querySelector('.end2').value,
    };
  });

  try {
    const res = await apiFetch('/api/schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(schedule),
    });
    if (res.ok) {
      msgEl.className   = 'sf-msg ok';
      msgEl.textContent = 'Horário guardado com sucesso.';
    } else {
      throw new Error('Erro ' + res.status);
    }
  } catch (err) {
    msgEl.className   = 'sf-msg err';
    msgEl.textContent = 'Erro ao guardar: ' + err.message;
  }

  btn.disabled    = false;
  btn.textContent = 'Guardar horário';
}

/* ── Blockouts ──────────────────────────────────────────── */
function renderBlockouts(blockouts) {
  const el = document.getElementById('blockoutsList');
  if (!el) return;

  if (!blockouts.length) {
    el.innerHTML = '<p style="color:var(--text3);font-size:.88rem;margin:0">Nenhum período de indisponibilidade definido.</p>';
    return;
  }

  const MONTHS = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  const fmtDate = iso => {
    const [y, m, d] = iso.split('-');
    return `${d} ${MONTHS[+m - 1]} ${y}`;
  };

  el.innerHTML = '';
  blockouts.forEach(b => {
    const sameDay = b.startDate === b.endDate;
    let dateStr = sameDay
      ? fmtDate(b.startDate)
      : `${fmtDate(b.startDate)} — ${fmtDate(b.endDate)}`;
    let timeStr = '';
    if (b.startTime || b.endTime) {
      timeStr = ` · ${b.startTime || '00:00'} às ${b.endTime || 'fim do dia'}`;
    }

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 14px;background:var(--cream3);border:1.5px solid var(--border);border-radius:8px;margin-bottom:8px';
    row.innerHTML = `
      <div>
        ${b.label ? `<div style="font-size:.88rem;font-weight:600;color:var(--text);margin-bottom:2px">${esc(b.label)}</div>` : ''}
        <div style="font-size:.83rem;color:var(--text2)">${esc(dateStr)}${esc(timeStr)}</div>
      </div>
      <button type="button" class="btn-danger" data-id="${esc(b.id)}" style="padding:5px 12px;font-size:.8rem;flex-shrink:0">Remover</button>`;

    row.querySelector('button').addEventListener('click', () => deleteBlockout(b.id));
    el.appendChild(row);
  });
}

async function deleteBlockout(id) {
  try {
    const res = await apiFetch(`/api/schedule?blockouts=1&id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (res.ok) {
      const data = await (await fetch('/api/schedule')).json();
      renderBlockouts(data.blockouts || []);
    }
  } catch (err) {
    alert('Erro ao remover: ' + err.message);
  }
}

// Attach blockout form submit on DOMContentLoaded (called from loadSchedule init)
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('blockoutForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn   = document.getElementById('addBlockoutBtn');
    const msgEl = document.getElementById('boMsg');

    const startDate = document.getElementById('boStartDate').value;
    const endDate   = document.getElementById('boEndDate').value;
    if (!startDate || !endDate) {
      msgEl.className = 'sf-msg err'; msgEl.textContent = 'Datas obrigatórias.'; return;
    }
    if (startDate > endDate) {
      msgEl.className = 'sf-msg err'; msgEl.textContent = 'Data de início posterior à de fim.'; return;
    }

    btn.disabled = true; btn.textContent = 'A guardar…';
    msgEl.className = 'sf-msg'; msgEl.textContent = '';

    try {
      const res = await apiFetch('/api/schedule?blockouts=1', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label:     document.getElementById('boLabel').value.trim(),
          startDate,
          startTime: document.getElementById('boStartTime').value,
          endDate,
          endTime:   document.getElementById('boEndTime').value,
        }),
      });
      if (res.ok) {
        msgEl.className = 'sf-msg ok'; msgEl.textContent = 'Adicionado.';
        e.target.reset();
        const data = await (await fetch('/api/schedule')).json();
        renderBlockouts(data.blockouts || []);
      } else {
        const d = await res.json(); throw new Error(d.error || 'Erro ' + res.status);
      }
    } catch (err) {
      msgEl.className = 'sf-msg err'; msgEl.textContent = err.message;
    }
    btn.disabled = false; btn.textContent = '+ Adicionar período';
  });
});


/* ── Services ───────────────────────────────────────────── */
async function loadServices() {
  document.getElementById('addServiceBtn')?.addEventListener('click', () => addServiceRow());
  document.getElementById('saveServicesBtn')?.addEventListener('click', saveServices);

  try {
    const res = await apiFetch('/api/services');
    if (!res.ok) throw new Error();
    const { services } = await res.json();
    populateServices(services);
  } catch {
    populateServices([]);
  }
}

function populateServices(services) {
  const list = document.getElementById('servicesList');
  if (!list) return;
  list.innerHTML = '';
  if (services.length === 0) {
    addServiceRow();
  } else {
    services.forEach(svc => addServiceRow(svc));
  }
  syncRemoveButtons();
}

function addServiceRow(data = {}) {
  const list = document.getElementById('servicesList');
  if (!list) return;
  const row = document.createElement('div');
  row.className = 'svc-edit-row';
  row.dataset.id = data.id || '';
  row.innerHTML = `
    <input type="text"   class="svc-name"        placeholder="Nome *"          value="${esc(data.name        || '')}">
    <input type="number" class="svc-duration"     placeholder="Min *" min="1"   value="${esc(String(data.duration || ''))}">
    <input type="text"   class="svc-description"  placeholder="Descrição (aparece no site)" maxlength="240" value="${esc(data.description || '')}">
    <input type="text"   class="svc-price"        placeholder="ex: 50€"         value="${esc(data.price       || '')}">
    <button type="button" class="svc-remove" title="Remover linha">✕</button>
  `;
  row.querySelector('.svc-remove').addEventListener('click', () => {
    row.remove();
    syncRemoveButtons();
  });
  list.appendChild(row);
  syncRemoveButtons();
}

function syncRemoveButtons() {
  const rows = document.querySelectorAll('#servicesList .svc-edit-row');
  rows.forEach(r => {
    r.querySelector('.svc-remove').style.display = rows.length > 1 ? '' : 'none';
  });
}

async function saveServices() {
  const btn   = document.getElementById('saveServicesBtn');
  const msgEl = document.getElementById('servicesMsg');
  btn.disabled    = true;
  btn.textContent = 'A guardar…';
  msgEl.className = 'sf-msg';
  msgEl.textContent = '';

  const rows = document.querySelectorAll('#servicesList .svc-edit-row');
  const services = Array.from(rows).map(row => ({
    id:          row.dataset.id || '',
    name:        row.querySelector('.svc-name').value.trim(),
    duration:    row.querySelector('.svc-duration').value,
    description: row.querySelector('.svc-description').value.trim(),
    price:       row.querySelector('.svc-price').value.trim(),
  }));

  try {
    const res  = await apiFetch('/api/services', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ services }),
    });
    const data = await res.json();
    if (res.ok) {
      msgEl.className   = 'sf-msg ok';
      msgEl.textContent = 'Serviços guardados com sucesso.';
      const res2 = await apiFetch('/api/services');
      const { services: saved } = await res2.json();
      populateServices(saved);
    } else {
      throw new Error(data.error || 'Erro ' + res.status);
    }
  } catch (err) {
    msgEl.className   = 'sf-msg err';
    msgEl.textContent = err.message;
  }

  btn.disabled    = false;
  btn.textContent = 'Guardar serviços';
}

/* ── Google Calendar ────────────────────────────────────── */
async function loadCalendarStatus() {
  const dot            = document.getElementById('calDot');
  const label          = document.getElementById('calStatusLabel');
  const desc           = document.getElementById('calStatusDesc');
  const actionsEl      = document.getElementById('calActions');
  const credCard       = document.getElementById('calCredentialsCard');
  const redirectUriEl  = document.getElementById('redirectUriDisplay');

  try {
    const res = await apiFetch('/api/google/status');
    const { connected, hasCredentials, redirectUri } = await res.json();

    if (redirectUriEl) {
      redirectUriEl.textContent = redirectUri || `${location.protocol}//${location.host}/api/google/callback`;
    }

    if (!hasCredentials) {
      credCard.style.display = 'block';
      dot.className = 'cal-status-dot disconnected';
      label.textContent = 'Credenciais não configuradas';
      desc.textContent  = 'Configura primeiro as credenciais Google OAuth2 acima.';
      actionsEl.innerHTML = '';
      initCredentialsForm();
      return;
    }

    credCard.style.display = 'none';

    if (connected) {
      dot.className = 'cal-status-dot connected';
      label.textContent = 'Google Calendar ligado';
      desc.textContent  = 'As novas marcações serão adicionadas automaticamente ao teu calendário Google principal.';

      actionsEl.innerHTML = '';
      const disconnectBtn = document.createElement('button');
      disconnectBtn.className = 'btn-danger';
      disconnectBtn.textContent = 'Desligar Google Calendar';
      disconnectBtn.addEventListener('click', disconnectCalendar);
      actionsEl.appendChild(disconnectBtn);

      const testBtn = document.createElement('button');
      testBtn.className = 'btn-outline';
      testBtn.textContent = 'Testar ligação';
      testBtn.style.marginLeft = '8px';
      testBtn.addEventListener('click', async () => {
        testBtn.textContent = 'A testar…';
        testBtn.disabled = true;
        try {
          const r = await apiFetch('/api/google/test');
          const data = await r.json();
          if (data.ok) {
            const cals = data.calendars.map(c => c.summary).join(', ') || 'primary';
            desc.textContent = `✅ Ligação OK — calendários: ${cals}`;
          } else {
            desc.textContent = `❌ Falhou: ${data.error}${data.tokenInfo ? ` | refresh_token: ${data.tokenInfo.hasRefreshToken ? 'sim' : 'NÃO'}, expirado: ${data.tokenInfo.expired}` : ''}`;
          }
        } catch (e) {
          desc.textContent = `❌ Erro: ${e.message}`;
        }
        testBtn.textContent = 'Testar ligação';
        testBtn.disabled = false;
      });
      actionsEl.appendChild(testBtn);

      const reconfigBtn = document.createElement('button');
      reconfigBtn.className = 'btn-outline';
      reconfigBtn.textContent = 'Alterar credenciais';
      reconfigBtn.style.marginLeft = '8px';
      reconfigBtn.addEventListener('click', () => {
        credCard.style.display = 'block';
        initCredentialsForm();
      });
      actionsEl.appendChild(reconfigBtn);
    } else {
      dot.className = 'cal-status-dot disconnected';
      label.textContent = 'Google Calendar não ligado';
      desc.textContent  = 'Liga o teu Google Calendar para que as marcações sejam adicionadas automaticamente.';

      actionsEl.innerHTML = '';
      const connectBtn = document.createElement('a');
      connectBtn.href = '/api/google/auth';
      connectBtn.className = 'btn-gold';
      connectBtn.textContent = 'Ligar Google Calendar';
      actionsEl.appendChild(connectBtn);

      const reconfigBtn = document.createElement('button');
      reconfigBtn.className = 'btn-outline';
      reconfigBtn.textContent = 'Alterar credenciais';
      reconfigBtn.addEventListener('click', () => {
        credCard.style.display = 'block';
        initCredentialsForm();
      });
      actionsEl.appendChild(reconfigBtn);
    }
  } catch {
    label.textContent = 'Erro ao verificar estado';
  }
}

function initCredentialsForm() {
  const form   = document.getElementById('credentialsForm');
  const msgEl  = document.getElementById('credMsg');
  const btn    = document.getElementById('saveCredentialsBtn');

  if (form._bound) return;
  form._bound = true;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const clientId     = document.getElementById('gClientId').value.trim();
    const clientSecret = document.getElementById('gClientSecret').value.trim();

    if (!clientId || !clientSecret) {
      msgEl.className = 'sf-msg err';
      msgEl.textContent = 'Preenche ambos os campos.';
      return;
    }

    btn.disabled = true;
    btn.textContent = 'A guardar…';
    msgEl.className = 'sf-msg';
    msgEl.textContent = '';

    try {
      const res = await apiFetch('/api/google/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, clientSecret }),
      });

      if (res.ok) {
        msgEl.className = 'sf-msg ok';
        msgEl.textContent = 'Credenciais guardadas!';
        setTimeout(() => loadCalendarStatus(), 800);
      } else {
        const data = await res.json();
        throw new Error(data.error || 'Erro ' + res.status);
      }
    } catch (err) {
      msgEl.className = 'sf-msg err';
      msgEl.textContent = 'Erro: ' + err.message;
    }

    btn.disabled = false;
    btn.textContent = 'Guardar credenciais';
  });
}

async function disconnectCalendar() {
  if (!confirm('Tens a certeza que queres desligar o Google Calendar?')) return;
  try {
    const res = await apiFetch('/api/google/disconnect', { method: 'DELETE' });
    if (res.ok) await loadCalendarStatus();
  } catch (err) {
    alert('Erro: ' + err.message);
  }
}

/* ── Settings ───────────────────────────────────────────── */
async function loadSettings() {
  // Advanced settings toggle
  document.getElementById('advToggle')?.addEventListener('click', () => {
    const body    = document.getElementById('advBody');
    const chevron = document.getElementById('advChevron');
    const open = body.style.display === 'none';
    body.style.display = open ? '' : 'none';
    chevron.textContent = open ? '▾' : '▸';
  });

  try {
    const res      = await apiFetch('/api/settings');
    const { settings } = await res.json();

    document.getElementById('sBusinessName').value        = settings.businessName  || '';
    document.getElementById('sBusinessPhone').value       = settings.businessPhone || '';
    document.getElementById('sBusinessEmail').value       = settings.businessEmail || '';
    document.getElementById('sBookingEnabled').checked     = settings.bookingEnabled !== false;
    document.getElementById('sSlotStep').value            = settings.slotStep      || '';
    document.getElementById('sAddress').value             = settings.address       || '';
    document.getElementById('sEmail').value              = settings.notificationEmail || '';
    document.getElementById('sNotifyBookings').checked   = settings.notifyBookings;
    document.getElementById('sNotifyContact').checked    = settings.notifyContact;
    document.getElementById('sSocialFacebook').value     = settings.socialFacebook  || '';
    document.getElementById('sSocialInstagram').value    = settings.socialInstagram || '';
    document.getElementById('sSocialYoutube').value      = settings.socialYoutube   || '';
    document.getElementById('sSocialX').value            = settings.socialX         || '';

    _waData.settings = settings;
    const tplTodayEl = document.getElementById('waTplToday');
    const tplNextEl  = document.getElementById('waTplNext');
    if (tplTodayEl) tplTodayEl.value = settings.waTplToday || WA_TPL_TODAY_DEFAULT;
    if (tplNextEl)  tplNextEl.value  = settings.waTplNext  || WA_TPL_NEXT_DEFAULT;
    renderWaPanel();

    const resendStatus = document.getElementById('sResendKeyStatus');
    if (resendStatus) {
      resendStatus.textContent = settings.hasResendKey
        ? 'Chave configurada. Deixa em branco para manter a atual.'
        : 'Sem chave configurada — os emails não serão enviados.';
      resendStatus.style.color = settings.hasResendKey ? 'var(--text3)' : '#c0392b';
    }
  } catch {
    // silently ignore — defaults will be empty
  }

  document.getElementById('settingsForm')?.addEventListener('submit', saveSettings);

  document.getElementById('resetSetupBtn')?.addEventListener('click', async () => {
    if (!confirm('Tens a certeza? Esta ação apaga TODOS os dados e é irreversível.')) return;
    if (!confirm('Confirma novamente: todos os dados serão apagados permanentemente.')) return;
    try {
      const res = await apiFetch('/api/reset', { method: 'DELETE' });
      if (res.ok) {
        location.replace('/admin/setup');
      } else {
        alert('Erro ao fazer reset. Tenta novamente.');
      }
    } catch {
      alert('Erro de rede. Tenta novamente.');
    }
  });
}

async function saveSettings(e) {
  e.preventDefault();
  const btn   = document.getElementById('saveSettingsBtn');
  const msgEl = document.getElementById('sfMsg');

  btn.disabled    = true;
  btn.textContent = 'A guardar…';
  msgEl.className = 'sf-msg';
  msgEl.textContent = '';

  const resendKeyVal = document.getElementById('sResendKey').value.trim();

  const body = {
    businessName:      document.getElementById('sBusinessName').value.trim(),
    businessPhone:     document.getElementById('sBusinessPhone').value.trim(),
    businessEmail:     document.getElementById('sBusinessEmail').value.trim(),
    bookingEnabled:    document.getElementById('sBookingEnabled').checked,
    slotStep:          parseInt(document.getElementById('sSlotStep').value, 10) || 20,
    address:           document.getElementById('sAddress').value.trim(),
    notificationEmail: document.getElementById('sEmail').value.trim(),
    notifyBookings:    document.getElementById('sNotifyBookings').checked,
    notifyContact:     document.getElementById('sNotifyContact').checked,
    socialFacebook:    document.getElementById('sSocialFacebook').value.trim(),
    socialInstagram:   document.getElementById('sSocialInstagram').value.trim(),
    socialYoutube:     document.getElementById('sSocialYoutube').value.trim(),
    socialX:           document.getElementById('sSocialX').value.trim(),
  };

  if (resendKeyVal) body.resendApiKey = resendKeyVal;

  try {
    const res = await apiFetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      msgEl.className   = 'sf-msg ok';
      msgEl.textContent = 'Guardado com sucesso.';
      document.getElementById('sResendKey').value = '';
      _waData.settings = { ..._waData.settings, ...body };
      renderWaPanel();
      // Refresh the status label
      const res2 = await apiFetch('/api/settings');
      const { settings } = await res2.json();
      const resendStatus = document.getElementById('sResendKeyStatus');
      if (resendStatus) {
        resendStatus.textContent = settings.hasResendKey
          ? 'Chave configurada. Deixa em branco para manter a atual.'
          : 'Sem chave configurada — os emails não serão enviados.';
        resendStatus.style.color = settings.hasResendKey ? 'var(--text3)' : '#c0392b';
      }
    } else {
      throw new Error('Erro ' + res.status);
    }
  } catch (err) {
    msgEl.className   = 'sf-msg err';
    msgEl.textContent = 'Erro ao guardar: ' + err.message;
  }

  btn.disabled    = false;
  btn.textContent = 'Guardar alterações';
}

/* ── Change password ────────────────────────────────────── */
function initPasswordForm() {
  document.getElementById('pwdForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn    = document.getElementById('savePwdBtn');
    const msgEl  = document.getElementById('pwdMsg');

    const currentPassword = document.getElementById('pwdCurrent').value;
    const newPassword     = document.getElementById('pwdNew').value;
    const newPassword2    = document.getElementById('pwdNew2').value;

    msgEl.className = 'sf-msg';
    msgEl.textContent = '';

    if (newPassword !== newPassword2) {
      msgEl.className = 'sf-msg err';
      msgEl.textContent = 'As novas passwords não coincidem.';
      return;
    }
    if (newPassword.length < 8) {
      msgEl.className = 'sf-msg err';
      msgEl.textContent = 'A nova password deve ter pelo menos 8 caracteres.';
      return;
    }

    btn.disabled = true;
    btn.textContent = 'A alterar…';

    try {
      const res = await apiFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      });

      const data = await res.json();

      if (res.ok) {
        msgEl.className = 'sf-msg ok';
        msgEl.textContent = 'Password alterada com sucesso.';
        document.getElementById('pwdCurrent').value = '';
        document.getElementById('pwdNew').value = '';
        document.getElementById('pwdNew2').value = '';
      } else {
        throw new Error(data.error || 'Erro ' + res.status);
      }
    } catch (err) {
      msgEl.className = 'sf-msg err';
      msgEl.textContent = 'Erro: ' + err.message;
    }

    btn.disabled = false;
    btn.textContent = 'Alterar password';
  });
}

/* ── URL param toasts (from OAuth redirect) ─────────────── */
function handleURLParams() {
  const params = new URLSearchParams(location.search);
  const toast  = document.getElementById('calToast');
  if (!toast) return;

  if (params.get('success') === 'google_connected') {
    toast.className   = 'toast success';
    toast.textContent = 'Google Calendar ligado com sucesso!';
    document.querySelector('[data-tab="calendar"]')?.click();
  } else if (params.get('error') === 'google_denied') {
    toast.className   = 'toast error';
    toast.textContent = 'Autorização negada pelo Google.';
    document.querySelector('[data-tab="calendar"]')?.click();
  } else if (params.get('error')) {
    toast.className   = 'toast error';
    toast.textContent = 'Erro ao ligar o Google Calendar. Tenta novamente.';
    document.querySelector('[data-tab="calendar"]')?.click();
  }

  if (params.has('success') || params.has('error')) {
    history.replaceState({}, '', location.pathname);
  }
}

/* ── Edit booking modal ─────────────────────────────────── */
(function initEditModal() {
  const modal     = document.getElementById('editModal');
  const cancelBtn = document.getElementById('editCancelBtn');
  const saveBtn   = document.getElementById('editSaveBtn');
  const errEl     = document.getElementById('editErr');
  if (!modal) return;

  function close() { modal.style.display = 'none'; }

  cancelBtn.addEventListener('click', close);
  modal.addEventListener('click', e => { if (e.target === modal) close(); });

  document.addEventListener('click', e => {
    const btn = e.target.closest('.wg-edit-btn');
    if (!btn) return;
    const { id, date, time } = btn.dataset;
    document.getElementById('editId').value = id;
    // date is DD/MM/YYYY → convert to YYYY-MM-DD for input[type=date]
    const [dd, mm, yyyy] = date.split('/');
    document.getElementById('editDate').value = `${yyyy}-${mm}-${dd}`;
    document.getElementById('editTime').value = time;
    errEl.style.display = 'none';
    errEl.textContent = '';
    modal.style.display = 'flex';
  });

  saveBtn.addEventListener('click', async () => {
    const id   = document.getElementById('editId').value;
    const dateVal = document.getElementById('editDate').value;
    const timeVal = document.getElementById('editTime').value;
    if (!dateVal || !timeVal) {
      errEl.textContent = 'Por favor preencha data e hora.';
      errEl.style.display = 'block';
      return;
    }
    // Convert YYYY-MM-DD → DD/MM/YYYY
    const [y, m, d] = dateVal.split('-');
    const datePt = `${d}/${m}/${y}`;

    saveBtn.disabled = true;
    saveBtn.textContent = 'A guardar…';
    errEl.style.display = 'none';

    try {
      const res = await apiFetch('/api/bookings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, date: datePt, time: timeVal }),
      });
      const data = await res.json();
      if (res.ok) {
        close();
        await fetchBookings();
      } else {
        errEl.textContent = data.error || 'Erro ao guardar.';
        errEl.style.display = 'block';
      }
    } catch {
      errEl.textContent = 'Erro de rede. Tenta novamente.';
      errEl.style.display = 'block';
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Guardar';
    }
  });
})();

/* ── Google Calendar instructions toggle ───────────────── */
function initGcalInstructions() {
  const btn     = document.getElementById('gcalInstrToggle');
  const body    = document.getElementById('gcalInstrBody');
  const chevron = document.getElementById('gcalInstrChevron');
  if (!btn || !body) return;

  btn.addEventListener('click', () => {
    const open = body.style.display !== 'none';
    body.style.display    = open ? 'none' : 'block';
    chevron.style.transform = open ? '' : 'rotate(90deg)';
  });
}

/* ── Helpers ────────────────────────────────────────────── */
function apiFetch(url, opts = {}) {
  return fetch(url, { credentials: 'include', ...opts });
}

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
