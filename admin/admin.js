/* ═══════════════════════════════════════════════════════
   Intemporal Barbearia — admin.js (dashboard)
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
      if (id === 'bookings') _agenda.calendar?.updateSize();
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

/* ── Agenda (bookings calendar) ─────────────────────────── */
const _agenda = { calendar: null, bookings: [], services: [], schedule: null, settings: null };

const pad2 = n => String(n).padStart(2, '0');
const ptDate   = d => `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;   // Date → DD/MM/YYYY
const isoDate  = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;   // Date → YYYY-MM-DD
const hhmm     = d => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const ptToIso  = s => { const [d, m, y] = s.split('/'); return `${y}-${m}-${d}`; };
const isoToPt  = s => { const [y, m, d] = s.split('-'); return `${d}/${m}/${y}`; };
const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const prettyDate = (datePt, time) => {
  const [d, m, y] = datePt.split('/').map(Number);
  return `${WEEKDAYS[new Date(y, m - 1, d).getDay()]} ${datePt.slice(0, 5)} às ${time}`;
};

// Fallback colour when a service has none (stable per service name)
function serviceColor(b) {
  const svc = _agenda.services.find(s => s.id === b.serviceId);
  if (svc && svc.color) return svc.color;
  const key = b.serviceId || b.service || '';
  let hash = 0;
  for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return SVC_PALETTE[hash % SVC_PALETTE.length];
}

function textColorFor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.62 ? '#1a1612' : '#ffffff';
}

function bookingToEvent(b) {
  const start = new Date(`${ptToIso(b.date)}T${b.time}:00`);
  const end   = new Date(start.getTime() + (Number(b.serviceDuration) || 30) * 60000);
  const color = serviceColor(b);
  return {
    id: b.id, start, end,
    title: b.name,
    backgroundColor: color, borderColor: color, textColor: textColorFor(color),
    extendedProps: { booking: b },
  };
}

function blockoutToEvent(bo) {
  const start = new Date(`${bo.startDate}T${bo.startTime || '00:00'}:00`);
  const end   = bo.endTime ? new Date(`${bo.endDate}T${bo.endTime}:00`)
                           : new Date(new Date(`${bo.endDate}T00:00:00`).getTime() + 86400000);
  return { start, end, display: 'background', classNames: ['agenda-blockout'], title: bo.label || 'Indisponível' };
}

function businessHoursFrom(schedule) {
  const DOW = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const out = [];
  Object.entries(DOW).forEach(([key, dow]) => {
    const d = (schedule || {})[key];
    if (!d || !d.active) return;
    [[d.start1, d.end1], [d.start2, d.end2]].forEach(([s, e]) => {
      if (s && e && e > s) out.push({ daysOfWeek: [dow], startTime: s, endTime: e });
    });
  });
  return out.length ? out : false;
}

// Visible hours: at least 07:00–22:00, widened to fit the schedule
function visibleRange(schedule) {
  let min = 7 * 60, max = 22 * 60;
  Object.values(schedule || {}).forEach(d => {
    if (!d || !d.active) return;
    [d.start1, d.start2].forEach(t => { if (t) { const [h, m] = t.split(':').map(Number); min = Math.min(min, h * 60 + m - 60); } });
    [d.end1, d.end2].forEach(t => { if (t) { const [h, m] = t.split(':').map(Number); max = Math.max(max, h * 60 + m + 60); } });
  });
  min = Math.max(0, Math.floor(min / 60) * 60);
  max = Math.min(24 * 60, Math.ceil(max / 60) * 60);
  const t = m => `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}:00`;
  return { slotMinTime: t(min), slotMaxTime: t(max) };
}

function initAgenda() {
  const el = document.getElementById('agenda');
  if (!el || typeof FullCalendar === 'undefined') return;
  const narrow = window.innerWidth < 760;

  _agenda.calendar = new FullCalendar.Calendar(el, {
    locale: 'pt',
    initialView: narrow ? 'timeGridDay' : 'timeGridWeek',
    headerToolbar: narrow
      ? { left: 'prev,next', center: 'title', right: 'today' }
      : { left: 'prev,next today', center: 'title', right: 'timeGridDay,timeGridWeek,dayGridMonth' },
    footerToolbar: narrow ? { center: 'timeGridDay,timeGridWeek,dayGridMonth' } : false,
    firstDay: 1,
    allDaySlot: false,
    slotDuration: '00:15:00',
    slotLabelInterval: '01:00',
    snapDuration: '00:05:00',
    slotLabelFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
    eventTimeFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
    dayHeaderFormat: narrow ? { weekday: 'short', day: 'numeric' } : { weekday: 'short', day: 'numeric', month: 'numeric' },
    height: Math.max(560, window.innerHeight - 250),
    nowIndicator: true,
    scrollTime: `${pad2(Math.max(0, new Date().getHours() - 1))}:00:00`,
    editable: true,
    eventDurationEditable: false,
    eventOverlap: true,
    dayMaxEvents: 4,
    ...visibleRange(null),
    events: (info, success) => {
      const events = _agenda.bookings.map(bookingToEvent);
      ((_agenda.schedule || {}).blockouts || []).forEach(bo => events.push(blockoutToEvent(bo)));
      success(events);
    },
    eventContent: arg => {
      const b = arg.event.extendedProps.booking;
      if (!b) return { html: `<div class="agenda-bo-label">${esc(arg.event.title)}</div>` };
      const dur = Number(b.serviceDuration) || 30;
      if (arg.view.type === 'dayGridMonth') {
        return { html: `<div class="agenda-ev-month"><b>${esc(b.time)}</b> ${esc(b.name)}</div>` };
      }
      return { html: `
        <div class="agenda-ev">
          <div class="agenda-ev-name">${esc(b.name)}</div>
          <div class="agenda-ev-time">${esc(b.time)} (${dur}min)</div>
          <div class="agenda-ev-svc">${esc(b.service || '')}</div>
        </div>` };
    },
    eventDidMount: arg => {
      const b = arg.event.extendedProps.booking;
      if (b) arg.el.title = `${b.name} · ${b.time} · ${b.service || ''}${b.phone ? ' · ' + b.phone : ''}`;
    },
    dateClick: info => {
      if (info.view.type === 'dayGridMonth') {
        _agenda.calendar.changeView('timeGridDay', info.date);
        return;
      }
      openBookingModal({ date: info.date });
    },
    eventClick: info => {
      const b = info.event.extendedProps.booking;
      if (b) openBookingModal({ booking: b });
    },
    eventDrop: info => handleEventDrop(info),
  });
  _agenda.calendar.render();

  document.getElementById('newBookingBtn')?.addEventListener('click', () => {
    const d = new Date();
    d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0);
    openBookingModal({ date: d });
  });
  initBookingModal();
  initDialog();
}

function applyScheduleToAgenda() {
  const cal = _agenda.calendar;
  if (!cal || !_agenda.schedule) return;
  cal.setOption('businessHours', businessHoursFrom(_agenda.schedule));
  const { slotMinTime, slotMaxTime } = visibleRange(_agenda.schedule);
  cal.setOption('slotMinTime', slotMinTime);
  cal.setOption('slotMaxTime', slotMaxTime);
  cal.refetchEvents();
}

function renderAgendaLegend() {
  const el = document.getElementById('agendaLegend');
  if (!el) return;
  el.innerHTML = _agenda.services.map(s =>
    `<span class="agenda-legend-item"><i style="background:${esc(s.color || serviceColor({ serviceId: s.id, service: s.name }))}"></i>${esc(s.name)}</span>`
  ).join('');
}

async function loadBookings() {
  document.getElementById('refreshBtn')?.addEventListener('click', fetchBookings);
  initAgenda();
  await fetchBookings();
}

async function fetchBookings() {
  const stateEl = document.getElementById('bookingsState');
  try {
    const res = await apiFetch('/api/bookings');
    if (!res.ok) throw new Error('Erro ' + res.status);
    const { bookings } = await res.json();
    _agenda.bookings = bookings || [];
    _waData.bookings = _agenda.bookings;
    stateEl.style.display = 'none';
    renderWaPanel();
    _agenda.calendar?.refetchEvents();
  } catch (err) {
    stateEl.textContent = 'Erro ao carregar marcações: ' + err.message;
    stateEl.style.display = 'block';
  }
}

/* ── Generic dialog ─────────────────────────────────────── */
let _dialogResolve = null;

function initDialog() {
  const dlg = document.getElementById('dialog');
  dlg.addEventListener('click', e => { if (e.target === dlg) closeDialog(null); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !dlg.hidden) closeDialog(null); });
}

function closeDialog(value) {
  document.getElementById('dialog').hidden = true;
  const r = _dialogResolve;
  _dialogResolve = null;
  if (r) r(value);
}

/** Shows a dialog and resolves with the value of the clicked button (null when dismissed). */
function askDialog({ title, html, buttons }) {
  if (_dialogResolve) closeDialog(null);
  document.getElementById('dlgTitle').textContent = title;
  document.getElementById('dlgBody').innerHTML = html || '';
  const wrap = document.getElementById('dlgButtons');
  wrap.innerHTML = '';
  buttons.forEach(b => {
    const el = document.createElement(b.href ? 'a' : 'button');
    el.className = b.cls || 'btn-outline';
    el.textContent = b.label;
    if (b.href) { el.href = b.href; el.target = '_blank'; el.rel = 'noopener'; }
    else el.type = 'button';
    el.addEventListener('click', () => closeDialog(b.value ?? null));
    wrap.appendChild(el);
  });
  document.getElementById('dialog').hidden = false;
  return new Promise(resolve => { _dialogResolve = resolve; });
}

/* ── Saving with overlap confirmation ───────────────────── */
async function sendBooking(method, payload) {
  let body = { ...payload };
  for (;;) {
    const res = await apiFetch('/api/bookings', {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return data;
    if (res.status === 409 && data.conflict && !body.force) {
      const go = await askDialog({
        title: 'Horário ocupado',
        html: `<p>Esta marcação sobrepõe-se à de <strong>${esc(data.conflict.name)}</strong> às <strong>${esc(data.conflict.time)}</strong>.</p><p>Queres guardar mesmo assim?</p>`,
        buttons: [{ label: 'Cancelar' }, { label: 'Guardar mesmo assim', value: true, cls: 'btn-gold' }],
      });
      if (!go) return null;
      body = { ...body, force: true };
      continue;
    }
    throw new Error(data.error || `Erro ${res.status}`);
  }
}

/* ── Move notification ──────────────────────────────────── */
// Asks whether the client should be told about a new date/time. Resolves 'notify' | 'silent' | null (cancel).
function askMoveNotify(b, newDate, newTime) {
  const hasContact = b.email || b.phone;
  const change = `<p class="dlg-change"><span>${esc(prettyDate(b.date, b.time))}</span> → <strong>${esc(prettyDate(newDate, newTime))}</strong></p>`;
  if (!hasContact) {
    return askDialog({
      title: `Mover marcação de ${b.name}?`,
      html: change + '<p class="dlg-hint">Este cliente não tem email nem telemóvel, por isso não pode ser avisado.</p>',
      buttons: [{ label: 'Cancelar' }, { label: 'Mover', value: 'silent', cls: 'btn-gold' }],
    });
  }
  const how = [b.email ? `email para <strong>${esc(b.email)}</strong>` : null, b.phone ? 'opção de enviar WhatsApp' : null].filter(Boolean).join(' e ');
  return askDialog({
    title: `Mover marcação de ${b.name}?`,
    html: change + `<p>Queres avisar o cliente da alteração?</p><p class="dlg-hint">Se sim: ${how}.</p>`,
    buttons: [
      { label: 'Cancelar' },
      { label: 'Mover sem avisar', value: 'silent' },
      { label: 'Mover e avisar', value: 'notify', cls: 'btn-gold' },
    ],
  });
}

function waChangeLink(b, previous) {
  const digits = waPhoneDigits(b.phone);
  if (!digits) return null;
  const tpl = document.getElementById('waTplChange')?.value || WA_TPL_CHANGE_DEFAULT;
  const text = waFillTemplate(tpl, b)
    .replaceAll('{data_antiga}', previous?.date || '')
    .replaceAll('{hora_antiga}', previous?.time || '');
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

async function showNotifyResult(result) {
  const b = result.booking;
  const lines = [];
  if (b.email) {
    lines.push(result.emailSent
      ? `<p>✓ Email de alteração enviado para <strong>${esc(b.email)}</strong>.</p>`
      : `<p class="dlg-warn">Não foi possível enviar o email (confirma a configuração do Resend).</p>`);
  }
  const wa = waChangeLink(b, result.previous);
  if (wa) lines.push('<p>Envia também o aviso por WhatsApp:</p>');
  if (!lines.length) return;
  await askDialog({
    title: 'Cliente avisado',
    html: lines.join(''),
    buttons: [
      ...(wa ? [{ label: 'Enviar WhatsApp', href: wa, cls: 'btn-wa' }] : []),
      { label: 'Fechar', cls: wa ? 'btn-outline' : 'btn-gold' },
    ],
  });
}

async function handleEventDrop(info) {
  const b = info.event.extendedProps.booking;
  const newDate = ptDate(info.event.start);
  const newTime = hhmm(info.event.start);
  const choice = await askMoveNotify(b, newDate, newTime);
  if (!choice) { info.revert(); return; }
  try {
    const result = await sendBooking('PUT', { id: b.id, date: newDate, time: newTime, notify: choice === 'notify' });
    if (!result) { info.revert(); return; }
    await fetchBookings();
    if (choice === 'notify') await showNotifyResult(result);
  } catch (err) {
    info.revert();
    await askDialog({ title: 'Erro', html: `<p>${esc(err.message)}</p>`, buttons: [{ label: 'Fechar', cls: 'btn-gold' }] });
  }
}

/* ── Booking modal (create / edit) ──────────────────────── */
function fillServiceSelect(selectedId) {
  const sel = document.getElementById('bmService');
  const opts = _agenda.services.map(s =>
    `<option value="${esc(s.id)}"${s.id === selectedId ? ' selected' : ''}>${esc(s.name)} · ${Number(s.duration) || 30} min${s.price ? ' · ' + esc(s.price) : ''}</option>`);
  if (!_agenda.services.length) opts.unshift('<option value="">Serviço padrão</option>');
  else if (!selectedId) opts.unshift('<option value="" selected disabled>Escolhe o serviço…</option>');
  sel.innerHTML = opts.join('');
}

function openBookingModal({ booking, date }) {
  const modal = document.getElementById('bookingModal');
  const isEdit = Boolean(booking);
  const b = booking || {};
  const d = date || new Date();

  document.getElementById('bmTitle').textContent = isEdit ? 'Editar marcação' : 'Nova marcação';
  document.getElementById('bmId').value = b.id || '';
  fillServiceSelect(b.serviceId || '');
  document.getElementById('bmName').value    = b.name    || '';
  document.getElementById('bmPhone').value   = b.phone   || '';
  document.getElementById('bmEmail').value   = b.email   || '';
  document.getElementById('bmMessage').value = b.message || '';
  document.getElementById('bmDate').value    = isEdit ? ptToIso(b.date) : isoDate(d);
  document.getElementById('bmTime').value    = isEdit ? b.time : hhmm(d);
  document.getElementById('bmSendEmail').checked = false;
  document.getElementById('bmSendEmailWrap').hidden = isEdit;
  document.getElementById('bmDelete').hidden = !isEdit;

  const meta = document.getElementById('bmMeta');
  meta.textContent = isEdit
    ? `${b.source === 'admin' ? 'Criada no backoffice' : 'Marcação online'}${b.createdAt ? ' · ' + new Date(b.createdAt).toLocaleString('pt-PT', { dateStyle: 'short', timeStyle: 'short' }) : ''}`
    : 'Só o nome e o serviço são obrigatórios — os contactos são opcionais.';

  const wa = document.getElementById('bmWhatsapp');
  const digits = isEdit ? waPhoneDigits(b.phone) : '';
  wa.hidden = !digits;
  if (digits) wa.href = `https://wa.me/${digits}`;

  const err = document.getElementById('bmErr');
  err.hidden = true;
  modal.hidden = false;
  setTimeout(() => document.getElementById(isEdit ? 'bmName' : (_agenda.services.length ? 'bmService' : 'bmName')).focus(), 30);
}

function closeBookingModal() { document.getElementById('bookingModal').hidden = true; }

function initBookingModal() {
  const modal = document.getElementById('bookingModal');
  const form  = document.getElementById('bookingModalForm');
  const err   = document.getElementById('bmErr');
  const showErr = msg => { err.textContent = msg; err.hidden = false; };

  modal.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeBookingModal));
  modal.addEventListener('mousedown', e => { if (e.target === modal) closeBookingModal(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !modal.hidden && document.getElementById('dialog').hidden) closeBookingModal();
  });
  // The email confirmation checkbox only makes sense with an email
  document.getElementById('bmEmail').addEventListener('input', e => {
    const box = document.getElementById('bmSendEmail');
    if (!e.target.value.trim()) box.checked = false;
  });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    err.hidden = true;
    const id = document.getElementById('bmId').value;
    const payload = {
      serviceId: document.getElementById('bmService').value,
      name:      document.getElementById('bmName').value.trim(),
      phone:     document.getElementById('bmPhone').value.trim(),
      email:     document.getElementById('bmEmail').value.trim(),
      message:   document.getElementById('bmMessage').value.trim(),
      date:      document.getElementById('bmDate').value ? isoToPt(document.getElementById('bmDate').value) : '',
      time:      document.getElementById('bmTime').value,
    };
    if (_agenda.services.length && !payload.serviceId) return showErr('Escolhe o serviço.');
    if (!payload.name) return showErr('Indica o nome do cliente.');
    if (!payload.date || !payload.time) return showErr('Indica a data e a hora.');
    if (payload.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) return showErr('Email inválido.');

    const saveBtn = document.getElementById('bmSave');
    saveBtn.disabled = true;
    try {
      if (!id) {
        const sendEmail = document.getElementById('bmSendEmail').checked && Boolean(payload.email);
        const result = await sendBooking('POST', { ...payload, admin: true, sendEmail });
        if (!result) return;
        closeBookingModal();
        await fetchBookings();
        return;
      }

      // Edit: ask about notifying the client when the date/time changes
      const original = _agenda.bookings.find(b => b.id === id);
      const moved = original && (original.date !== payload.date || original.time !== payload.time);
      let notify = false;
      if (moved) {
        const merged = { ...original, ...payload };
        const choice = await askMoveNotify(merged, payload.date, payload.time);
        if (!choice) return;
        notify = choice === 'notify';
      }
      const result = await sendBooking('PUT', { id, ...payload, notify });
      if (!result) return;
      closeBookingModal();
      await fetchBookings();
      if (notify) await showNotifyResult(result);
    } catch (ex) {
      showErr(ex.message);
    } finally {
      saveBtn.disabled = false;
    }
  });

  document.getElementById('bmDelete').addEventListener('click', async () => {
    const id = document.getElementById('bmId').value;
    const b = _agenda.bookings.find(x => x.id === id);
    const ok = await askDialog({
      title: 'Eliminar marcação?',
      html: `<p>${esc(b ? `${b.name} — ${prettyDate(b.date, b.time)}` : '')}</p><p class="dlg-hint">Esta ação não pode ser desfeita. O cliente não é avisado automaticamente.</p>`,
      buttons: [{ label: 'Cancelar' }, { label: 'Eliminar', value: true, cls: 'btn-danger' }],
    });
    if (!ok) return;
    try {
      const res = await apiFetch(`/api/bookings?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Erro ${res.status}`);
      closeBookingModal();
      await fetchBookings();
    } catch (ex) {
      showErr(ex.message);
    }
  });
}

/* ── WhatsApp reminders panel ───────────────────────────── */
const WA_TPL_TODAY_DEFAULT = 'Olá {nome}! 👋 Lembramos a sua marcação de hoje às {hora} — {servico} — em {negocio}, {morada}. Até já!';
const WA_TPL_CHANGE_DEFAULT = 'Olá {nome}! ⚠️ A sua marcação de {servico} em {negocio} foi alterada: {data_antiga} às {hora_antiga} → {data} às {hora}. Se não lhe for conveniente, responda a esta mensagem ou contacte-nos: {telefone}. Obrigado!';
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
          waTplChange: document.getElementById('waTplChange').value,
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
    .replaceAll('{negocio}',  s.businessName  || 'Intemporal Barbearia')
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
    _agenda.schedule = data;
    applyScheduleToAgenda();
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
  // The agenda uses the services for colours, the legend and the booking form
  _agenda.services = services || [];
  renderAgendaLegend();
  _agenda.calendar?.refetchEvents();

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

// Default colours offered to new services (agenda only)
const SVC_PALETTE = ['#e5484d', '#3e63dd', '#30a46c', '#f5a524', '#8e4ec6', '#12a594', '#d6409f', '#6e56cf', '#978365', '#0090ff'];

function addServiceRow(data = {}) {
  const list = document.getElementById('servicesList');
  if (!list) return;
  const row = document.createElement('div');
  row.className = 'svc-edit-row';
  row.dataset.id = data.id || '';
  const color = data.color || SVC_PALETTE[list.children.length % SVC_PALETTE.length];
  row.innerHTML = `
    <input type="color"  class="svc-color" value="${esc(color)}" title="Cor na agenda">
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
    color:       row.querySelector('.svc-color').value,
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
    const tplChangeEl = document.getElementById('waTplChange');
    if (tplChangeEl) tplChangeEl.value = settings.waTplChange || WA_TPL_CHANGE_DEFAULT;
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
