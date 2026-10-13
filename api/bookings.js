const { requireAdmin } = require('../lib/auth');
const { getAuthorizedClient, createCalendarEvent, updateCalendarEventTime, deleteCalendarEvent } = require('../lib/google');
const { kv } = require('../lib/kv');
const { Resend } = require('resend');
const SlotLogic = require('../assets/js/slots.js');

// Sender address: must belong to a domain verified in your Resend account
const EMAIL_FROM = process.env.EMAIL_FROM || 'noreply@slotbook.cc';

// Returns "YYYY-MM-DDTHH:MM:00" — no timezone offset, so Google Calendar
// applies timeZone:'Europe/Lisbon' correctly instead of ignoring it.
function toLocalISO(date, time) {
  const [day, month, year] = date.split('/').map(Number);
  const [hour, min]        = time.split(':').map(Number);
  return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}T${String(hour).padStart(2,'0')}:${String(min).padStart(2,'0')}:00`;
}

function addMinutes(localISO, minutes) {
  const [datePart, timePart] = localISO.split('T');
  const [y, mo, d]  = datePart.split('-').map(Number);
  const [h, mi]     = timePart.split(':').map(Number);
  const ms = Date.UTC(y, mo - 1, d, h, mi) + minutes * 60000;
  const dt = new Date(ms);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth()+1).padStart(2,'0')}-${String(dt.getUTCDate()).padStart(2,'0')}T${String(dt.getUTCHours()).padStart(2,'0')}:${String(dt.getUTCMinutes()).padStart(2,'0')}:00`;
}

// Convert Lisbon local ISO ("YYYY-MM-DDTHH:MM:00") to UTC ICS format ("YYYYMMDDTHHMMSSz")
function toICSDate(localISO) {
  const y  = +localISO.slice(0, 4), mo = +localISO.slice(5, 7), d  = +localISO.slice(8, 10);
  const h  = +localISO.slice(11, 13), mi = +localISO.slice(14, 16);
  // Portugal: UTC+0 winter, UTC+1 summer (last Sunday of March → last Sunday of October)
  const lastSunMar = new Date(Date.UTC(y, 2, 31)); lastSunMar.setUTCDate(31 - lastSunMar.getUTCDay());
  const lastSunOct = new Date(Date.UTC(y, 9, 31)); lastSunOct.setUTCDate(31 - lastSunOct.getUTCDay());
  const offsetH = (new Date(Date.UTC(y, mo - 1, d)) >= lastSunMar &&
                   new Date(Date.UTC(y, mo - 1, d)) <  lastSunOct) ? 1 : 0;
  const utc = new Date(Date.UTC(y, mo - 1, d, h - offsetH, mi));
  const p = n => String(n).padStart(2, '0');
  return `${utc.getUTCFullYear()}${p(utc.getUTCMonth()+1)}${p(utc.getUTCDate())}T${p(utc.getUTCHours())}${p(utc.getUTCMinutes())}00Z`;
}

function generateICS({ uid, title, description, location, startLocal, endLocal, organizerName, organizerEmail, attendeeName, attendeeEmail }) {
  const dtStart = toICSDate(startLocal);
  const dtEnd   = toICSDate(endLocal);
  const stamp   = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
  const desc    = description.replace(/[\\,;]/g, s => '\\' + s).replace(/\n/g, '\\n');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:-//${organizerName || 'SlotBook'}//EN`,
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${dtStart}`,
    `DTEND:${dtEnd}`,
    `SUMMARY:${title}`,
    `DESCRIPTION:${desc}`,
  ];
  if (location) lines.push(`LOCATION:${location.replace(/[\\,;]/g, s => '\\' + s)}`);
  lines.push(
    `ORGANIZER;CN=${organizerName || 'SlotBook'}:mailto:${organizerEmail}`,
    `ATTENDEE;CN=${attendeeName};RSVP=TRUE;PARTSTAT=NEEDS-ACTION;ROLE=REQ-PARTICIPANT:mailto:${attendeeEmail}`,
    'STATUS:CONFIRMED',
    'END:VEVENT',
    'END:VCALENDAR',
  );
  return lines.join('\r\n');
}

function googleCalendarUrl(title, startLocal, endLocal, description, location) {
  const s = toICSDate(startLocal), e = toICSDate(endLocal);
  let url = 'https://calendar.google.com/calendar/render?action=TEMPLATE' +
    `&text=${encodeURIComponent(title)}` +
    `&dates=${s}/${e}` +
    `&details=${encodeURIComponent(description)}`;
  if (location) url += `&location=${encodeURIComponent(location)}`;
  return url;
}

function outlookCalendarUrl(title, startLocal, endLocal, description, location) {
  const fmt = ics => `${ics.slice(0,4)}-${ics.slice(4,6)}-${ics.slice(6,11)}:${ics.slice(11,13)}:${ics.slice(13,15)}:00`;
  let url = 'https://outlook.live.com/calendar/0/deeplink/compose?path=/calendar/action/compose&rru=addevent' +
    `&subject=${encodeURIComponent(title)}` +
    `&startdt=${fmt(toICSDate(startLocal))}` +
    `&enddt=${fmt(toICSDate(endLocal))}` +
    `&body=${encodeURIComponent(description)}`;
  if (location) url += `&location=${encodeURIComponent(location)}`;
  return url;
}


/* ── Storage ──────────────────────────────────────────────
   Bookings live in one KV list, newest first. Past bookings older
   than the retention period are dropped whenever the list is rewritten
   (the privacy policy promises a maximum of 12 months). */
const MAX_BOOKINGS   = 2000;
const RETENTION_DAYS = 365;

const parseList = raw => (raw || []).map(b => (typeof b === 'string' ? JSON.parse(b) : b));

async function readBookings() {
  return parseList(await kv.lrange('bookings', 0, MAX_BOOKINGS - 1));
}

async function writeBookings(bookings) {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000).toISOString().slice(0, 10);
  const kept = bookings.filter(b => SlotLogic.ptToISO(b.date) >= cutoff).slice(0, MAX_BOOKINGS);
  const pipe = kv.pipeline();
  pipe.del('bookings');
  // lpush puts its last argument at the head → pass oldest first so the newest stays at index 0
  if (kept.length) pipe.lpush('bookings', ...kept.slice().reverse().map(b => JSON.stringify(b)));
  await pipe.exec();
}

/* ── Helpers ──────────────────────────────────────────── */
// Escape user-provided text before putting it in email HTML
const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clean = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const isEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const isDatePt = v => /^\d{2}\/\d{2}\/\d{4}$/.test(v || '');
const isTime = v => /^\d{2}:\d{2}$/.test(v || '');

function findConflict(bookings, { date, time, duration, defaultDur, excludeId }) {
  const start = SlotLogic.toMin(time);
  const end   = start + duration;
  const seg = SlotLogic.bookedSegmentsFor(bookings, date, defaultDur, excludeId)
    .find(s => s.start < end && s.end > start);
  return seg ? bookings.find(b => b.id === seg.id) : null;
}

function resolveService(services, serviceId, settings) {
  const svc = (services || []).find(s => s.id === serviceId);
  if (svc) {
    return { id: svc.id, label: svc.name, duration: Number(svc.duration) || 30, description: svc.description || '', price: svc.price || '' };
  }
  const duration = Number(settings.duration) || 30;
  return { id: '', label: settings.serviceName || `Marcação · ${duration} min`, duration, description: '', price: '' };
}

function businessInfo(settings) {
  return {
    businessName:  settings.businessName  || 'Intemporal Barbearia',
    address:       settings.address       || '',
    businessPhone: settings.businessPhone || '',
    businessEmail: settings.businessEmail || '',
  };
}

const emailFooter = `
  <hr style="border:none;border-top:1px solid #eee;margin:28px 0 10px">
  <p style="font-size:.72rem;color:#bbb;text-align:center;margin:0">
    Serviço prestado por <a href="https://www.slotbook.cc" style="color:#B30000;text-decoration:none">SlotBook</a>
  </p>`;

function calendarButtons(googleUrl, outlookUrl) {
  return `
    <div style="margin-top:24px;padding:16px;background:#f9f5ee;border-radius:8px">
      <p style="margin:0 0 12px;color:#666;font-size:.88rem">Adiciona ao teu calendário:</p>
      <a href="${googleUrl}" style="display:inline-block;margin-right:8px;margin-bottom:8px;padding:9px 16px;background:#4285F4;color:#fff;text-decoration:none;border-radius:6px;font-size:.85rem;font-weight:500">📅 Google Calendar</a>
      <a href="${outlookUrl}" style="display:inline-block;margin-bottom:8px;padding:9px 16px;background:#0078D4;color:#fff;text-decoration:none;border-radius:6px;font-size:.85rem;font-weight:500">📅 Outlook</a>
      <p style="margin:8px 0 0;color:#999;font-size:.78rem">O ficheiro <strong>convite.ics</strong> em anexo também funciona em qualquer aplicação de calendário (iOS, Android, etc.).</p>
    </div>`;
}

function locationBlock(address, label = 'Local do encontro') {
  if (!address) return '';
  return `<div style="margin-top:16px;padding:14px 18px;background:#f9f5ee;border-radius:8px;border-left:3px solid #B30000">
      <p style="margin:0;font-size:.88rem;color:#666">📍 <strong style="color:#333">${label}:</strong></p>
      <p style="margin:6px 0 0;font-weight:600;color:#1A1612">${h(address)}</p>
    </div>`;
}

function calendarAttachment({ booking, settings, info, uidSuffix = '' }) {
  const startLocal = toLocalISO(booking.date, booking.time);
  const endLocal   = addMinutes(startLocal, booking.serviceDuration);
  const title = `${booking.name} — ${booking.service || info.businessName}`;
  const desc = [
    `Serviço: ${booking.service}`,
    booking.email ? `Email: ${booking.email}` : null,
    booking.phone ? `Telemóvel: ${booking.phone}` : null,
    info.address ? `Local: ${info.address}` : null,
    booking.message ? `\n${booking.message}` : null,
  ].filter(Boolean).join('\n');

  const ics = generateICS({
    uid:            `booking-${booking.id}${uidSuffix}@${info.businessName.toLowerCase().replace(/\s+/g, '-')}.app`,
    title, description: desc, location: info.address || null, startLocal, endLocal,
    organizerName:  info.businessName,
    organizerEmail: settings.notificationEmail || EMAIL_FROM,
    attendeeName:   booking.name,
    attendeeEmail:  booking.email,
  });
  return {
    attachment: { filename: 'convite.ics', content: Buffer.from(ics).toString('base64'), contentType: 'text/calendar; charset=utf-8; method=REQUEST' },
    googleUrl:  googleCalendarUrl(title, startLocal, endLocal, desc, info.address || null),
    outlookUrl: outlookCalendarUrl(title, startLocal, endLocal, desc, info.address || null),
  };
}

function getResend(settings) {
  const key = process.env.RESEND_API_KEY || settings.resendApiKey || '';
  return key ? new Resend(key) : null;
}

/* ── Google Calendar ──────────────────────────────────── */
async function createGoogleEvent({ settings, adminConfig, booking, svc }) {
  try {
    const auth = await getAuthorizedClient();
    if (!auth) return null;
    const info = businessInfo(settings);
    const adminEmail = settings.notificationEmail || (adminConfig || {}).email;
    const attendees = [];
    if (booking.email) attendees.push({ email: booking.email });
    if (adminEmail && adminEmail !== booking.email) attendees.push({ email: adminEmail });
    const mapsLink = info.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(info.address)}` : '';
    const startLocal = toLocalISO(booking.date, booking.time);

    const event = await createCalendarEvent(auth, {
      title: `${booking.name} — ${booking.service}`,
      description: [
        `Cliente: ${booking.name}`,
        `Email: ${booking.email || '—'}`,
        `Telemóvel: ${booking.phone || '—'}`,
        '',
        `Serviço: ${booking.service}`,
        svc.description ? `Descrição: ${svc.description}` : null,
        svc.price ? `Preço: ${svc.price}` : null,
        booking.message ? `\nNotas: ${booking.message}` : null,
        '',
        '─────────────────',
        info.address ? `📍 ${info.address}` : null,
        mapsLink ? `🗺 ${mapsLink}` : null,
        info.businessPhone ? `📞 ${info.businessPhone}` : null,
        info.businessEmail ? `✉ ${info.businessEmail}` : null,
      ].filter(l => l !== null).join('\n').trim(),
      startLocal,
      endLocal: addMinutes(startLocal, booking.serviceDuration),
      attendees,
      location: info.address || null,
      noMeet: true,
    });
    return event?.id || null;
  } catch (err) {
    console.error('[bookings] Google Calendar erro:', err.message, err.code || '');
    return null;
  }
}

async function moveGoogleEvent(booking, notify) {
  if (!booking.googleEventId) return;
  try {
    const auth = await getAuthorizedClient();
    if (!auth) return;
    const startLocal = toLocalISO(booking.date, booking.time);
    await updateCalendarEventTime(auth, booking.googleEventId, {
      startLocal, endLocal: addMinutes(startLocal, booking.serviceDuration), notify,
    });
  } catch (err) {
    console.error('[bookings] Google Calendar (mover) erro:', err.message);
  }
}

async function removeGoogleEvent(booking) {
  if (!booking.googleEventId) return;
  try {
    const auth = await getAuthorizedClient();
    if (auth) await deleteCalendarEvent(auth, booking.googleEventId);
  } catch (err) {
    console.error('[bookings] Google Calendar (apagar) erro:', err.message);
  }
}

/* ── Emails ───────────────────────────────────────────── */
async function sendAdminNotification({ settings, adminConfig, booking, svc }) {
  const resend = getResend(settings);
  const to = settings.notificationEmail || (adminConfig || {}).email;
  if (!resend || !to || settings.notifyBookings === false) return;
  const info = businessInfo(settings);
  try {
    await resend.emails.send({
      from:    `${info.businessName} <${EMAIL_FROM}>`,
      to,
      subject: `📅 Nova marcação: ${booking.name} — ${booking.date} às ${booking.time}`,
      html: `
        <div style="font-family:sans-serif;max-width:480px">
          <h2 style="color:#B30000">Nova Marcação</h2>
          <table style="border-collapse:collapse;width:100%">
            <tr><td style="padding:4px 8px;color:#888">Nome</td><td style="padding:4px 8px"><strong>${h(booking.name)}</strong></td></tr>
            <tr><td style="padding:4px 8px;color:#888">Email</td><td style="padding:4px 8px">${h(booking.email || '—')}</td></tr>
            <tr><td style="padding:4px 8px;color:#888">Telemóvel</td><td style="padding:4px 8px">${h(booking.phone || '—')}</td></tr>
            <tr><td style="padding:4px 8px;color:#888">Data</td><td style="padding:4px 8px"><strong>${h(booking.date)} às ${h(booking.time)}</strong></td></tr>
            <tr><td style="padding:4px 8px;color:#888">Serviço</td><td style="padding:4px 8px"><strong>${h(booking.service)}</strong></td></tr>
            <tr><td style="padding:4px 8px;color:#888">Duração</td><td style="padding:4px 8px">${booking.serviceDuration} min</td></tr>
            ${svc.price ? `<tr><td style="padding:4px 8px;color:#888">Preço</td><td style="padding:4px 8px"><strong>${h(svc.price)}</strong></td></tr>` : ''}
            ${booking.message ? `<tr><td style="padding:4px 8px;color:#888;vertical-align:top">Mensagem</td><td style="padding:4px 8px">${h(booking.message)}</td></tr>` : ''}
          </table>
          ${emailFooter}
        </div>`,
    });
  } catch (err) {
    console.error('[Email admin]', err.message);
  }
}

async function sendClientConfirmation({ settings, booking, svc }) {
  const resend = getResend(settings);
  if (!resend || !booking.email) return false;
  const info = businessInfo(settings);
  const { attachment, googleUrl, outlookUrl } = calendarAttachment({ booking, settings, info });
  try {
    await resend.emails.send({
      from:    `${info.businessName} <${EMAIL_FROM}>`,
      to:      booking.email,
      subject: `Marcação confirmada — ${booking.date} às ${booking.time}`,
      attachments: [attachment],
      html: `
        <div style="font-family:sans-serif;max-width:480px">
          <h2 style="color:#B30000">Marcação Confirmada!</h2>
          <p>Olá <strong>${h(booking.name)}</strong>,</p>
          <p>A tua marcação foi confirmada para <strong>${h(booking.date)} às ${h(booking.time)}</strong>.</p>
          <table style="border-collapse:collapse;width:100%;margin-top:12px">
            <tr><td style="padding:4px 8px;color:#888">Serviço</td><td style="padding:4px 8px"><strong>${h(booking.service)}</strong></td></tr>
            <tr><td style="padding:4px 8px;color:#888">Duração</td><td style="padding:4px 8px">${booking.serviceDuration} min</td></tr>
            ${svc.description ? `<tr><td style="padding:4px 8px;color:#888">Descrição</td><td style="padding:4px 8px">${h(svc.description)}</td></tr>` : ''}
            ${svc.price ? `<tr><td style="padding:4px 8px;color:#888">Preço</td><td style="padding:4px 8px"><strong>${h(svc.price)}</strong></td></tr>` : ''}
          </table>
          ${locationBlock(info.address)}
          ${calendarButtons(googleUrl, outlookUrl)}
          <p style="margin-top:24px;color:#666">Até breve, <strong>${h(info.businessName)}</strong></p>
          ${emailFooter}
        </div>`,
    });
    return true;
  } catch (err) {
    console.error('[Email client]', err.message);
    return false;
  }
}

async function sendRescheduleEmail({ settings, booking, oldDate, oldTime }) {
  const resend = getResend(settings);
  if (!resend || !booking.email) return false;
  const info = businessInfo(settings);
  const { attachment, googleUrl, outlookUrl } = calendarAttachment({ booking, settings, info, uidSuffix: `-${Date.now()}` });
  try {
    await resend.emails.send({
      from:    `${info.businessName} <${EMAIL_FROM}>`,
      to:      booking.email,
      subject: `⚠️ Alteração da sua marcação — ${booking.date} às ${booking.time}`,
      attachments: [attachment],
      html: `
        <div style="font-family:sans-serif;max-width:480px">
          <h2 style="color:#B30000">A sua marcação foi alterada</h2>
          <p>Olá <strong>${h(booking.name)}</strong>,</p>
          <p>Informamos que a sua marcação foi alterada. Por favor confirme o novo horário:</p>
          <table style="border-collapse:collapse;width:100%;margin-top:12px">
            <tr><td style="padding:6px 8px;color:#888">Antes</td><td style="padding:6px 8px;text-decoration:line-through;color:#999">${h(oldDate)} às ${h(oldTime)}</td></tr>
            <tr><td style="padding:6px 8px;color:#888">Agora</td><td style="padding:6px 8px;font-size:1.05rem"><strong style="color:#B30000">${h(booking.date)} às ${h(booking.time)}</strong></td></tr>
            <tr><td style="padding:6px 8px;color:#888">Serviço</td><td style="padding:6px 8px"><strong>${h(booking.service)}</strong> · ${booking.serviceDuration} min</td></tr>
          </table>
          ${locationBlock(info.address, 'Local')}
          ${calendarButtons(googleUrl, outlookUrl)}
          <p style="margin-top:20px;color:#666">Se o novo horário não lhe for conveniente, contacte-nos${info.businessPhone ? ` pelo <strong>${h(info.businessPhone)}</strong>` : ''}.</p>
          <p style="margin-top:16px;color:#666">Até breve, <strong>${h(info.businessName)}</strong></p>
          ${emailFooter}
        </div>`,
    });
    return true;
  } catch (err) {
    console.error('[Email reschedule]', err.message);
    return false;
  }
}

/* ── Handler ──────────────────────────────────────────── */
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── List (admin) ─────────────────────────────────────
  if (req.method === 'GET') {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    const bookings = (await readBookings()).reverse();
    return res.status(200).json({ bookings });
  }

  // ── Create ───────────────────────────────────────────
  if (req.method === 'POST') {
    const body = req.body || {};
    const isAdmin = body.admin === true;
    if (isAdmin && !(await requireAdmin(req, res))) return;

    const name    = clean(body.name, 100);
    const email   = clean(body.email, 160).toLowerCase();
    const phone   = clean(body.phone, 30);
    const message = clean(body.message, 1000);
    const { date, time, serviceId } = body;

    if (!name || !isDatePt(date) || !isTime(time)) {
      return res.status(400).json({ error: 'Nome, data e hora são obrigatórios.' });
    }
    if (!isAdmin && !email) return res.status(400).json({ error: 'O email é obrigatório.' });
    if (email && !isEmail(email)) return res.status(400).json({ error: 'Email inválido.' });

    const pipe = kv.pipeline();
    pipe.get('settings');
    pipe.get('services');
    pipe.get('admin_config');
    pipe.lrange('bookings', 0, MAX_BOOKINGS - 1);
    pipe.get('schedule');
    pipe.get('blockouts');
    const [settingsRaw, servicesRaw, adminConfig, existingRaw, scheduleRaw, blockouts] = await pipe.exec();
    const settings = settingsRaw || {};
    const services = servicesRaw || [];
    const existing = parseList(existingRaw);
    const defaultDur = Number(settings.duration) || 30;

    if (services.length && !services.some(s => s.id === serviceId)) {
      return res.status(400).json({ error: 'Por favor selecione um serviço.' });
    }
    const svc = resolveService(services, serviceId, settings);

    if (isAdmin) {
      // The owner can book anywhere (lunch, closed days…) — only warn about overlaps
      const conflict = findConflict(existing, { date, time, duration: svc.duration, defaultDur });
      if (conflict && !body.force) {
        return res.status(409).json({
          error: `Sobrepõe a marcação de ${conflict.name} às ${conflict.time}.`,
          conflict: { name: conflict.name, time: conflict.time },
        });
      }
    } else {
      if (settings.bookingEnabled === false) {
        return res.status(403).json({ error: 'As marcações online estão desativadas.' });
      }
      const problem = SlotLogic.checkBookable({
        schedule: scheduleRaw || SlotLogic.DEFAULT_SCHEDULE, blockouts, bookings: existing,
        datePt: date, time, duration: svc.duration, defaultDur,
      });
      if (problem) return res.status(409).json({ error: problem });
    }

    const booking = {
      id:              `${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
      name, email, phone, message, date, time,
      service:         svc.label,
      serviceId:       svc.id,
      serviceDuration: svc.duration,
      source:          isAdmin ? 'admin' : 'online',
      createdAt:       new Date().toISOString(),
    };

    const googleEventId = await createGoogleEvent({ settings, adminConfig, booking, svc });
    if (googleEventId) booking.googleEventId = googleEventId;

    const writePipe = kv.pipeline();
    writePipe.lpush('bookings', JSON.stringify(booking));
    writePipe.ltrim('bookings', 0, MAX_BOOKINGS - 1);
    await writePipe.exec();

    let emailSent = false;
    if (isAdmin) {
      if (body.sendEmail && booking.email) emailSent = await sendClientConfirmation({ settings, booking, svc });
    } else {
      await sendAdminNotification({ settings, adminConfig, booking, svc });
      emailSent = await sendClientConfirmation({ settings, booking, svc });
    }

    return res.status(200).json({ ok: true, booking, emailSent });
  }

  // ── Update / move (admin) ────────────────────────────
  if (req.method === 'PUT') {
    if (!(await requireAdmin(req, res))) return;
    const body = req.body || {};
    if (!body.id) return res.status(400).json({ error: 'id em falta' });

    const pipe = kv.pipeline();
    pipe.get('settings');
    pipe.get('services');
    pipe.lrange('bookings', 0, MAX_BOOKINGS - 1);
    const [settingsRaw, servicesRaw, raw] = await pipe.exec();
    const settings = settingsRaw || {};
    const bookings = parseList(raw);
    const idx = bookings.findIndex(b => b.id === body.id);
    if (idx === -1) return res.status(404).json({ error: 'Marcação não encontrada' });

    const original = bookings[idx];
    const updated  = { ...original };

    if (body.date !== undefined) {
      if (!isDatePt(body.date)) return res.status(400).json({ error: 'Data inválida' });
      updated.date = body.date;
    }
    if (body.time !== undefined) {
      if (!isTime(body.time)) return res.status(400).json({ error: 'Hora inválida' });
      updated.time = body.time;
    }
    if (body.name !== undefined) {
      updated.name = clean(body.name, 100);
      if (!updated.name) return res.status(400).json({ error: 'O nome é obrigatório.' });
    }
    if (body.email !== undefined) {
      updated.email = clean(body.email, 160).toLowerCase();
      if (updated.email && !isEmail(updated.email)) return res.status(400).json({ error: 'Email inválido.' });
    }
    if (body.phone !== undefined)   updated.phone   = clean(body.phone, 30);
    if (body.message !== undefined) updated.message = clean(body.message, 1000);
    if (body.serviceId !== undefined && body.serviceId !== original.serviceId) {
      const services = servicesRaw || [];
      if (!services.some(s => s.id === body.serviceId)) return res.status(400).json({ error: 'Serviço inválido.' });
      const svc = resolveService(services, body.serviceId, settings);
      Object.assign(updated, { serviceId: svc.id, service: svc.label, serviceDuration: svc.duration });
    }

    const conflict = findConflict(bookings, {
      date: updated.date, time: updated.time, duration: Number(updated.serviceDuration) || 30,
      defaultDur: Number(settings.duration) || 30, excludeId: updated.id,
    });
    if (conflict && !body.force) {
      return res.status(409).json({
        error: `Sobrepõe a marcação de ${conflict.name} às ${conflict.time}.`,
        conflict: { name: conflict.name, time: conflict.time },
      });
    }

    const moved = original.date !== updated.date || original.time !== updated.time
      || original.serviceDuration !== updated.serviceDuration;
    updated.updatedAt = new Date().toISOString();
    bookings[idx] = updated;
    await writeBookings(bookings);

    let emailSent = false;
    if (moved) {
      await moveGoogleEvent(updated, Boolean(body.notify));
      if (body.notify) {
        emailSent = await sendRescheduleEmail({ settings, booking: updated, oldDate: original.date, oldTime: original.time });
      }
    }
    return res.status(200).json({ ok: true, booking: updated, previous: { date: original.date, time: original.time }, emailSent });
  }

  // ── Delete (admin) ───────────────────────────────────
  if (req.method === 'DELETE') {
    if (!(await requireAdmin(req, res))) return;
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: 'id em falta' });
    const bookings = await readBookings();
    const target = bookings.find(b => b.id === id);
    if (!target) return res.status(404).json({ error: 'Marcação não encontrada' });
    await writeBookings(bookings.filter(b => b.id !== id));
    await removeGoogleEvent(target);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).end();
};
