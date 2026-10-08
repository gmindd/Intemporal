const { requireAdmin } = require('../lib/auth');
const { getAuthorizedClient, createCalendarEvent } = require('../lib/google');
const { kv } = require('../lib/kv');
const { Resend } = require('resend');

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

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    const raw      = (await kv.lrange('bookings', 0, 99)) || [];
    const bookings = raw.map(b => (typeof b === 'string' ? JSON.parse(b) : b)).reverse();
    return res.status(200).json({ bookings });
  }

  if (req.method === 'POST') {
    const { name, email, phone, message, date, time, serviceId } = req.body || {};

    if (!name || !email || !date || !time) {
      return res.status(400).json({ error: 'Campos obrigatórios em falta' });
    }

    // Batch all reads into a single pipeline (4 reads → 1 request)
    const pipe = kv.pipeline();
    pipe.get('settings');
    pipe.get('services');
    pipe.get('admin_config');
    pipe.lrange('bookings', 0, 999);
    const [settingsRaw, servicesRaw, adminConfig, existing] = await pipe.exec();

    const settings      = settingsRaw || {};
    const address       = settings.address       || '';
    const businessName  = settings.businessName  || 'SlotBook';
    const businessPhone = settings.businessPhone || '';
    const businessEmail = settings.businessEmail || '';

    // Resolve service info
    let duration         = settings.duration    || 30;
    let serviceLabel     = settings.serviceName || '';
    let serviceDescription = '';
    let servicePrice     = '';

    if (serviceId) {
      const svc = (servicesRaw || []).find(s => s.id === serviceId);
      if (svc) {
        duration           = svc.duration;
        serviceLabel       = svc.name;
        serviceDescription = svc.description || '';
        servicePrice       = svc.price       || '';
      }
    }

    const displayLabel = serviceLabel || `Consulta · ${duration} min`;

    // Prevent overlapping bookings
    const timeToMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
    const newStart  = timeToMin(time);
    const newEnd    = newStart + duration;
    const conflict = existing.some(b => {
      const bk = typeof b === 'string' ? JSON.parse(b) : b;
      if (bk.date !== date) return false;
      const bkStart = timeToMin(bk.time);
      const bkEnd   = bkStart + (bk.serviceDuration || settings.duration || 30);
      return bkStart < newEnd && bkEnd > newStart;
    });
    if (conflict) {
      return res.status(409).json({ error: 'Este horário já está ocupado. Por favor escolha outro horário.' });
    }

    const booking = {
      id: Date.now().toString(),
      name,
      email,
      phone:           phone   || '',
      message:         message || '',
      date,
      time,
      service:         displayLabel,
      serviceId:       serviceId       || '',
      serviceDuration: duration,
      createdAt:       new Date().toISOString(),
    };

    // lpush + ltrim batched into one pipeline (2 writes → 1 request)
    const writePipe = kv.pipeline();
    writePipe.lpush('bookings', JSON.stringify(booking));
    writePipe.ltrim('bookings', 0, 199);
    await writePipe.exec();

    const startLocal = toLocalISO(date, time);
    const endLocal   = addMinutes(startLocal, duration);

    let meetLink = null;

    try {
      const auth = await getAuthorizedClient();
      if (!auth) {
        console.log('[bookings] Google Calendar não ligado — evento não criado');
      } else {
        const adminEmail = settings.notificationEmail || (adminConfig || {}).email;

        const attendees = [{ email }];
        if (adminEmail && adminEmail !== email) attendees.push({ email: adminEmail });

        const eventTitle = businessName;
        const mapsLink  = address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}` : '';

        console.log(`[bookings] A criar evento: ${startLocal} → ${endLocal}, convidados: ${attendees.map(a=>a.email).join(', ')}`);

        const event = await createCalendarEvent(auth, {
          title:       eventTitle,
          description: [
            `Cliente: ${name}`,
            `Email: ${email}`,
            `Telemóvel: ${phone || '—'}`,
            '',
            `Serviço: ${displayLabel}`,
            serviceDescription ? `Descrição: ${serviceDescription}` : null,
            servicePrice       ? `Preço: ${servicePrice}`           : null,
            message ? `\nNotas: ${message}` : null,
            '',
            '─────────────────',
            address       ? `📍 ${address}`       : null,
            mapsLink      ? `🗺 ${mapsLink}`       : null,
            businessPhone ? `📞 ${businessPhone}`  : null,
            businessEmail ? `✉ ${businessEmail}`   : null,
          ].filter(l => l !== null).join('\n').trim(),
          startLocal,
          endLocal,
          attendees,
          location:    address || null,
          noMeet:      true,
        });

        if (!address) {
          meetLink = event?.conferenceData?.entryPoints?.find(e => e.entryPointType === 'video')?.uri || null;
        }
        console.log(`[bookings] Evento criado. Local: ${address || meetLink || 'nenhum'}`);
      }
    } catch (err) {
      console.error('[bookings] Google Calendar erro:', err.message, err.code || '');
    }

    const resendKey   = process.env.RESEND_API_KEY || settings.resendApiKey || '';

    if (resendKey) {
      const resend      = new Resend(resendKey);
      const notifyEmail = settings.notificationEmail || (adminConfig || {}).email;
      const eventTitle  = `${name} — ${serviceLabel || businessName}`;

      // Service details rows for emails
      const svcRowsAdmin = `
        <tr><td style="padding:4px 8px;color:#888">Serviço</td><td style="padding:4px 8px"><strong>${displayLabel}</strong></td></tr>
        <tr><td style="padding:4px 8px;color:#888">Duração</td><td style="padding:4px 8px">${duration} min</td></tr>
        ${serviceDescription ? `<tr><td style="padding:4px 8px;color:#888">Descrição</td><td style="padding:4px 8px">${serviceDescription}</td></tr>` : ''}
        ${servicePrice ? `<tr><td style="padding:4px 8px;color:#888">Preço</td><td style="padding:4px 8px"><strong>${servicePrice}</strong></td></tr>` : ''}
      `;

      // Location or Meet block for admin email
      const locationAdminHtml = address
        ? `<tr><td style="padding:4px 8px;color:#888">Local</td><td style="padding:4px 8px"><strong>${address}</strong></td></tr>`
        : meetLink
          ? `<tr><td style="padding:4px 8px;color:#888">Meet</td><td style="padding:4px 8px"><a href="${meetLink}" style="color:#B8913F">Entrar na reunião</a></td></tr>`
          : '';

      const desc = [
        `Serviço: ${displayLabel}`,
        serviceDescription ? `Descrição: ${serviceDescription}` : null,
        servicePrice ? `Preço: ${servicePrice}` : null,
        `Email: ${email}`,
        phone ? `Telemóvel: ${phone}` : null,
        address ? `Local: ${address}` : null,
        message ? `\n${message}` : null,
      ].filter(Boolean).join('\n');

      const icsContent = generateICS({
        uid:            `booking-${booking.id}@${businessName.toLowerCase().replace(/\s+/g,'-')}.app`,
        title:          eventTitle,
        description:    desc,
        location:       address || null,
        startLocal,
        endLocal,
        organizerName:  businessName,
        organizerEmail: notifyEmail || `noreply@slotbook.cc`,
        attendeeName:   name,
        attendeeEmail:  email,
      });

      const googleUrl  = googleCalendarUrl(eventTitle, startLocal, endLocal, desc, address || null);
      const outlookUrl = outlookCalendarUrl(eventTitle, startLocal, endLocal, desc, address || null);

      const slotbookFooter = `
        <hr style="border:none;border-top:1px solid #eee;margin:28px 0 10px">
        <p style="font-size:.72rem;color:#bbb;text-align:center;margin:0">
          Serviço prestado por <a href="https://www.slotbook.cc" style="color:#C9A84C;text-decoration:none">SlotBook</a>
        </p>`;

      if (notifyEmail && settings.notifyBookings !== false) {
        try {
          await resend.emails.send({
            from:    `${businessName} <noreply@slotbook.cc>`,
            to:      notifyEmail,
            subject: `📅 Nova marcação: ${name} — ${date} às ${time}`,
            html: `
              <div style="font-family:sans-serif;max-width:480px">
                <h2 style="color:#B8913F">Nova Marcação</h2>
                <table style="border-collapse:collapse;width:100%">
                  <tr><td style="padding:4px 8px;color:#888">Nome</td><td style="padding:4px 8px"><strong>${name}</strong></td></tr>
                  <tr><td style="padding:4px 8px;color:#888">Email</td><td style="padding:4px 8px">${email}</td></tr>
                  <tr><td style="padding:4px 8px;color:#888">Telemóvel</td><td style="padding:4px 8px">${phone || '—'}</td></tr>
                  <tr><td style="padding:4px 8px;color:#888">Data</td><td style="padding:4px 8px"><strong>${date} às ${time}</strong></td></tr>
                  ${svcRowsAdmin}
                  ${message ? `<tr><td style="padding:4px 8px;color:#888;vertical-align:top">Mensagem</td><td style="padding:4px 8px">${message}</td></tr>` : ''}
                  ${locationAdminHtml}
                </table>
                ${slotbookFooter}
              </div>`,
          });
        } catch (err) {
          console.error('[Email admin]', err.message);
        }
      }

      // Location or Meet block for client email
      const locationClientHtml = address
        ? `<div style="margin-top:16px;padding:14px 18px;background:#f9f5ee;border-radius:8px;border-left:3px solid #B8913F">
            <p style="margin:0;font-size:.88rem;color:#666">📍 <strong style="color:#333">Local do encontro:</strong></p>
            <p style="margin:6px 0 0;font-weight:600;color:#1A1612">${address}</p>
          </div>`
        : meetLink
          ? `<p style="margin-top:16px"><a href="${meetLink}" style="display:inline-block;padding:12px 24px;background:#B8913F;color:#fff;text-decoration:none;border-radius:8px;font-weight:500">Entrar na reunião Google Meet</a></p>`
          : '';

      try {
        await resend.emails.send({
          from:    `${businessName} <noreply@slotbook.cc>`,
          to:      email,
          subject: `Marcação confirmada — ${date} às ${time}`,
          attachments: [{
            filename:    'convite.ics',
            content:     Buffer.from(icsContent).toString('base64'),
            contentType: 'text/calendar; charset=utf-8; method=REQUEST',
          }],
          html: `
            <div style="font-family:sans-serif;max-width:480px">
              <h2 style="color:#B8913F">Marcação Confirmada!</h2>
              <p>Olá <strong>${name}</strong>,</p>
              <p>A tua marcação foi confirmada para <strong>${date} às ${time}</strong>.</p>
              <table style="border-collapse:collapse;width:100%;margin-top:12px">
                <tr><td style="padding:4px 8px;color:#888">Serviço</td><td style="padding:4px 8px"><strong>${displayLabel}</strong></td></tr>
                <tr><td style="padding:4px 8px;color:#888">Duração</td><td style="padding:4px 8px">${duration} min</td></tr>
                ${serviceDescription ? `<tr><td style="padding:4px 8px;color:#888">Descrição</td><td style="padding:4px 8px">${serviceDescription}</td></tr>` : ''}
                ${servicePrice ? `<tr><td style="padding:4px 8px;color:#888">Preço</td><td style="padding:4px 8px"><strong>${servicePrice}</strong></td></tr>` : ''}
              </table>
              ${locationClientHtml}
              <div style="margin-top:24px;padding:16px;background:#f9f5ee;border-radius:8px">
                <p style="margin:0 0 12px;color:#666;font-size:.88rem">Adiciona ao teu calendário:</p>
                <a href="${googleUrl}" style="display:inline-block;margin-right:8px;margin-bottom:8px;padding:9px 16px;background:#4285F4;color:#fff;text-decoration:none;border-radius:6px;font-size:.85rem;font-weight:500">📅 Google Calendar</a>
                <a href="${outlookUrl}" style="display:inline-block;margin-bottom:8px;padding:9px 16px;background:#0078D4;color:#fff;text-decoration:none;border-radius:6px;font-size:.85rem;font-weight:500">📅 Outlook</a>
                <p style="margin:8px 0 0;color:#999;font-size:.78rem">O ficheiro <strong>convite.ics</strong> em anexo também funciona em qualquer aplicação de calendário (iOS, Android, etc.).</p>
              </div>
              <p style="margin-top:24px;color:#666">Até breve, <strong>${businessName}</strong></p>
              ${slotbookFooter}
            </div>`,
        });
      } catch (err) {
        console.error('[Email client]', err.message);
      }
    }

    return res.status(200).json({ ok: true, booking });
  }

  if (req.method === 'PUT') {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const { id, date, time } = req.body || {};
    if (!id || !date || !time) {
      return res.status(400).json({ error: 'id, date e time são obrigatórios' });
    }

    const raw = (await kv.lrange('bookings', 0, 999)) || [];
    const bookings = raw.map(b => (typeof b === 'string' ? JSON.parse(b) : b));
    const idx = bookings.findIndex(b => b.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Marcação não encontrada' });

    const original = bookings[idx];
    const timeChanged = original.time !== time || original.date !== date;

    bookings[idx] = { ...original, date, time };

    // Rewrite the entire list (KV list has no random-access update)
    // del + one batched lpush = 2 requests regardless of list size
    await kv.del('bookings');
    if (bookings.length > 0) {
      // lpush(key, v1, v2, …) pushes left; last arg ends at head.
      // bookings[0] is newest → pass reversed so newest lands at index 0.
      await kv.lpush('bookings', ...bookings.slice().reverse().map(b => JSON.stringify(b)));
    }

    // Send rescheduling email to client if time/date changed
    if (timeChanged) {
      const updated   = bookings[idx];
      const settings  = (await kv.get('settings')) || {};
      const businessName  = settings.businessName  || 'SlotBook';
      const address       = settings.address       || '';
      const resendKey     = process.env.RESEND_API_KEY || settings.resendApiKey || '';

      if (resendKey && updated.email) {
        const resend      = new Resend(resendKey);
        const duration    = updated.serviceDuration || settings.duration || 30;
        const displayLabel = updated.service || `Marcação · ${duration} min`;
        const startLocal  = toLocalISO(date, time);
        const endLocal    = addMinutes(startLocal, duration);

        const desc = [
          `Serviço: ${displayLabel}`,
          address ? `Local: ${address}` : null,
        ].filter(Boolean).join('\n');

        const icsContent = generateICS({
          uid:            `booking-${updated.id}-reschedule@${businessName.toLowerCase().replace(/\s+/g,'-')}.app`,
          title:          `${updated.name} — ${displayLabel}`,
          description:    desc,
          location:       address || null,
          startLocal,
          endLocal,
          organizerName:  businessName,
          organizerEmail: settings.notificationEmail || `noreply@slotbook.cc`,
          attendeeName:   updated.name,
          attendeeEmail:  updated.email,
        });

        const googleUrl  = googleCalendarUrl(`${updated.name} — ${displayLabel}`, startLocal, endLocal, desc, address || null);
        const outlookUrl = outlookCalendarUrl(`${updated.name} — ${displayLabel}`, startLocal, endLocal, desc, address || null);

        const locationHtml = address
          ? `<div style="margin-top:16px;padding:14px 18px;background:#f9f5ee;border-radius:8px;border-left:3px solid #B8913F">
              <p style="margin:0;font-size:.88rem;color:#666">📍 <strong style="color:#333">Local:</strong></p>
              <p style="margin:6px 0 0;font-weight:600;color:#1A1612">${address}</p>
            </div>`
          : '';

        try {
          await resend.emails.send({
            from:    `${businessName} <noreply@slotbook.cc>`,
            to:      updated.email,
            subject: `Marcação reagendada — ${date} às ${time}`,
            attachments: [{
              filename:    'convite.ics',
              content:     Buffer.from(icsContent).toString('base64'),
              contentType: 'text/calendar; charset=utf-8; method=REQUEST',
            }],
            html: `
              <div style="font-family:sans-serif;max-width:480px">
                <h2 style="color:#B8913F">Marcação Reagendada</h2>
                <p>Olá <strong>${updated.name}</strong>,</p>
                <p>A tua marcação foi reagendada para <strong>${date} às ${time}</strong>.</p>
                <table style="border-collapse:collapse;width:100%;margin-top:12px">
                  <tr><td style="padding:4px 8px;color:#888">Serviço</td><td style="padding:4px 8px"><strong>${displayLabel}</strong></td></tr>
                  <tr><td style="padding:4px 8px;color:#888">Nova data</td><td style="padding:4px 8px"><strong>${date} às ${time}</strong></td></tr>
                  <tr><td style="padding:4px 8px;color:#888">Duração</td><td style="padding:4px 8px">${duration} min</td></tr>
                </table>
                ${locationHtml}
                <div style="margin-top:24px;padding:16px;background:#f9f5ee;border-radius:8px">
                  <p style="margin:0 0 12px;color:#666;font-size:.88rem">Adiciona ao teu calendário:</p>
                  <a href="${googleUrl}" style="display:inline-block;margin-right:8px;margin-bottom:8px;padding:9px 16px;background:#4285F4;color:#fff;text-decoration:none;border-radius:6px;font-size:.85rem;font-weight:500">📅 Google Calendar</a>
                  <a href="${outlookUrl}" style="display:inline-block;margin-bottom:8px;padding:9px 16px;background:#0078D4;color:#fff;text-decoration:none;border-radius:6px;font-size:.85rem;font-weight:500">📅 Outlook</a>
                  <p style="margin:8px 0 0;color:#999;font-size:.78rem">O ficheiro <strong>convite.ics</strong> em anexo funciona em qualquer aplicação de calendário.</p>
                </div>
                <p style="margin-top:24px;color:#666">Até breve, <strong>${businessName}</strong></p>
              </div>`,
          });
        } catch (err) {
          console.error('[Email reschedule]', err.message);
        }
      }
    }

    return res.status(200).json({ ok: true, booking: bookings[idx] });
  }

  return res.status(405).end();
};
