require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA_PATH = path.join(__dirname, 'data', 'board-state.json');

const USERNAME = process.env.KANBAN_USER || 'admin';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-session-secret';
const plainPassword = process.env.KANBAN_PASS || 'change-me-now';
const passwordHash = process.env.KANBAN_PASS_HASH || bcrypt.hashSync(plainPassword, 10);

const M365_TENANT_ID = process.env.M365_TENANT_ID || '';
const M365_CLIENT_ID = process.env.M365_CLIENT_ID || '';
const M365_CLIENT_SECRET = process.env.M365_CLIENT_SECRET || '';
const M365_REDIRECT_URI = process.env.M365_REDIRECT_URI || `http://localhost:${PORT}/auth/microsoft/callback`;
const HUBSPOT_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN || process.env.HUBSPOT_ACCESS_TOKEN || '';
const HAS_STATIC_HUBSPOT_TOKEN = !!HUBSPOT_TOKEN && HUBSPOT_TOKEN.startsWith('pat-');
const HUBSPOT_CLIENT_ID = process.env.HUBSPOT_CLIENT_ID || '';
const HUBSPOT_CLIENT_SECRET = process.env.HUBSPOT_CLIENT_SECRET || '';
const HUBSPOT_REDIRECT_URI = process.env.HUBSPOT_REDIRECT_URI || `http://localhost:${PORT}/auth/hubspot/callback`;
const HUBSPOT_SCOPES = process.env.HUBSPOT_SCOPES || 'crm.objects.contacts.read crm.objects.companies.read crm.objects.deals.read crm.objects.tickets.read crm.objects.owners.read crm.schemas.contacts.read crm.schemas.companies.read crm.schemas.deals.read crm.schemas.tickets.read crm.objects.custom.read crm.schemas.custom.read';
const HUBSPOT_PKCE_CODE_VERIFIER = process.env.HUBSPOT_PKCE_CODE_VERIFIER || '';
const HUBSPOT_PKCE_CODE_CHALLENGE = process.env.HUBSPOT_PKCE_CODE_CHALLENGE || '';
const HUBSPOT_AUTHORIZE_BASE = process.env.HUBSPOT_AUTHORIZE_BASE || 'https://app.hubspot.com/oauth/authorize';

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '2mb' }));
app.use(session({
  name: 'kanban.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: false, maxAge: 1000 * 60 * 60 * 12 }
}));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });

function isAuthed(req) { return req.session && req.session.authenticated === true; }
function requireAuth(req, res, next) { return isAuthed(req) ? next() : res.status(401).json({ error: 'unauthorized' }); }

function safeReadState() {
  try {
    if (!fs.existsSync(DATA_PATH)) return {};
    return JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')) || {};
  } catch { return {}; }
}
function safeWriteState(state) {
  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  fs.writeFileSync(DATA_PATH, JSON.stringify(state, null, 2), 'utf8');
}

async function graphDelegatedToken(req) {
  const t = req.session?.m365Tokens;
  if (!t?.accessToken || !t?.refreshToken) throw new Error('m365_not_connected');
  if (Date.now() < (t.expiresAt || 0) - 60_000) return t.accessToken;

  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: M365_CLIENT_ID,
    client_secret: M365_CLIENT_SECRET,
    refresh_token: t.refreshToken,
    redirect_uri: M365_REDIRECT_URI,
    scope: 'offline_access openid profile email Mail.Read Mail.Read.Shared'
  });
  const res = await fetch(`https://login.microsoftonline.com/${M365_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form
  });
  if (!res.ok) throw new Error(`graph_refresh_error_${res.status}`);
  const json = await res.json();
  req.session.m365Tokens = {
    accessToken: json.access_token,
    refreshToken: json.refresh_token || t.refreshToken,
    expiresAt: Date.now() + (json.expires_in || 3600) * 1000
  };
  return req.session.m365Tokens.accessToken;
}

async function graphGet(pathname, token) {
  const res = await fetch(`https://graph.microsoft.com/v1.0${pathname}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`graph_error_${res.status}:${txt.slice(0, 200)}`);
  }
  return res.json();
}

function mapMessage(msg) {
  return {
    id: msg.id,
    subject: msg.subject || '',
    summary: msg.bodyPreview || '',
    sender: msg.from?.emailAddress?.address?.toLowerCase() || '',
    recipients: (msg.toRecipients || []).map(r => r.emailAddress?.address?.toLowerCase()).filter(Boolean),
    receivedDateTime: msg.receivedDateTime,
    webLink: msg.webLink,
    uri: `mail:///messages/${msg.id}`
  };
}

async function hubspotSearch(args) {
  async function hubspotAccessToken(req) {
    if (req?.session?.hubspotTokens?.accessToken && Date.now() < (req.session.hubspotTokens.expiresAt || 0) - 60_000) {
      return req.session.hubspotTokens.accessToken;
    }
    if (req?.session?.hubspotTokens?.refreshToken && HUBSPOT_CLIENT_ID && HUBSPOT_CLIENT_SECRET) {
      const form = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: HUBSPOT_CLIENT_ID,
        client_secret: HUBSPOT_CLIENT_SECRET,
        refresh_token: req.session.hubspotTokens.refreshToken
      });
      const refRes = await fetch('https://api.hubapi.com/oauth/v1/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form
      });
      if (refRes.ok) {
        const tk = await refRes.json();
        req.session.hubspotTokens = {
          accessToken: tk.access_token,
          refreshToken: tk.refresh_token || req.session.hubspotTokens.refreshToken,
          expiresAt: Date.now() + (tk.expires_in || 1800) * 1000
        };
        return req.session.hubspotTokens.accessToken;
      }
    }
    if (HAS_STATIC_HUBSPOT_TOKEN) return HUBSPOT_TOKEN;
    throw new Error('hubspot_not_connected');
  }
  const token = await hubspotAccessToken(args.__req);
  const objectType = args.objectType;
  const associatedWith = args?.filterGroups?.[0]?.associatedWith;
  if (objectType === 'companies' && Array.isArray(associatedWith) && associatedWith[0]?.objectType === 'contacts') {
    const contactId = associatedWith[0]?.objectIdValues?.[0];
    if (!contactId) return { results: [] };
    const assocRes = await fetch(`https://api.hubapi.com/crm/v3/objects/contacts/${contactId}/associations/companies`, { headers: { Authorization: `Bearer ${token}` } });
    if (!assocRes.ok) return { results: [] };
    const assocJson = await assocRes.json();
    const companyIds = (assocJson.results || []).map(x => x.id).filter(Boolean);
    if (!companyIds.length) return { results: [] };
    const batchRes = await fetch('https://api.hubapi.com/crm/v3/objects/companies/batch/read', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: companyIds.map(id => ({ id })), properties: args.properties || ['name', 'domain', 'createdate'] })
    });
    if (!batchRes.ok) return { results: [] };
    const batchJson = await batchRes.json();
    return { results: batchJson.results || [] };
  }
  const endpoint = `https://api.hubapi.com/crm/v3/objects/${encodeURIComponent(objectType)}/search`;
  const payload = { filterGroups: args.filterGroups || [], properties: args.properties || [], sorts: args.sorts || [], limit: args.limit || 50 };
  const res = await fetch(endpoint, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`hubspot_error_${res.status}:${txt.slice(0, 200)}`);
  }
  return res.json();
}

app.get('/login', (req, res) => isAuthed(req) ? res.redirect('/') : res.sendFile(path.join(__dirname, 'public', 'login.html')));

app.post('/auth/login', authLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'missing_credentials' });
  if (username !== USERNAME) return res.status(401).json({ error: 'invalid_credentials' });
  const ok = await bcrypt.compare(password, passwordHash);
  if (!ok) return res.status(401).json({ error: 'invalid_credentials' });
  req.session.authenticated = true;
  req.session.username = username;
  return res.json({ ok: true });
});

app.get('/auth/microsoft/start', requireAuth, (req, res) => {
  if (!M365_TENANT_ID || !M365_CLIENT_ID || !M365_CLIENT_SECRET) return res.status(500).send('Missing Microsoft env vars.');
  const state = crypto.randomBytes(16).toString('hex');
  req.session.m365State = state;
  const scope = encodeURIComponent('offline_access openid profile email Mail.Read Mail.Read.Shared');
  const url = `https://login.microsoftonline.com/${M365_TENANT_ID}/oauth2/v2.0/authorize?client_id=${encodeURIComponent(M365_CLIENT_ID)}&response_type=code&redirect_uri=${encodeURIComponent(M365_REDIRECT_URI)}&response_mode=query&scope=${scope}&state=${state}&prompt=select_account`;
  res.redirect(url);
});

app.get('/auth/microsoft/callback', requireAuth, async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state || state !== req.session.m365State) return res.status(400).send('Invalid Microsoft OAuth state.');
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: M365_CLIENT_ID,
      client_secret: M365_CLIENT_SECRET,
      code: String(code),
      redirect_uri: M365_REDIRECT_URI,
      scope: 'offline_access openid profile email Mail.Read Mail.Read.Shared'
    });
    const tokenRes = await fetch(`https://login.microsoftonline.com/${M365_TENANT_ID}/oauth2/v2.0/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form
    });
    if (!tokenRes.ok) {
      const t = await tokenRes.text();
      return res.status(500).send(`Microsoft token exchange failed: ${t}`);
    }
    const tokenJson = await tokenRes.json();
    req.session.m365Tokens = {
      accessToken: tokenJson.access_token,
      refreshToken: tokenJson.refresh_token,
      expiresAt: Date.now() + (tokenJson.expires_in || 3600) * 1000
    };
    delete req.session.m365State;
    return res.redirect('/');
  } catch (e) {
    return res.status(500).send(String(e.message || e));
  }
});

app.get('/auth/microsoft/status', requireAuth, (req, res) => {
  res.json({ connected: !!req.session?.m365Tokens?.refreshToken });
});

app.get('/auth/hubspot/start', requireAuth, (req, res) => {
  if (!HUBSPOT_CLIENT_ID || !HUBSPOT_CLIENT_SECRET) return res.status(500).send('Missing HubSpot env vars.');
  const state = crypto.randomBytes(16).toString('hex');
  req.session.hubspotState = state;
  const usePkce = !!HUBSPOT_PKCE_CODE_VERIFIER && !!HUBSPOT_PKCE_CODE_CHALLENGE;
  const params = new URLSearchParams({
    client_id: HUBSPOT_CLIENT_ID,
    redirect_uri: HUBSPOT_REDIRECT_URI,
    state
  });
  if (usePkce) {
    params.set('code_challenge', HUBSPOT_PKCE_CODE_CHALLENGE);
    params.set('code_challenge_method', 'S256');
  } else {
    params.set('scope', HUBSPOT_SCOPES);
  }
  const url = `${HUBSPOT_AUTHORIZE_BASE}?${params.toString()}`;
  res.redirect(url);
});

app.get('/auth/hubspot/callback', requireAuth, async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state || state !== req.session.hubspotState) return res.status(400).send('Invalid HubSpot OAuth state.');
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: HUBSPOT_CLIENT_ID,
      client_secret: HUBSPOT_CLIENT_SECRET,
      redirect_uri: HUBSPOT_REDIRECT_URI,
      code: String(code)
    });
    if (HUBSPOT_PKCE_CODE_VERIFIER) {
      form.set('code_verifier', HUBSPOT_PKCE_CODE_VERIFIER);
    }
    const tokenRes = await fetch('https://api.hubapi.com/oauth/v1/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form
    });
    if (!tokenRes.ok) {
      const t = await tokenRes.text();
      return res.status(500).send(`HubSpot token exchange failed: ${t}`);
    }
    const tokenJson = await tokenRes.json();
    req.session.hubspotTokens = {
      accessToken: tokenJson.access_token,
      refreshToken: tokenJson.refresh_token,
      expiresAt: Date.now() + (tokenJson.expires_in || 1800) * 1000
    };
    delete req.session.hubspotState;
    return res.redirect('/');
  } catch (e) {
    return res.status(500).send(String(e.message || e));
  }
});

app.get('/auth/hubspot/status', requireAuth, (req, res) => {
  res.json({ connected: !!req.session?.hubspotTokens?.refreshToken || HAS_STATIC_HUBSPOT_TOKEN });
});

app.post('/auth/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/state', requireAuth, (req, res) => res.json(safeReadState()));
app.post('/api/state', requireAuth, (req, res) => { safeWriteState(req.body || {}); res.json({ ok: true }); });

app.post('/api/mcp-proxy', requireAuth, async (req, res) => {
  try {
    const { tool, args } = req.body || {};
    if (!tool) return res.status(400).json({ isError: true, error: 'missing_tool' });

    if (tool.includes('outlook_email_search')) {
      const token = await graphDelegatedToken(req);
      const mailbox = args?.mailboxOwnerEmail || 'support@quinta.im';
      const top = Math.min(Number(args?.limit || 20), 50);
      const select = '$select=id,subject,bodyPreview,from,toRecipients,receivedDateTime,webLink';
      const orderBy = '$orderby=receivedDateTime desc';
      const filter = args?.afterDateTime ? `&$filter=receivedDateTime ge ${new Date(args.afterDateTime).toISOString()}` : '';
      const data = await graphGet(`/users/${encodeURIComponent(mailbox)}/messages?$top=${top}&${select}&${orderBy}${filter}`, token);
      return res.json({ isError: false, structuredContent: (data.value || []).map(mapMessage) });
    }

    if (tool.includes('read_resource')) {
      const token = await graphDelegatedToken(req);
      const rawUri = args?.uri || '';
      const idMatch = rawUri.match(/mail:\/\/\/messages\/([^?]+)/);
      const msgId = idMatch?.[1];
      const ownerMatch = rawUri.match(/[?&]owner=([^&]+)/);
      const mailbox = ownerMatch?.[1] ? decodeURIComponent(ownerMatch[1]) : 'support@quinta.im';
      if (!msgId) return res.status(400).json({ isError: true, error: 'missing_message_id' });
      const msg = await graphGet(`/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(msgId)}?$select=body,bodyPreview`, token);
      return res.json({ isError: false, structuredContent: { body: { content: msg?.body?.content || '', contentType: msg?.body?.contentType || 'text' }, bodyPreview: msg?.bodyPreview || '' } });
    }

    if (tool.includes('search_crm_objects')) {
      const out = await hubspotSearch({ ...(args || {}), __req: req });
      return res.json({ isError: false, structuredContent: { results: out.results || [] } });
    }

    return res.status(400).json({ isError: true, error: 'unsupported_tool' });
  } catch (err) {
    return res.status(500).json({ isError: true, error: String(err.message || err) });
  }
});

app.use('/assets', requireAuth, express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => isAuthed(req) ? res.sendFile(path.join(__dirname, 'index.html')) : res.redirect('/login'));

app.listen(PORT, () => {
  console.log(`Support Kanban secure web app on http://localhost:${PORT}`);
  if (plainPassword === 'change-me-now' && !process.env.KANBAN_PASS_HASH) console.log('WARNING: set KANBAN_PASS and SESSION_SECRET before production use.');
});
