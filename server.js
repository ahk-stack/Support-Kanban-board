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
const TOKEN_STORE_PATH = path.join(__dirname, 'data', 'oauth-tokens.json');
const VERSIONS_DIR = path.join(__dirname, 'versions');
const MAX_BACKUPS = Number(process.env.STATE_BACKUP_KEEP || 50);
const BACKUP_MIN_INTERVAL_MS = Number(process.env.STATE_BACKUP_MIN_INTERVAL_MS || 60_000);

const USERNAME = process.env.KANBAN_USER || 'admin';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-session-secret';
const plainPassword = process.env.KANBAN_PASS || 'change-me-now';
const passwordHash = process.env.KANBAN_PASS_HASH || bcrypt.hashSync(plainPassword, 10);

const M365_TENANT_ID = process.env.M365_TENANT_ID || '';
const M365_CLIENT_ID = process.env.M365_CLIENT_ID || '';
const M365_CLIENT_SECRET = process.env.M365_CLIENT_SECRET || '';
const M365_REDIRECT_URI = process.env.M365_REDIRECT_URI || `http://localhost:${PORT}/auth/microsoft/callback`;
const SUPPORT_MAILBOX = String(process.env.SUPPORT_MAILBOX || 'helpdesk@quinta.im').trim().toLowerCase();
const HUBSPOT_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN || process.env.HUBSPOT_ACCESS_TOKEN || '';
const HAS_STATIC_HUBSPOT_TOKEN = !!HUBSPOT_TOKEN && HUBSPOT_TOKEN.startsWith('pat-');
const HUBSPOT_CLIENT_ID = process.env.HUBSPOT_CLIENT_ID || '';
const HUBSPOT_CLIENT_SECRET = process.env.HUBSPOT_CLIENT_SECRET || '';
const HUBSPOT_REDIRECT_URI = process.env.HUBSPOT_REDIRECT_URI || `http://localhost:${PORT}/auth/hubspot/callback`;
const HUBSPOT_SCOPES = process.env.HUBSPOT_SCOPES || 'crm.objects.contacts.read crm.objects.companies.read crm.objects.deals.read crm.objects.tickets.read crm.objects.owners.read cms.site_search.read';
const HUBSPOT_PKCE_CODE_VERIFIER = process.env.HUBSPOT_PKCE_CODE_VERIFIER || '';
const HUBSPOT_PKCE_CODE_CHALLENGE = process.env.HUBSPOT_PKCE_CODE_CHALLENGE || '';
const HUBSPOT_AUTHORIZE_BASE = process.env.HUBSPOT_AUTHORIZE_BASE || 'https://app.hubspot.com/oauth/authorize';
const HUBSPOT_TICKET_PIPELINE = String(process.env.HUBSPOT_TICKET_PIPELINE || '').trim();
const HUBSPOT_TICKET_STAGE = String(process.env.HUBSPOT_TICKET_STAGE || '').trim();
const HUBSPOT_TICKET_STAGE_NEW = String(process.env.HUBSPOT_TICKET_STAGE_NEW || HUBSPOT_TICKET_STAGE || '').trim();
const HUBSPOT_TICKET_STAGE_IN_PROGRESS = String(process.env.HUBSPOT_TICKET_STAGE_IN_PROGRESS || HUBSPOT_TICKET_STAGE || '').trim();
const HUBSPOT_TICKET_STAGE_WAITING_ON_US = String(process.env.HUBSPOT_TICKET_STAGE_WAITING_ON_US || HUBSPOT_TICKET_STAGE_IN_PROGRESS || HUBSPOT_TICKET_STAGE || '').trim();
const HUBSPOT_TICKET_STAGE_WAITING_ON_CONTACT = String(process.env.HUBSPOT_TICKET_STAGE_WAITING_ON_CONTACT || HUBSPOT_TICKET_STAGE_IN_PROGRESS || HUBSPOT_TICKET_STAGE || '').trim();
const HUBSPOT_TICKET_STAGE_RESOLVED = String(process.env.HUBSPOT_TICKET_STAGE_RESOLVED || process.env.HUBSPOT_TICKET_STAGE_CLOSED || '').trim();
const HUBSPOT_READ_SCOPE_SET = new Set(
  HUBSPOT_SCOPES
    .split(/\s+/)
    .map(s => s.trim())
    .filter(Boolean)
);
const HUBSPOT_ALLOWED_WRITE_SCOPES = new Set(
  String(process.env.HUBSPOT_ALLOWED_WRITE_SCOPES || 'tickets crm.objects.tickets.write')
    .split(/\s+/)
    .map(s => s.trim())
    .filter(Boolean)
);
const DATA_HYGIENE_CACHE_TTL_MS = Number(process.env.DATA_HYGIENE_CACHE_TTL_MS || 5 * 60 * 1000);
const DATA_HYGIENE_PAGE_DELAY_MS = Number(process.env.DATA_HYGIENE_PAGE_DELAY_MS || 250);
const DATA_HYGIENE_MAX_PAGES = Number(process.env.DATA_HYGIENE_MAX_PAGES || 30);
const DATA_HYGIENE_MAX_DURATION_MS = Number(process.env.DATA_HYGIENE_MAX_DURATION_MS || 25000);
const DATA_HYGIENE_MAX_ROWS = Number(process.env.DATA_HYGIENE_MAX_ROWS || 2500);
let dataHygieneCache = { generatedAt: 0, payload: null };

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
function safeReadTokenStore() {
  try {
    if (!fs.existsSync(TOKEN_STORE_PATH)) return {};
    return JSON.parse(fs.readFileSync(TOKEN_STORE_PATH, 'utf8')) || {};
  } catch { return {}; }
}
function safeWriteTokenStore(store) {
  const nextStore = (store && typeof store === 'object') ? store : {};
  fs.mkdirSync(path.dirname(TOKEN_STORE_PATH), { recursive: true });
  fs.writeFileSync(TOKEN_STORE_PATH, JSON.stringify(nextStore, null, 2), 'utf8');
}
function getPersistedM365Tokens() {
  const store = safeReadTokenStore();
  return store.m365Tokens || null;
}
function setPersistedM365Tokens(tokens) {
  const store = safeReadTokenStore();
  store.m365Tokens = tokens;
  safeWriteTokenStore(store);
}
function getPersistedHubspotTokens() {
  const store = safeReadTokenStore();
  return store.hubspotTokens || null;
}
function setPersistedHubspotTokens(tokens) {
  const store = safeReadTokenStore();
  store.hubspotTokens = tokens;
  safeWriteTokenStore(store);
}
function isReadOnlyHubspotScope(scope) {
  if (!scope || typeof scope !== 'string') return false;
  if (scope === 'oauth') return true;
  return scope.endsWith('.read');
}
function hasOnlyReadHubspotScopes(scopeStr) {
  const scopes = String(scopeStr || '')
    .split(/\s+/)
    .map(s => s.trim())
    .filter(Boolean);
  if (!scopes.length) return true;
  return scopes.every(isReadOnlyHubspotScope);
}
function isAllowedHubspotScope(scope) {
  if (!scope || typeof scope !== 'string') return false;
  if (scope === 'oauth') return true;
  if (scope.endsWith('.read')) return true;
  return HUBSPOT_ALLOWED_WRITE_SCOPES.has(scope);
}
function hasOnlyAllowedHubspotScopes(scopeStr) {
  const scopes = String(scopeStr || '')
    .split(/\s+/)
    .map(s => s.trim())
    .filter(Boolean);
  if (!scopes.length) return true;
  return scopes.every(isAllowedHubspotScope);
}
function writeBackupSnapshot(state) {
  fs.mkdirSync(VERSIONS_DIR, { recursive: true });
  const now = Date.now();
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(VERSIONS_DIR, `board-state-${stamp}.json`);
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf8');

  const files = fs.readdirSync(VERSIONS_DIR)
    .filter(name => /^board-state-.*\.json$/.test(name))
    .map(name => ({ name, fullPath: path.join(VERSIONS_DIR, name), mtime: fs.statSync(path.join(VERSIONS_DIR, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  files.slice(MAX_BACKUPS).forEach(file => {
    try { fs.unlinkSync(file.fullPath); } catch (_) {}
  });
}
function safeWriteState(state) {
  const nextState = (state && typeof state === 'object') ? state : {};
  const currentState = safeReadState();
  const currentMeta = currentState._meta || {};
  const incomingMeta = nextState._meta || {};
  const incomingVersion = Number(incomingMeta.clientVersion || 0);
  const currentVersion = Number(currentMeta.clientVersion || 0);
  const incomingSavedAt = Number(incomingMeta.clientSavedAt || 0);
  const currentSavedAt = Number(currentMeta.clientSavedAt || 0);

  if (incomingVersion < currentVersion) return { saved: false, reason: 'stale_version' };
  if (incomingVersion === currentVersion && incomingSavedAt < currentSavedAt) return { saved: false, reason: 'stale_timestamp' };

  const now = Date.now();
  const enrichedMeta = {
    ...incomingMeta,
    serverSavedAt: now
  };
  const finalState = { ...nextState, _meta: enrichedMeta };

  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  fs.writeFileSync(DATA_PATH, JSON.stringify(finalState, null, 2), 'utf8');

  const lastBackupAt = Number(currentMeta.lastBackupAt || 0);
  if (now - lastBackupAt >= BACKUP_MIN_INTERVAL_MS) {
    const withBackupMeta = { ...finalState, _meta: { ...enrichedMeta, lastBackupAt: now } };
    fs.writeFileSync(DATA_PATH, JSON.stringify(withBackupMeta, null, 2), 'utf8');
    writeBackupSnapshot(withBackupMeta);
    return { saved: true, backupCreated: true };
  }
  return { saved: true, backupCreated: false };
}

async function graphDelegatedToken(req) {
  const t = req.session?.m365Tokens || getPersistedM365Tokens();
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
  const refreshed = {
    accessToken: json.access_token,
    refreshToken: json.refresh_token || t.refreshToken,
    expiresAt: Date.now() + (json.expires_in || 3600) * 1000
  };
  req.session.m365Tokens = refreshed;
  setPersistedM365Tokens(refreshed);
  return refreshed.accessToken;
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

async function getHubspotAccessToken(req) {
  const sessionTokens = req?.session?.hubspotTokens;
  const persistedTokens = getPersistedHubspotTokens();
  const tokens = sessionTokens || persistedTokens;

  if (tokens?.accessToken && Date.now() < (tokens.expiresAt || 0) - 60_000) {
    return tokens.accessToken;
  }
  if (tokens?.refreshToken && HUBSPOT_CLIENT_ID && HUBSPOT_CLIENT_SECRET) {
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: HUBSPOT_CLIENT_ID,
      client_secret: HUBSPOT_CLIENT_SECRET,
      refresh_token: tokens.refreshToken
    });
    const refRes = await fetch('https://api.hubapi.com/oauth/v1/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form
    });
    if (refRes.ok) {
      const tk = await refRes.json();
      const refreshed = {
        accessToken: tk.access_token,
        refreshToken: tk.refresh_token || tokens.refreshToken,
        expiresAt: Date.now() + (tk.expires_in || 1800) * 1000
      };
      if (req?.session) req.session.hubspotTokens = refreshed;
      setPersistedHubspotTokens(refreshed);
      return refreshed.accessToken;
    }
  }
  if (HAS_STATIC_HUBSPOT_TOKEN) return HUBSPOT_TOKEN;
  throw new Error('hubspot_not_connected');
}

async function hubspotSearch(args) {
  const token = await getHubspotAccessToken(args.__req);
  const objectType = args.objectType;
  const associatedWith = (args?.filterGroups || []).flatMap(g => Array.isArray(g?.associatedWith) ? g.associatedWith : []);
  if (objectType === 'companies') {
    const contactAssoc = associatedWith.find(a => a?.objectType === 'contacts');
    const contactId = contactAssoc?.objectIds?.[0] || contactAssoc?.objectIdValues?.[0];
    if (contactId) {
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

async function hubspotListTicketPipelines(token) {
  const r = await fetch('https://api.hubapi.com/crm/v3/pipelines/tickets', {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`hubspot_ticket_pipelines_error_${r.status}:${txt.slice(0, 220)}`);
  }
  const j = await r.json();
  return Array.isArray(j?.results) ? j.results : [];
}

function pickDefaultTicketStage(pipeline) {
  const stages = Array.isArray(pipeline?.stages) ? pipeline.stages : [];
  if (!stages.length) return null;
  const openStage = stages.find(s => String(s?.metadata?.ticketState || '').toUpperCase() === 'OPEN');
  if (openStage) return openStage;
  const sorted = [...stages].sort((a, b) => {
    const da = Number(a?.displayOrder || 0);
    const db = Number(b?.displayOrder || 0);
    return da - db;
  });
  return sorted[0] || null;
}
function resolveHubspotStageByKanbanStatus(status) {
  const key = String(status || '').toLowerCase();
  if (key === 'resolved') return HUBSPOT_TICKET_STAGE_RESOLVED || HUBSPOT_TICKET_STAGE || '';
  if (key === 'waiting_on_contact') return HUBSPOT_TICKET_STAGE_WAITING_ON_CONTACT || HUBSPOT_TICKET_STAGE_IN_PROGRESS || HUBSPOT_TICKET_STAGE || '';
  if (key === 'waiting_on_us') return HUBSPOT_TICKET_STAGE_WAITING_ON_US || HUBSPOT_TICKET_STAGE_IN_PROGRESS || HUBSPOT_TICKET_STAGE || '';
  if (key === 'in_progress') return HUBSPOT_TICKET_STAGE_IN_PROGRESS || HUBSPOT_TICKET_STAGE || '';
  return HUBSPOT_TICKET_STAGE_NEW || HUBSPOT_TICKET_STAGE || '';
}

async function hubspotGetCompanyById(token, companyId, properties = []) {
  const qs = properties.length ? `?properties=${encodeURIComponent(properties.join(','))}` : '';
  const r = await fetch(`https://api.hubapi.com/crm/v3/objects/companies/${encodeURIComponent(companyId)}${qs}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!r.ok) return null;
  return r.json();
}

async function hubspotGetCompanyCompanyAssociations(token, companyId) {
  const r = await fetch(`https://api.hubapi.com/crm/v4/objects/companies/${encodeURIComponent(companyId)}/associations/companies`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!r.ok) return [];
  const j = await r.json();
  return (j.results || []).map(x => ({
    toCompanyId: String(x.toObjectId || x.toObjectId?.id || x.to?.id || x.id || ''),
    labels: (x.associationTypes || []).map(t => (t.label || t.type || '')).filter(Boolean)
  })).filter(x => x.toCompanyId);
}

async function hubspotGetOwnerById(token, ownerId) {
  const rid = String(ownerId || '').trim();
  if (!rid) return null;
  const tryUrls = [
    `https://api.hubapi.com/crm/v3/owners/${encodeURIComponent(rid)}`,
    `https://api.hubapi.com/crm/v3/owners/${encodeURIComponent(rid)}?idProperty=userId`,
    `https://api.hubapi.com/crm/v3/owners/${encodeURIComponent(rid)}?idProperty=id&archived=true`,
    `https://api.hubapi.com/crm/v3/owners/${encodeURIComponent(rid)}?idProperty=userId&archived=true`
  ];
  let j = null;
  for (const url of tryUrls) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) continue;
    j = await r.json();
    if (j?.id || j?.userId) break;
  }
  if (!j) return null;
  const firstName = String(j.firstName || '').trim();
  const lastName = String(j.lastName || '').trim();
  const fullName = [firstName, lastName].filter(Boolean).join(' ').trim();
  return {
    id: String(j.id || rid),
    userId: j.userId != null ? String(j.userId) : null,
    fullName: fullName || null,
    email: String(j.email || '').trim() || null
  };
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeForQuery(text) {
  const stop = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'your', 'you', 'are', 'was', 'were', 'but', 'not', 'can', 'cant', 'will', 'would', 'our', 'their', 'about', 'issue', 'error', 'ticket', 'support', 'please', 'thanks', 'thank']);
  const counts = new Map();
  String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 4 && !stop.has(w))
    .forEach(w => counts.set(w, (counts.get(w) || 0) + 1));
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([w]) => w).slice(0, 10);
}

function cleanHighlightedText(s) {
  return stripHtml(String(s || '').replace(/<\/?span[^>]*>/gi, ''));
}

async function graphGetMessageWithAttachments(token, mailbox, msgId) {
  const msg = await graphGet(`/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(msgId)}?$select=id,subject,body,bodyPreview,from,toRecipients,receivedDateTime,webLink,hasAttachments`, token);
  let attachments = [];
  if (msg?.hasAttachments) {
    const at = await graphGet(`/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(msgId)}/attachments?$top=15&$select=id,name,contentType,size,isInline,contentBytes`, token);
    attachments = Array.isArray(at?.value) ? at.value : [];
  }
  const attachmentFindings = [];
  const attachmentTextChunks = [];
  attachments.forEach(a => {
    const name = String(a?.name || 'attachment');
    const contentType = String(a?.contentType || '').toLowerCase();
    const size = Number(a?.size || 0);
    if (a?.isInline) return;
    if (contentType.startsWith('text/') || contentType.includes('json') || contentType.includes('xml') || contentType.includes('csv')) {
      try {
        const decoded = Buffer.from(String(a.contentBytes || ''), 'base64').toString('utf8');
        const clipped = decoded.slice(0, 12000);
        attachmentTextChunks.push(`Attachment ${name}: ${clipped}`);
        attachmentFindings.push(`${name} (${contentType || 'text'}) parsed`);
        return;
      } catch (_) {}
    }
    attachmentFindings.push(`${name} (${contentType || 'binary'}, ${size} bytes) detected but not fully parsable`);
  });
  const bodyType = String(msg?.body?.contentType || 'text').toLowerCase();
  const bodyText = bodyType === 'html' ? stripHtml(msg?.body?.content || '') : String(msg?.body?.content || msg?.bodyPreview || '');
  return { message: msg, bodyText, attachmentFindings, attachmentText: attachmentTextChunks.join('\n\n') };
}

async function hubspotSearchKnowledgeArticles(token, query, limit = 5) {
  const params = new URLSearchParams({
    q: query,
    type: 'KNOWLEDGE_ARTICLE',
    limit: String(Math.min(Math.max(Number(limit) || 5, 1), 10)),
    length: 'LONG'
  });
  const res = await fetch(`https://api.hubapi.com/cms/site-search/2026-03/search?${params.toString()}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`hubspot_kb_search_error_${res.status}:${txt.slice(0, 220)}`);
  }
  const data = await res.json();
  const results = Array.isArray(data?.results) ? data.results : [];
  return results.map(r => ({
    id: r.id,
    title: cleanHighlightedText(r.title || 'Untitled article'),
    description: cleanHighlightedText(r.description || ''),
    url: r.url || null,
    score: Number(r.score || 0)
  }));
}

function buildDebugProposal(context, kbArticles) {
  const summaryBase = `Issue analyzed from email subject "${context.subject || '(no subject)'}"${context.companyName ? ` for ${context.companyName}` : ''}.`;
  const steps = [];
  if (kbArticles.length) {
    const top = kbArticles[0];
    steps.push(`Review article "${top.title}" and apply the documented fix path first.`);
    if (top.description) steps.push(top.description.split(/(?<=[.!?])\s+/).slice(0, 2).join(' '));
    steps.push('Validate in staging/test flow, then request client confirmation with exact reproduction steps.');
  } else {
    steps.push('Reproduce the issue with the same inputs from the customer email.');
    steps.push('Check recent integration/authentication/config changes in the impacted system.');
    steps.push('Gather logs/screenshots and escalate with clear reproduction if issue persists.');
  }
  return { summary: summaryBase, steps: steps.filter(Boolean) };
}

async function hubspotListOwners(token) {
  const all = [];
  let after = null;
  for (let i = 0; i < 20; i++) {
    const qs = new URLSearchParams({ limit: '100', archived: 'true' });
    if (after) qs.set('after', String(after));
    const r = await fetch(`https://api.hubapi.com/crm/v3/owners?${qs.toString()}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!r.ok) break;
    const j = await r.json();
    const rows = Array.isArray(j.results) ? j.results : [];
    all.push(...rows);
    const next = j?.paging?.next?.after;
    if (!next) break;
    after = next;
  }
  return all.map(j => {
    const firstName = String(j.firstName || '').trim();
    const lastName = String(j.lastName || '').trim();
    const fullName = [firstName, lastName].filter(Boolean).join(' ').trim();
    return {
      id: String(j.id || ''),
      userId: j.userId != null ? String(j.userId) : null,
      fullName: fullName || null,
      email: String(j.email || '').trim() || null
    };
  }).filter(o => o.id || o.userId);
}

function firstNonEmptyValue(obj, keys) {
  for (const key of keys) {
    const v = obj?.[key];
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return '';
}

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

async function hubspotSearchCompaniesByPage(token, body) {
  const endpoint = 'https://api.hubapi.com/crm/v3/objects/companies/search';
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (res.ok) return res.json();

    const txt = await res.text();
    if (res.status === 429 && attempt < maxAttempts) {
      const retryAfterSec = Number(res.headers.get('retry-after') || 0);
      const waitMs = Math.max(retryAfterSec * 1000, 700 * attempt);
      await new Promise(resolve => setTimeout(resolve, waitMs));
      continue;
    }
    throw new Error(`hubspot_error_${res.status}:${txt.slice(0, 240)}`);
  }
}

async function collectCompaniesBySearch(token, properties, filterGroups, deadlineTs) {
  const rows = [];
  let after = null;
  const maxPages = Math.max(1, DATA_HYGIENE_MAX_PAGES);
  for (let i = 0; i < maxPages; i++) {
    if (Date.now() >= deadlineTs) break;
    const page = await hubspotSearchCompaniesByPage(token, {
      filterGroups,
      properties,
      sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
      limit: 100,
      after
    });
    const results = page.results || [];
    rows.push(...results);
    if (rows.length >= DATA_HYGIENE_MAX_ROWS) break;
    const nextAfter = page?.paging?.next?.after;
    if (!nextAfter) break;
    after = nextAfter;
    if (DATA_HYGIENE_PAGE_DELAY_MS > 0) {
      await new Promise(resolve => setTimeout(resolve, DATA_HYGIENE_PAGE_DELAY_MS));
    }
  }
  return rows;
}

app.get('/login', (req, res) => isAuthed(req) ? res.redirect('/') : res.type('html').sendFile(path.join(__dirname, 'public', 'login.html')));

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
    const tokens = {
      accessToken: tokenJson.access_token,
      refreshToken: tokenJson.refresh_token,
      expiresAt: Date.now() + (tokenJson.expires_in || 3600) * 1000
    };
    req.session.m365Tokens = tokens;
    setPersistedM365Tokens(tokens);
    delete req.session.m365State;
    return res.redirect('/');
  } catch (e) {
    return res.status(500).send(String(e.message || e));
  }
});

app.get('/auth/microsoft/status', requireAuth, (req, res) => {
  const connected = !!(req.session?.m365Tokens?.refreshToken || getPersistedM365Tokens()?.refreshToken);
  res.json({ connected });
});

app.get('/auth/hubspot/start', requireAuth, (req, res) => {
  if (!HUBSPOT_CLIENT_ID || !HUBSPOT_CLIENT_SECRET) return res.status(500).send('Missing HubSpot env vars.');
  const state = crypto.randomBytes(16).toString('hex');
  req.session.hubspotState = state;
  const usePkce = !!HUBSPOT_PKCE_CODE_VERIFIER && !!HUBSPOT_PKCE_CODE_CHALLENGE;
  const enforcedScopes = [...HUBSPOT_READ_SCOPE_SET].filter(isAllowedHubspotScope).join(' ');
  const useMcpUserAuthorize = HUBSPOT_AUTHORIZE_BASE.includes('/oauth/authorize/user');
  const params = new URLSearchParams({
    client_id: HUBSPOT_CLIENT_ID,
    redirect_uri: HUBSPOT_REDIRECT_URI,
    state
  });
  if (!useMcpUserAuthorize) {
    params.set('scope', enforcedScopes);
  }
  if (usePkce) {
    params.set('code_challenge', HUBSPOT_PKCE_CODE_CHALLENGE);
    params.set('code_challenge_method', 'S256');
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
    if (tokenJson.scope && !hasOnlyAllowedHubspotScopes(tokenJson.scope)) {
      return res.status(403).send(`HubSpot granted disallowed scope(s): ${tokenJson.scope || 'none'}`);
    }
    const tokens = {
      accessToken: tokenJson.access_token,
      refreshToken: tokenJson.refresh_token,
      expiresAt: Date.now() + (tokenJson.expires_in || 1800) * 1000
    };
    req.session.hubspotTokens = tokens;
    setPersistedHubspotTokens(tokens);
    delete req.session.hubspotState;
    return res.redirect('/');
  } catch (e) {
    return res.status(500).send(String(e.message || e));
  }
});

app.get('/auth/hubspot/status', requireAuth, (req, res) => {
  const connected = !!(req.session?.hubspotTokens?.refreshToken || getPersistedHubspotTokens()?.refreshToken || HAS_STATIC_HUBSPOT_TOKEN);
  res.json({ connected });
});

app.post('/auth/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/state', requireAuth, (req, res) => res.json(safeReadState()));
app.post('/api/state', requireAuth, (req, res) => {
  const result = safeWriteState(req.body || {});
  res.json({ ok: !!result.saved, ...result });
});

app.post('/api/hubspot/companies/:companyId/custom-property', requireAuth, async (req, res) => {
  try {
    const token = await getHubspotAccessToken(req);
    const companyId = String(req.params.companyId || '').trim();
    const rawName = String(req.body?.name || '').trim();
    const label = String(req.body?.label || rawName).trim();
    const value = String(req.body?.value ?? '').trim();
    const createDefinition = !!req.body?.createDefinition;

    if (!companyId || !rawName || !value) return res.status(400).json({ error: 'missing_company_or_property' });
    const name = rawName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    if (createDefinition) {
      const defRes = await fetch('https://api.hubapi.com/crm/v3/properties/companies', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          groupName: 'companyinformation',
          name,
          label,
          type: 'string',
          fieldType: 'text'
        })
      });
      if (!defRes.ok && defRes.status !== 409) {
        const txt = await defRes.text();
        return res.status(defRes.status).json({ error: `create_property_definition_failed:${txt.slice(0, 300)}` });
      }
    }

    const updRes = await fetch(`https://api.hubapi.com/crm/v3/objects/companies/${encodeURIComponent(companyId)}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ properties: { [name]: value } })
    });
    if (!updRes.ok) {
      const txt = await updRes.text();
      return res.status(updRes.status).json({ error: `update_company_property_failed:${txt.slice(0, 300)}` });
    }
    return res.json({ ok: true, property: name, value });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
});

app.get('/api/hubspot/companies/:companyId/network', requireAuth, async (req, res) => {
  try {
    const token = await getHubspotAccessToken(req);
    const companyId = String(req.params.companyId || '').trim();
    if (!companyId) return res.status(400).json({ error: 'missing_company_id' });

    const baseProps = ['name', 'country', 'co_owner', 'co-owner', 'coowner', 'co_owner_name', 'cs_owner', 'customer_success_owner', 'parent_company_id'];
    const company = await hubspotGetCompanyById(token, companyId, baseProps);
    if (!company) return res.status(404).json({ error: 'company_not_found' });

    const props = company.properties || {};
    const parentCompanyId = props.parent_company_id || null;

    let parentCompany = null;
    if (parentCompanyId) {
      const parent = await hubspotGetCompanyById(token, parentCompanyId, baseProps);
      if (parent) {
        parentCompany = {
          id: String(parent.id),
          name: parent.properties?.name || null,
          country: parent.properties?.country || null,
          coOwner: parent.properties?.co_owner || parent.properties?.['co-owner'] || parent.properties?.coowner || parent.properties?.co_owner_name || parent.properties?.cs_owner || parent.properties?.customer_success_owner || null
        };
      }
    }

    const childrenRes = await fetch('https://api.hubapi.com/crm/v3/objects/companies/search', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: 'parent_company_id', operator: 'EQ', value: String(companyId) }] }],
        properties: baseProps,
        limit: 100
      })
    });
    const childrenJson = childrenRes.ok ? await childrenRes.json() : { results: [] };
    const childCompanies = (childrenJson.results || []).map(c => ({
      id: String(c.id),
      name: c.properties?.name || null,
      country: c.properties?.country || null,
      coOwner: c.properties?.co_owner || c.properties?.['co-owner'] || c.properties?.coowner || c.properties?.co_owner_name || c.properties?.cs_owner || c.properties?.customer_success_owner || null
    }));

    const labeledAssociations = await hubspotGetCompanyCompanyAssociations(token, companyId);
    const assocCompanyIds = [...new Set(labeledAssociations.map(a => a.toCompanyId).filter(Boolean))];
    let associatedCompanies = [];
    if (assocCompanyIds.length) {
      const assocBatch = await fetch('https://api.hubapi.com/crm/v3/objects/companies/batch/read', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inputs: assocCompanyIds.map(id => ({ id })),
          properties: baseProps
        })
      });
      if (assocBatch.ok) {
        const assocBatchJson = await assocBatch.json();
        const byId = Object.fromEntries((assocBatchJson.results || []).map(c => [String(c.id), c]));
        associatedCompanies = assocCompanyIds.map(id => {
          const c = byId[id];
          const labels = labeledAssociations.find(x => x.toCompanyId === id)?.labels || [];
          return {
            id,
            name: c?.properties?.name || null,
            country: c?.properties?.country || null,
            coOwner: c?.properties?.co_owner || c?.properties?.['co-owner'] || c?.properties?.coowner || c?.properties?.co_owner_name || c?.properties?.cs_owner || c?.properties?.customer_success_owner || null,
            labels
          };
        });
      }
    }

    const assocContactsRes = await fetch(`https://api.hubapi.com/crm/v3/objects/companies/${encodeURIComponent(companyId)}/associations/contacts`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const assocContactsJson = assocContactsRes.ok ? await assocContactsRes.json() : { results: [] };
    const contactIds = (assocContactsJson.results || []).map(x => x.id).filter(Boolean);
    let contacts = [];
    if (contactIds.length) {
      const batchRes = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/batch/read', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inputs: contactIds.map(id => ({ id })),
          properties: ['firstname', 'lastname', 'email']
        })
      });
      if (batchRes.ok) {
        const batchJson = await batchRes.json();
        contacts = (batchJson.results || []).map(c => ({
          id: String(c.id),
          name: [c.properties?.firstname, c.properties?.lastname].filter(Boolean).join(' ') || c.properties?.email || String(c.id),
          email: c.properties?.email || null
        }));
      }
    }

    return res.json({
      ok: true,
      company: {
        id: String(company.id),
        name: props.name || null,
        country: props.country || null,
        coOwner: props.co_owner || props['co-owner'] || props.coowner || props.co_owner_name || props.cs_owner || props.customer_success_owner || null,
        parentCompanyId: parentCompanyId ? String(parentCompanyId) : null
      },
      parentCompany,
      childCompanies,
      associatedCompanies,
      contacts
    });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
});

app.get('/api/hubspot/owners/resolve', requireAuth, async (req, res) => {
  try {
    const idsRaw = String(req.query.ids || '').split(',').map(x => x.trim()).filter(Boolean);
    const ids = [...new Set(idsRaw)].slice(0, 50);
    if (!ids.length) return res.json({ ok: true, owners: [] });
    const token = await getHubspotAccessToken(req);
    const owners = [];
    const unresolved = new Set(ids);
    for (const id of ids) {
      const owner = await hubspotGetOwnerById(token, id);
      if (owner) {
        owners.push(owner);
        unresolved.delete(String(owner.id || ''));
        if (owner.userId) unresolved.delete(String(owner.userId));
        if (owner.userId && owner.userId !== owner.id) {
          owners.push({ ...owner, id: owner.userId });
        }
      }
    }

    if (unresolved.size) {
      const listed = await hubspotListOwners(token);
      const byAnyId = new Map();
      listed.forEach(o => {
        if (o.id) byAnyId.set(String(o.id), o);
        if (o.userId) byAnyId.set(String(o.userId), o);
      });
      unresolved.forEach(id => {
        const o = byAnyId.get(String(id));
        if (!o) return;
        owners.push({ ...o, id: String(id) });
      });
    }

    return res.json({ ok: true, owners });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
});

app.get('/api/hubspot/data-hygiene', requireAuth, async (req, res) => {
  try {
    const force = String(req.query.force || '').toLowerCase() === '1';
    if (!force && dataHygieneCache.payload && (Date.now() - dataHygieneCache.generatedAt) < DATA_HYGIENE_CACHE_TTL_MS) {
      return res.json(dataHygieneCache.payload);
    }

    const token = await getHubspotAccessToken(req);
    const deadlineTs = Date.now() + DATA_HYGIENE_MAX_DURATION_MS;
    const properties = [
      'name',
      'domain',
      'lifecyclestage',
      'parent_company_id',
      'num_child_companies',
      'num_associated_contacts',
      'num_associated_deals',
      'hubspot_owner_id',
      'am_owner',
      'am',
      'account_manager',
      'co_owner',
      'co-owner',
      'coowner',
      'co_owner_name',
      'cs_owner',
      'customer_success_owner',
      'contract_signature_date',
      'contract_signed_date',
      'contract_sign_date',
      'signature_date'
    ];

    let rows = await collectCompaniesBySearch(token, properties, [
      { filters: [{ propertyName: 'num_associated_contacts', operator: 'GT', value: '0' }] }
    ], deadlineTs);
    let linkedRuleUsed = 'num_associated_contacts > 0';
    if (!rows.length && Date.now() < deadlineTs) {
      rows = await collectCompaniesBySearch(token, properties, [
        { filters: [{ propertyName: 'num_associated_deals', operator: 'GT', value: '0' }] }
      ], deadlineTs);
      linkedRuleUsed = 'num_associated_deals > 0';
    }
    if (!rows.length && Date.now() < deadlineTs) {
      rows = await collectCompaniesBySearch(token, properties, [
        { filters: [{ propertyName: 'lifecyclestage', operator: 'IN', values: ['customer', 'opportunity'] }] }
      ], deadlineTs);
      linkedRuleUsed = 'lifecyclestage IN (customer, opportunity)';
    }

    const portalBase = 'https://app.hubspot.com/contacts/25445053/record/0-2/';
    const byDomain = new Map();
    const byName = new Map();
    const ownerMismatch = [];
    const missingContractDate = [];
    const noDealParentOrMonohotel = [];

    const contractCandidates = ['contract_signature_date', 'contract_signed_date', 'contract_sign_date', 'signature_date'];
    const contractHits = Object.fromEntries(contractCandidates.map(k => [k, 0]));

    const normalizedRows = rows.map(r => {
      const p = r.properties || {};
      const id = String(r.id || '');
      const name = String(p.name || '').trim();
      const domain = String(p.domain || '').trim().toLowerCase();
      const amOwner = firstNonEmptyValue(p, ['am_owner', 'account_manager', 'am', 'hubspot_owner_id']);
      const csOwner = firstNonEmptyValue(p, ['co_owner', 'co-owner', 'coowner', 'co_owner_name', 'cs_owner', 'customer_success_owner']);
      const parentCompanyId = String(p.parent_company_id || '').trim();
      const childCount = Number(p.num_child_companies || 0);
      const dealCount = Number(p.num_associated_deals || 0);
      const contractKey = contractCandidates.find(k => String(p[k] || '').trim()) || '';
      const contractValue = contractKey ? String(p[contractKey] || '').trim() : '';
      if (contractKey) contractHits[contractKey] += 1;

      return {
        id,
        name,
        domain,
        amOwner,
        csOwner,
        lifecycleStage: String(p.lifecyclestage || '').trim(),
        contractKey,
        contractValue,
        parentCompanyId,
        childCount,
        dealCount,
        url: `${portalBase}${encodeURIComponent(id)}`
      };
    });

    for (const r of normalizedRows) {
      if (r.domain) {
        if (!byDomain.has(r.domain)) byDomain.set(r.domain, []);
        byDomain.get(r.domain).push(r);
      }
      const nn = normalizeName(r.name);
      if (nn) {
        if (!byName.has(nn)) byName.set(nn, []);
        byName.get(nn).push(r);
      }
      const hasAm = !!r.amOwner;
      const hasCs = !!r.csOwner;
      if ((hasAm && !hasCs) || (!hasAm && hasCs)) ownerMismatch.push(r);
      if (!r.contractValue) missingContractDate.push(r);
      const isParent = r.childCount > 0;
      const isChild = !!r.parentCompanyId;
      const isMonohotel = !isParent && !isChild;
      if ((isParent || isMonohotel) && r.dealCount <= 0) {
        noDealParentOrMonohotel.push({ ...r, companyType: isParent ? 'parent' : 'monohotel' });
      }
    }

    const duplicates = [];
    for (const [domain, group] of byDomain.entries()) {
      if (group.length > 1) {
        group.forEach(r => duplicates.push({ ...r, duplicateReason: `domain:${domain}`, duplicateGroupSize: group.length }));
      }
    }
    for (const [nname, group] of byName.entries()) {
      if (group.length > 1) {
        const alreadyById = new Set(duplicates.map(d => d.id));
        group.forEach(r => {
          if (!alreadyById.has(r.id)) duplicates.push({ ...r, duplicateReason: `name:${nname}`, duplicateGroupSize: group.length });
        });
      }
    }

    const selectedContractProperty = Object.entries(contractHits).sort((a, b) => b[1] - a[1])[0]?.[0] || contractCandidates[0];
    const payload = {
      ok: true,
      generatedAt: new Date().toISOString(),
      constraints: {
        clientLinkedOnly: true,
        clientLinkedDefinition: linkedRuleUsed
      },
      totals: {
        companiesScanned: normalizedRows.length,
        duplicates: duplicates.length,
        ownerMismatch: ownerMismatch.length,
        missingContractDate: missingContractDate.length,
        noDealParentOrMonohotel: noDealParentOrMonohotel.length
      },
      meta: {
        selectedContractProperty,
        partial: Date.now() >= deadlineTs || normalizedRows.length >= DATA_HYGIENE_MAX_ROWS
      },
      rows: {
        duplicates,
        ownerMismatch,
        missingContractDate,
        noDealParentOrMonohotel
      }
    };
    dataHygieneCache = { generatedAt: Date.now(), payload };
    return res.json(payload);
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
});

app.post('/api/debug-expert', requireAuth, async (req, res) => {
  try {
    const payload = req.body || {};
    const ticketId = String(payload.ticketId || '').trim();
    const email = payload.email || {};
    if (!ticketId || !email?.uri) return res.status(400).json({ error: 'missing_ticket_email_context' });

    const idMatch = String(email.uri || '').match(/mail:\/\/\/messages\/([^?]+)/);
    const msgId = idMatch?.[1];
    if (!msgId) return res.status(400).json({ error: 'missing_message_id' });

    const mailbox = SUPPORT_MAILBOX;
    const graphToken = await graphDelegatedToken(req);
    const detailed = await graphGetMessageWithAttachments(graphToken, mailbox, msgId);

    const baseText = [
      String(email.subject || ''),
      String(email.summary || ''),
      String(detailed.bodyText || ''),
      String(detailed.attachmentText || '')
    ].join('\n');
    const queryTerms = tokenizeForQuery(baseText);
    const kbQuery = queryTerms.slice(0, 8).join(' ') || String(email.subject || '').trim() || 'support issue';

    const hubspotToken = await getHubspotAccessToken(req);
    let kbArticles = [];
    try {
      kbArticles = await hubspotSearchKnowledgeArticles(hubspotToken, kbQuery, 6);
    } catch (_) {
      kbArticles = [];
    }

    const proposal = buildDebugProposal({
      subject: email.subject || detailed?.message?.subject || '',
      companyName: payload.companyName || null
    }, kbArticles);

    return res.json({
      ticketId,
      queryUsed: kbQuery,
      summary: proposal.summary,
      steps: proposal.steps,
      articles: kbArticles.slice(0, 5),
      attachmentFindings: detailed.attachmentFindings || []
    });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
});

app.get('/api/hubspot/tickets/pipelines', requireAuth, async (req, res) => {
  try {
    const token = await getHubspotAccessToken(req);
    const pipelines = await hubspotListTicketPipelines(token);
    return res.json({
      pipelines: pipelines.map(p => ({
        id: String(p.id || ''),
        label: p.label || '',
        stages: (Array.isArray(p.stages) ? p.stages : []).map(s => ({
          id: String(s.id || ''),
          label: s.label || '',
          displayOrder: Number(s.displayOrder || 0)
        }))
      }))
    });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
});

app.post('/api/hubspot/tickets/sync', requireAuth, async (req, res) => {
  try {
    const token = await getHubspotAccessToken(req);
    const {
      kanbanTicketId,
      companyId,
      subject,
      description,
      priority,
      category,
      receivedAt,
      assignee,
      kanbanStatus
    } = req.body || {};
    if (!kanbanTicketId) return res.status(400).json({ error: 'missing_kanban_ticket_id' });
    if (!companyId) return res.status(400).json({ error: 'missing_company_id' });

    const hsPriority = (() => {
      const p = String(priority || '').toLowerCase();
      if (p === 'high') return 'HIGH';
      if (p === 'low') return 'LOW';
      return 'MEDIUM';
    })();
    // Prefer explicit env values first so user-level OAuth tokens don't need pipeline discovery permission.
    let pipelineId = HUBSPOT_TICKET_PIPELINE || '';
    let stageId = resolveHubspotStageByKanbanStatus(kanbanStatus) || '';
    if (!pipelineId || !stageId) {
      try {
        const pipelines = await hubspotListTicketPipelines(token);
        const selectedPipeline = (() => {
          if (pipelineId) {
            const byEnv = pipelines.find(p => String(p?.id || '') === pipelineId);
            if (byEnv) return byEnv;
          }
          const def = pipelines.find(p => p?.default === true);
          return def || pipelines[0] || null;
        })();
        pipelineId = pipelineId || (selectedPipeline?.id ? String(selectedPipeline.id) : '');
        if (!stageId) {
          const fallbackStage = selectedPipeline ? pickDefaultTicketStage(selectedPipeline) : null;
          stageId = fallbackStage?.id ? String(fallbackStage.id) : '';
        }
      } catch (e) {
        const msg = String(e?.message || e || '');
        if (msg.includes('hubspot_ticket_pipelines_error_403')) {
          // Last-resort fallback for user-level OAuth restrictions.
          pipelineId = pipelineId || '0';
          stageId = stageId || '1';
        } else {
          throw e;
        }
      }
    }
    if (!pipelineId || !stageId) {
      return res.status(400).json({ error: 'hubspot_ticket_pipeline_stage_not_resolved_set_HUBSPOT_TICKET_PIPELINE_and_HUBSPOT_TICKET_STAGE' });
    }

    const content = [
      `Created by Support Kanban`,
      `Kanban ticket: ${kanbanTicketId}`,
      assignee ? `Assigned agent: ${assignee}` : null,
      category ? `Category: ${category}` : null,
      receivedAt ? `Received: ${receivedAt}` : null,
      '',
      String(description || '').trim()
    ].filter(Boolean).join('\n');

    const createPayload = {
      properties: {
        subject: String(subject || `Support ticket ${kanbanTicketId}`).slice(0, 255),
        content: content.slice(0, 60000),
        hs_ticket_priority: hsPriority,
        hs_pipeline: pipelineId,
        hs_pipeline_stage: stageId
      }
    };

    const createRes = await fetch('https://api.hubapi.com/crm/v3/objects/tickets', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(createPayload)
    });
    let created = null;
    let createErrorText = '';
    if (!createRes.ok) {
      createErrorText = await createRes.text();
    } else {
      created = await createRes.json();
    }

    // Fallback for portals/apps using legacy `tickets` scope behavior (only for scope/permission style failures).
    const shouldTryLegacyFallback = !created?.id && /scope|forbidden|unauthorized|oauth|permission|MISSING_SCOPES/i.test(createErrorText || '');
    if (!created?.id && shouldTryLegacyFallback) {
      const legacyPayload = {
        properties: [
          { name: 'subject', value: String(subject || `Support ticket ${kanbanTicketId}`).slice(0, 255) },
          { name: 'content', value: content.slice(0, 60000) },
          { name: 'hs_ticket_priority', value: hsPriority },
          { name: 'hs_pipeline', value: pipelineId },
          { name: 'hs_pipeline_stage', value: stageId }
        ],
        associations: {
          associatedCompanyIds: [Number(companyId)].filter(n => Number.isFinite(n))
        }
      };
      const legacyRes = await fetch('https://api.hubapi.com/crm-objects/v1/objects/tickets', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(legacyPayload)
      });
      if (!legacyRes.ok) {
        const legacyTxt = await legacyRes.text();
        return res.status(legacyRes.status).json({
          error: `hubspot_ticket_create_failed_v3:${createErrorText.slice(0, 240)} | legacy:${legacyTxt.slice(0, 240)}`
        });
      }
      const legacyCreated = await legacyRes.json().catch(() => ({}));
      const legacyId = legacyCreated?.objectId || legacyCreated?.id || null;
      if (!legacyId) {
        return res.status(500).json({ error: 'hubspot_ticket_create_failed_legacy_missing_id' });
      }
      return res.json({
        ok: true,
        kanbanTicketId: String(kanbanTicketId),
        hubspotTicketId: String(legacyId),
        hubspotTicketUrl: `https://app.hubspot.com/contacts/25445053/record/0-5/${legacyId}`
      });
    } else if (!created?.id) {
      return res.status(createRes.status || 400).json({ error: `hubspot_ticket_create_failed_v3:${(createErrorText || '').slice(0, 280)}` });
    }

    const assocRes = await fetch(`https://api.hubapi.com/crm/v4/objects/tickets/${encodeURIComponent(created.id)}/associations/default/companies/${encodeURIComponent(companyId)}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!assocRes.ok) {
      const txt = await assocRes.text();
      return res.status(assocRes.status).json({ error: `hubspot_ticket_association_failed:${txt.slice(0, 280)}` });
    }
    return res.json({
      ok: true,
      kanbanTicketId: String(kanbanTicketId),
      hubspotTicketId: String(created.id),
      hubspotTicketUrl: `https://app.hubspot.com/contacts/25445053/record/0-5/${created.id}`
    });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
});

app.patch('/api/hubspot/tickets/:ticketId/status', requireAuth, async (req, res) => {
  try {
    const token = await getHubspotAccessToken(req);
    const ticketId = String(req.params.ticketId || '').trim();
    const kanbanStatus = String(req.body?.kanbanStatus || '').trim().toLowerCase();
    if (!ticketId) return res.status(400).json({ error: 'missing_ticket_id' });
    if (!kanbanStatus) return res.status(400).json({ error: 'missing_kanban_status' });

    const stageId = resolveHubspotStageByKanbanStatus(kanbanStatus);
    if (!stageId) return res.status(400).json({ error: 'missing_hubspot_stage_mapping_for_status' });

    const updateRes = await fetch(`https://api.hubapi.com/crm/v3/objects/tickets/${encodeURIComponent(ticketId)}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        properties: {
          hs_pipeline_stage: stageId
        }
      })
    });
    if (!updateRes.ok) {
      const txt = await updateRes.text();
      return res.status(updateRes.status).json({ error: `hubspot_ticket_status_update_failed:${txt.slice(0, 280)}` });
    }
    return res.json({ ok: true, ticketId, kanbanStatus, stageId });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
});

app.post('/api/mcp-proxy', requireAuth, async (req, res) => {
  try {
    const { tool, args } = req.body || {};
    if (!tool) return res.status(400).json({ isError: true, error: 'missing_tool' });

    if (tool.includes('outlook_email_search')) {
      const token = await graphDelegatedToken(req);
      const mailbox = args?.mailboxOwnerEmail || SUPPORT_MAILBOX;
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
      const mailbox = ownerMatch?.[1] ? decodeURIComponent(ownerMatch[1]) : SUPPORT_MAILBOX;
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
app.get('/', (req, res) => isAuthed(req) ? res.type('html').sendFile(path.join(__dirname, 'index.html')) : res.redirect('/login'));

app.listen(PORT, () => {
  console.log(`Support Kanban secure web app on http://localhost:${PORT}`);
  if (plainPassword === 'change-me-now' && !process.env.KANBAN_PASS_HASH) console.log('WARNING: set KANBAN_PASS and SESSION_SECRET before production use.');
});
