const { google } = require('googleapis');
const { kv } = require('./kv');

const SCOPES = ['https://www.googleapis.com/auth/calendar'];
const KV_KEY = 'google_tokens';

async function getCredentials() {
  return {
    clientId:     process.env.GOOGLE_CLIENT_ID     || await kv.get('google_client_id'),
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || await kv.get('google_client_secret'),
  };
}

async function hasCredentials() {
  const { clientId, clientSecret } = await getCredentials();
  return Boolean(clientId && clientSecret);
}

async function getOAuthClient(redirectUri) {
  const { clientId, clientSecret } = await getCredentials();
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

async function getAuthorizedClient() {
  const tokens = await kv.get(KV_KEY);
  if (!tokens) return null;

  const client = await getOAuthClient();
  client.setCredentials(tokens);

  client.on('tokens', async (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    await kv.set(KV_KEY, merged);
  });

  return client;
}

async function buildAuthUrl(redirectUri, state) {
  const client = await getOAuthClient(redirectUri);
  return client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
    state,
  });
}

async function exchangeCode(code, redirectUri) {
  const client = await getOAuthClient(redirectUri);
  const { tokens } = await client.getToken(code);
  await kv.set(KV_KEY, tokens);
  return tokens;
}

async function disconnectCalendar() {
  await kv.del(KV_KEY);
}

async function createCalendarEvent(auth, { title, description, startLocal, endLocal, attendees, location, noMeet }) {
  const calendar = google.calendar({ version: 'v3', auth });

  const event = {
    summary: title,
    description,
    start: { dateTime: startLocal, timeZone: 'Europe/Lisbon' },
    end:   { dateTime: endLocal,   timeZone: 'Europe/Lisbon' },
    attendees: attendees || [],
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'email', minutes: 60 },
        { method: 'popup', minutes: 15 },
      ],
    },
  };

  if (location) {
    event.location = location;
  }

  if (!noMeet) {
    event.conferenceData = {
      createRequest: {
        requestId: `slotbook-${Date.now()}`,
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    };
  }

  const { data } = await calendar.events.insert({
    calendarId: 'primary',
    resource: event,
    conferenceDataVersion: noMeet ? 0 : 1,
    sendUpdates: 'all',
  });

  return data;
}

module.exports = {
  getCredentials, hasCredentials, getOAuthClient,
  getAuthorizedClient, buildAuthUrl, exchangeCode,
  disconnectCalendar, createCalendarEvent,
};
