require('dotenv').config();
const prisma = require('./prismaClient');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA_PATH = path.join(__dirname, 'data', 'board-state.json');
const TOKEN_STORE_PATH = path.join(__dirname, 'data', 'oauth-tokens.json');
const VERSIONS_DIR = path.join(__dirname, 'versions');
const AVATAR_UPLOAD_DIR = path.join(__dirname, 'public', 'uploads', 'avatars');
const MAX_BACKUPS = Number(process.env.STATE_BACKUP_KEEP || 50);
const BACKUP_MIN_INTERVAL_MS = Number(process.env.STATE_BACKUP_MIN_INTERVAL_MS || 60_000);
const RESOLVED_RETENTION_MS = Number(process.env.RESOLVED_RETENTION_MS || 72 * 60 * 60 * 1000);

//const USERNAME = process.env.KANBAN_USER || 'admin';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-session-secret';
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = NODE_ENV === 'production';
//const plainPassword = process.env.KANBAN_PASS || 'change-me-now';
//const passwordHash = process.env.KANBAN_PASS_HASH || bcrypt.hashSync(plainPassword, 10);

const M365_TENANT_ID = process.env.M365_TENANT_ID || '';
const M365_CLIENT_ID = process.env.M365_CLIENT_ID || '';
const M365_CLIENT_SECRET = process.env.M365_CLIENT_SECRET || '';
const M365_REDIRECT_URI = process.env.M365_REDIRECT_URI || `http://localhost:${PORT}/auth/microsoft/callback`;
// Chat.Create/Chat.ReadWrite/User.ReadBasic.All intentionally excluded:
// they're only needed by graphSendTeamsDirectMessage() (via
// graphFindUserByEmail(), which looks up other users), and nothing currently
// calls that function - Resolved notifications go through the Power Automate
// webhook instead. Requesting them anyway forced an admin-consent prompt for
// permissions the app never actually uses.
const M365_SCOPES = String(process.env.M365_SCOPES || 'offline_access openid profile email User.Read Mail.Read Mail.Read.Shared').trim();
const SUPPORT_MAILBOX = String(process.env.SUPPORT_MAILBOX || 'helpdesk@quinta.im').trim().toLowerCase();
const CONFIGURED_APP_BASE_URL = String(process.env.APP_BASE_URL || process.env.PUBLIC_BASE_URL || '').trim();
const APP_BASE_URL = String(CONFIGURED_APP_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
// Teams "Resolved" alerts always link to prod, regardless of which
// environment actually triggered the resolve - preprod is a test
// environment, so a real DM's "View ticket" link should still point
// somewhere real rather than a preprod/localhost URL nobody outside testing
// can use.
const RESOLVED_ALERT_APP_URL = String(process.env.RESOLVED_ALERT_APP_URL || 'https://support-dash.quinta.im').replace(/\/+$/, '');
const PASSWORD_RESET_TTL_MS = Number(process.env.PASSWORD_RESET_TTL_MS || 60 * 60 * 1000);
const HUBSPOT_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN || process.env.HUBSPOT_ACCESS_TOKEN || '';
const HAS_STATIC_HUBSPOT_TOKEN = !!HUBSPOT_TOKEN && HUBSPOT_TOKEN.startsWith('pat-');
const HUBSPOT_CLIENT_ID = process.env.HUBSPOT_CLIENT_ID || '';
const HUBSPOT_CLIENT_SECRET = process.env.HUBSPOT_CLIENT_SECRET || '';
const HUBSPOT_REDIRECT_URI = process.env.HUBSPOT_REDIRECT_URI || `http://localhost:${PORT}/auth/hubspot/callback`;
// Must match exactly what's configured as "Required scopes" on the HubSpot
// app (developer dashboard > Auth tab) - HubSpot rejects the OAuth request
// outright if it includes a scope the app isn't configured for. Hardcoded
// on purpose, ignoring any HUBSPOT_SCOPES env var: this is tied to a single
// fixed HubSpot app registration (same client ID across environments), not
// something that should vary by deploy target, and a stale env var value in
// one environment's config (cms.site_search.read isn't a real scope on this
// app, and its tickets-read scope is just called "tickets") previously broke
// the preprod HubSpot connection despite this file already having the fix.
const HUBSPOT_SCOPES = 'crm.objects.companies.read crm.objects.contacts.read crm.objects.custom.read crm.objects.deals.read crm.objects.leads.read crm.objects.line_items.read crm.objects.owners.read crm.objects.products.read crm.objects.quotes.read crm.objects.users.read crm.schemas.companies.read crm.schemas.contacts.read crm.schemas.custom.read crm.schemas.deals.read oauth settings.users.read tickets';
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
const DATA_HYGIENE_CACHE_TTL_MS = Number(process.env.DATA_HYGIENE_CACHE_TTL_MS || 15 * 60 * 1000);
const DATA_HYGIENE_PAGE_DELAY_MS = Number(process.env.DATA_HYGIENE_PAGE_DELAY_MS || 0);
const DATA_HYGIENE_MAX_PAGES = Number(process.env.DATA_HYGIENE_MAX_PAGES || 30);
const DATA_HYGIENE_MAX_DURATION_MS = Number(process.env.DATA_HYGIENE_MAX_DURATION_MS || 25000);
const DATA_HYGIENE_MAX_ROWS = Number(process.env.DATA_HYGIENE_MAX_ROWS || 2500);
const JIRA_BASE_URL = process.env.JIRA_BASE_URL || process.env.JIRA_SITE_URL || '';
const JIRA_EMAIL = process.env.JIRA_EMAIL || process.env.JIRA_USER_EMAIL || '';
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN || '';
const JIRA_PROJECT_KEY = process.env.JIRA_PROJECT_KEY || '';
const JIRA_ISSUE_TYPE = process.env.JIRA_ISSUE_TYPE || 'Task';
const TEAMS_EMAIL_DOMAIN = String(process.env.TEAMS_EMAIL_DOMAIN || 'quinta.im').trim().toLowerCase();
const TEAMS_FALLBACK_EMAIL_DOMAIN = String(process.env.TEAMS_FALLBACK_EMAIL_DOMAIN || 'quicktext.im').trim().toLowerCase();
const POWER_AUTOMATE_RESOLVED_WEBHOOK_URL = String(
  process.env.POWER_AUTOMATE_RESOLVED_WEBHOOK_URL ||
  'https://default4935953b2a5348c5a7058375353406.fe.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/82dd97cb52864fb7ba392d2c0ff8af03/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=ugz4djfxnx2cVHj6utkxm6WMAy1VIjWRjy4uAwCeC-Y'
).trim();
const RESOLVED_ALERT_COPY_EMAIL = String(process.env.RESOLVED_ALERT_COPY_EMAIL || 'ahk@quinta.im').trim().toLowerCase();
const CS_TEAMS_EMAIL_OVERRIDES = (() => {
  const raw = String(process.env.CS_TEAMS_EMAIL_OVERRIDES || '').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [String(k || '').trim().toUpperCase(), String(v || '').trim().toLowerCase()]).filter(([k, v]) => k && v));
  } catch (_) {
    return {};
  }
})();
const SUPPORT_AGENT_CODES = new Set(['SGU','ZIO','SFA','MEZ','SHE','JBA','RMD']);
const CS_AGENT_CODES = new Set(['VGU','NAO','MBH','TBR','IBE','SKE','BKH','JAT','VPO','RKH','AZA','GGO','WPH','JFC']);

const APP_BUILD_VERSION = (
  process.env.RENDER_GIT_COMMIT ||
  process.env.RAILWAY_GIT_COMMIT_SHA ||
  process.env.VERCEL_GIT_COMMIT_SHA ||
  process.env.GIT_COMMIT ||
  'local-dev'
).slice(0, 7);
let dataHygieneCache = { generatedAt: 0, payload: null };
let dataHygieneBuildPromise = null;

app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : 0);
app.disable('x-powered-by');

if (IS_PRODUCTION && SESSION_SECRET === 'change-this-session-secret') {
  throw new Error('Refusing to start in production with the default SESSION_SECRET.');
}

// script-src/style-src keep 'unsafe-inline' - this app relies on inline
// <script> blocks across many server-rendered pages (login, profile,
// reset-password, admin/users, index.html itself), and removing that would
// need a much larger nonce-based refactor that isn't safe to attempt
// untested right before a prod deploy. The other directives (object-src,
// base-uri, frame-ancestors) are free wins with zero behavior change.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      connectSrc: ["'self'", 'https:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'self'"],
      // Helmet's default 'form-action' self would otherwise block the
      // OAuth consent form's redirect back to the client's redirect_uri
      // (e.g. claude.ai) - form-action applies to the whole redirect chain
      // a submission triggers, not just the form's own declared action.
      // That redirect is already strictly validated server-side (exact
      // match against what the client registered), so this is safe to
      // leave unrestricted rather than trying to allowlist arbitrary
      // per-client hosts here.
      formAction: null
    }
  }
}));
app.use(express.json({ limit: '25mb' }));
// Needed for the OAuth consent form POST and the token endpoint, which per
// RFC 6749 is submitted as application/x-www-form-urlencoded.
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
fs.mkdirSync(AVATAR_UPLOAD_DIR, { recursive: true });
// The default express-session MemoryStore keeps every session in the Node
// process's own memory for as long as the process runs and never survives a
// restart - on a memory-constrained host that grows without bound. Persist
// sessions in Postgres instead, using the same database as everything else.
const sessionPool = new Pool({ connectionString: process.env.DATABASE_URL });
app.use(session({
  store: new pgSession({ pool: sessionPool, tableName: 'session', createTableIfMissing: true }),
  name: 'kanban.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: IS_PRODUCTION, maxAge: 1000 * 60 * 60 * 12 }
}));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
const passwordResetLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false });

function isAuthed(req) { return req.session && req.session.authenticated === true; }
function requireAuth(req, res, next) { return isAuthed(req) ? next() : res.status(401).json({ error: 'unauthorized' }); }
function isAdminRole(role) { return role === 'admin' || role === 'owner'; }
function isOwnerRole(role) { return role === 'owner'; }
function requireAdmin(req, res, next) {
  if (!isAuthed(req)) return res.status(401).json({ error: 'unauthorized' });
  if (!isAdminRole(req.session.role)) return res.status(403).json({ error: 'admin_required' });
  return next();
}
function hashApiToken(rawToken) {
  return crypto.createHash('sha256').update(String(rawToken || '')).digest('hex');
}
// Bearer-token auth for the MCP connector, independent of the cookie session
// used by the browser app - each token maps 1:1 to an existing Kanban user,
// so a tool call can never do more than that person could already do in the UI.
async function requireApiToken(req, res, next) {
  const header = String(req.headers.authorization || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return res.status(401).json({ error: 'missing_token' });
  const tokenHash = hashApiToken(match[1].trim());
  try {
    const token = await prisma.apiToken.findUnique({ where: { tokenHash }, include: { user: true } });
    if (!token || token.revokedAt || !token.user || token.user.isActive === false) {
      return res.status(401).json({ error: 'invalid_token' });
    }
    req.apiUser = { id: token.user.id, username: token.user.username, role: token.user.role, displayName: token.user.displayName };
    prisma.apiToken.update({ where: { id: token.id }, data: { lastUsedAt: new Date() } }).catch(() => null);
    return next();
  } catch (error) {
    console.error('API token auth failed:', error.message || error);
    return res.status(500).json({ error: 'auth_failed' });
  }
}
function avatarFilenameForUserId(id) {
  if (!id) return null;
  try {
    const files = fs.readdirSync(AVATAR_UPLOAD_DIR);
    return files.find(f => f.startsWith(`avatar-${id}.`)) || null;
  } catch (_error) {
    return null;
  }
}
function avatarUrlForUserId(id) {
  const filename = avatarFilenameForUserId(id);
  return filename ? `/assets/uploads/avatars/${filename}` : null;
}
function removeUserAvatarFiles(id) {
  if (!id) return;
  try {
    const files = fs.readdirSync(AVATAR_UPLOAD_DIR);
    files.filter(f => f.startsWith(`avatar-${id}.`)).forEach(f => {
      try { fs.unlinkSync(path.join(AVATAR_UPLOAD_DIR, f)); } catch (_e) {}
    });
  } catch (_error) {}
}
function saveUserAvatarFile(id, dataUrl) {
  if (!id) return null;
  if (!dataUrl) {
    removeUserAvatarFiles(id);
    return null;
  }
  const value = String(dataUrl || '').trim();
  const match = value.match(/^data:(image\/(png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new Error('invalid_avatar_data');
  const mime = match[1];
  const base64 = match[3];
  const ext = mime === 'image/png' ? 'png' : mime === 'image/jpeg' || mime === 'image/jpg' ? 'jpg' : 'webp';
  removeUserAvatarFiles(id);
  const filename = `avatar-${id}.${ext}`;
  fs.writeFileSync(path.join(AVATAR_UPLOAD_DIR, filename), Buffer.from(base64, 'base64'));
  return `/assets/uploads/avatars/${filename}`;
}
function sanitizeUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    isActive: user.isActive !== false,
    displayName: user.displayName || null,
    email: user.email || null,
    avatarUrl: avatarUrlForUserId(user.id),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}
async function createTicketAuditEvent({
  ticketId,
  userId = null,
  eventType,
  oldValue = null,
  newValue = null,
  metadata = null
}) {
  try {
    if (!ticketId || !eventType) return null;

    return await prisma.ticketEvent.create({
      data: {
        ticketId,
        userId,
        eventType,
        oldValue: oldValue === undefined || oldValue === null ? null : String(oldValue),
        newValue: newValue === undefined || newValue === null ? null : String(newValue),
        metadata: metadata || undefined
      }
    });
  } catch (error) {
    console.warn('Ticket audit event failed:', error.message || error);
    return null;
  }
}

async function auditTicketChanges({
  ticketId,
  userId = null,
  before = {},
  after = {},
  fields = []
}) {
  for (const field of fields) {
    const oldValue = before?.[field] ?? null;
    const newValue = after?.[field] ?? null;

    if (String(oldValue ?? '') === String(newValue ?? '')) continue;

    await createTicketAuditEvent({
      ticketId,
      userId,
      eventType: `ticket_${field}_changed`,
      oldValue,
      newValue,
      metadata: { field }
    });
  }
}
function normalizeRole(role) {
  const value = String(role || 'support').trim().toLowerCase();
  if (value === 'agent' || value === 'viewer') return 'support';
  return ['owner', 'admin', 'cs', 'support'].includes(value) ? value : null;
}
async function ownerAccountExists() {
  const count = await prisma.user.count({ where: { role: 'owner' } });
  return count > 0;
}
function normalizeBoardStatusForDb(stage) {
  const value = String(stage || 'new').trim().toLowerCase();
  if (value === 'new') return 'New';
  if (value === 'inp' || value === 'in_progress' || value === 'in-progress') return 'In Progress';
  if (value === 'wus' || value === 'waiting_on_us' || value === 'waiting-on-us') return 'Waiting on Us';
  if (value === 'dft' || value === 'due_for_test' || value === 'due-for-test') return 'Due for Test';
  if (value === 'wct' || value === 'waiting_on_contact' || value === 'waiting-on-contact') return 'Waiting on Contact';
  if (value === 'res' || value === 'resolved' || value === 'closed') return 'Resolved';
  return 'New';
}
function normalizeDbStatusForBoard(status) {
  const value = String(status || 'New').trim().toLowerCase();
  if (value === 'in progress') return 'inp';
  if (value === 'waiting on us') return 'wus';
  if (value === 'due for test') return 'dft';
  if (value === 'waiting on contact') return 'wct';
  if (value === 'resolved' || value === 'closed') return 'res';
  return 'new';
}
function startOfLocalDay(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}
function kpiDateBounds(range) {
  const now = new Date();
  const dayStart = startOfLocalDay(now);
  const dayMs = 24 * 60 * 60 * 1000;
  const key = String(range || 'today').trim().toLowerCase();
  if (key === 'today' || key === 'day') return { start: dayStart, end: now, label: 'Today' };
  if (key === 'this_week' || key === 'week') {
    const dow = (dayStart.getDay() + 6) % 7;
    return { start: new Date(dayStart.getTime() - dow * dayMs), end: now, label: 'This week' };
  }
  if (key === 'last_week') {
    const dow = (dayStart.getDay() + 6) % 7;
    const thisWeekStart = dayStart.getTime() - dow * dayMs;
    return { start: new Date(thisWeekStart - 7 * dayMs), end: new Date(thisWeekStart - 1), label: 'Last week' };
  }
  if (key === 'this_month' || key === 'month') return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: now, label: 'This month' };
  if (key === 'last_30_days') return { start: new Date(dayStart.getTime() - 29 * dayMs), end: now, label: 'Last 30 days' };
  if (key === 'this_year') return { start: new Date(now.getFullYear(), 0, 1), end: now, label: 'This year' };
  return { start: dayStart, end: now, label: 'Today' };
}
function isDateInBounds(value, bounds) {
  if (!value || !bounds?.start || !bounds?.end) return false;
  const date = value instanceof Date ? value : new Date(value);
  return !Number.isNaN(date.getTime()) && date >= bounds.start && date <= bounds.end;
}
function kpiTicketInRange(ticket, bounds) {
  const statusKey = normalizeDbStatusForBoard(ticket?.status);
  if (statusKey === 'res') return isDateInBounds(ticket?.resolvedAt, bounds);
  return isDateInBounds(ticket?.createdAt, bounds) || isDateInBounds(ticket?.updatedAt, bounds);
}
function resolvedAtFromState(state, ticketId) {
  const touched = Number(state?.ticketStageTouchedAt?.[ticketId] || 0);
  if (touched > 0) return touched;
  const created = Date.parse(state?.ticketCreatedAt?.[ticketId] || '');
  return Number.isFinite(created) ? created : 0;
}
function isResolvedHiddenInState(state, ticketId, now = Date.now()) {
  if (normalizeBoardStatusForDb(state?.ticketState?.[ticketId] || 'new') !== 'Resolved') return false;
  const meta = (state?.ticketResolutionMeta && typeof state.ticketResolutionMeta === 'object') ? state.ticketResolutionMeta[ticketId] : null;
  if (meta?.confirmedAt) return true;
  const resolvedAt = resolvedAtFromState(state, ticketId);
  return !!resolvedAt && now - resolvedAt >= RESOLVED_RETENTION_MS;
}
function safeDateForDb(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
function normalizeEmailForDb(value) {
  return String(value || '').trim().toLowerCase();
}
function passwordResetTokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}
function passwordResetExpiresAt() {
  return new Date(Date.now() + PASSWORD_RESET_TTL_MS);
}
function publicBaseUrlForRequest(req) {
  if (CONFIGURED_APP_BASE_URL) return APP_BASE_URL;
  const host = String(req.get('host') || '').trim();
  if (!host) return APP_BASE_URL;
  return `${req.protocol}://${host}`.replace(/\/+$/, '');
}
async function ensurePasswordResetTable() {
  await prisma.$executeRaw`
    CREATE TABLE IF NOT EXISTS "PasswordResetToken" (
      "id" SERIAL PRIMARY KEY,
      "userId" INTEGER NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
      "tokenHash" TEXT NOT NULL UNIQUE,
      "expiresAt" TIMESTAMP(3) NOT NULL,
      "usedAt" TIMESTAMP(3),
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;
  await prisma.$executeRaw`CREATE INDEX IF NOT EXISTS "PasswordResetToken_userId_idx" ON "PasswordResetToken"("userId")`;
  await prisma.$executeRaw`CREATE INDEX IF NOT EXISTS "PasswordResetToken_expiresAt_idx" ON "PasswordResetToken"("expiresAt")`;
}
function extractCompanyNameFromEmail(email) {
  const domain = normalizeEmailForDb(email).split('@').pop() || '';
  const first = domain.split('.')[0] || '';
  if (!first) return null;
  return first.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

ensurePasswordResetTable().catch(error => {
  console.warn('Password reset table setup failed:', error.message || error);
});

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
function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}
function normalizeJiraBaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.replace(/\/+$/, '');
}
function normalizeJiraKey(value) {
  const raw = String(value || '').trim().toUpperCase();
  const match = raw.match(/([A-Z][A-Z0-9]+-\d+)/);
  return match ? match[1] : raw;
}
function sanitizeJiraLabel(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 255);
}
function jiraMaskedEmail(value) {
  const email = String(value || '').trim();
  if (!email.includes('@')) return '';
  const [name, domain] = email.split('@');
  if (!name) return `***@${domain}`;
  if (name.length <= 2) return `${name[0]}***@${domain}`;
  return `${name.slice(0, 2)}***@${domain}`;
}
function buildJiraDescriptionDoc(text) {
  const lines = String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map(line => line.trimEnd());
  const content = [];
  for (const line of lines) {
    if (!line.trim()) {
      content.push({ type: 'paragraph', content: [] });
      continue;
    }
    content.push({
      type: 'paragraph',
      content: [{ type: 'text', text: line.slice(0, 4000) }]
    });
  }
  return {
    version: 1,
    type: 'doc',
    content: content.length ? content : [{ type: 'paragraph', content: [] }]
  };
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
async function getStoredOAuthTokens(provider) {
  const key = String(provider || '').trim();
  if (!key) return null;
  try {
    const row = await prisma.oAuthToken.findUnique({ where: { provider: key } });
    if (!row) return null;
    return {
      accessToken: row.accessToken || null,
      refreshToken: row.refreshToken || null,
      expiresAt: row.expiresAt ? new Date(row.expiresAt).getTime() : null,
      metadata: row.metadata || null
    };
  } catch (_) {
    return null;
  }
}
async function setStoredOAuthTokens(provider, tokens) {
  const key = String(provider || '').trim();
  if (!key) return;
  const next = (tokens && typeof tokens === 'object') ? tokens : {};
  try {
    await prisma.oAuthToken.upsert({
      where: { provider: key },
      create: {
        provider: key,
        accessToken: next.accessToken || null,
        refreshToken: next.refreshToken || null,
        expiresAt: next.expiresAt ? new Date(next.expiresAt) : null,
        metadata: next.metadata || undefined
      },
      update: {
        accessToken: next.accessToken || null,
        refreshToken: next.refreshToken || null,
        expiresAt: next.expiresAt ? new Date(next.expiresAt) : null,
        metadata: next.metadata || undefined
      }
    });
  } catch (_) {}
}
async function getJiraConfig() {
  const stored = await getStoredOAuthTokens('jira');
  const meta = (stored?.metadata && typeof stored.metadata === 'object' && !Array.isArray(stored.metadata)) ? stored.metadata : {};
  const baseUrl = normalizeJiraBaseUrl(meta.baseUrl || JIRA_BASE_URL);
  const email = String(meta.email || JIRA_EMAIL || '').trim();
  const apiToken = String(stored?.accessToken || meta.apiToken || JIRA_API_TOKEN || '').trim();
  const accessToken = String(stored?.refreshToken || meta.accessToken || '').trim();
  const projectKey = normalizeJiraKey(meta.projectKey || JIRA_PROJECT_KEY);
  const authMode = String(meta.authMode || 'auto').trim().toLowerCase();
  const connected = !!(baseUrl && (apiToken || accessToken));
  return {
    connected,
    baseUrl,
    browseBaseUrl: baseUrl ? `${baseUrl}/browse/` : '',
    email,
    apiToken,
    accessToken,
    projectKey,
    authMode: ['auto', 'basic', 'bearer'].includes(authMode) ? authMode : 'auto',
    emailMasked: jiraMaskedEmail(email),
    configuredVia: stored?.accessToken || stored?.refreshToken || meta.baseUrl || meta.email || meta.projectKey ? 'app' : (connected ? 'env' : 'none')
  };
}
async function setJiraConfig(config) {
  const next = (config && typeof config === 'object') ? config : {};
  const existing = await getJiraConfig().catch(() => null);
  const apiToken = String(next.apiToken || '').trim() || String(existing?.apiToken || '').trim() || null;
  const accessToken = String(next.accessToken || '').trim() || String(existing?.accessToken || '').trim() || null;
  await setStoredOAuthTokens('jira', {
    accessToken: apiToken,
    refreshToken: accessToken,
    expiresAt: null,
    metadata: {
      baseUrl: normalizeJiraBaseUrl(next.baseUrl || existing?.baseUrl || ''),
      email: String(next.email || existing?.email || '').trim(),
      projectKey: normalizeJiraKey(next.projectKey || existing?.projectKey || ''),
      authMode: String(next.authMode || existing?.authMode || 'auto').trim().toLowerCase() || 'auto',
      apiToken: apiToken,
      accessToken: accessToken
    }
  });
}
function jiraAuthHeaders(config, authMode = 'basic') {
  if (authMode === 'bearer') {
    return {
      Authorization: `Bearer ${config.accessToken || config.apiToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    };
  }
  const token = Buffer.from(`${config.email || ''}:${config.apiToken}`).toString('base64');
  return {
    Authorization: `Basic ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json'
  };
}
async function jiraApiRequest(config, pathname, options = {}) {
  if (!config?.connected) throw new Error('jira_not_connected');
  const url = `${config.baseUrl}${pathname.startsWith('/') ? '' : '/'}${pathname}`;
  const modes = config.authMode === 'basic'
    ? ['basic']
    : (config.authMode === 'bearer' ? ['bearer'] : ['basic', 'bearer']);
  let lastStatus = 0;
  let lastText = '';
  for (const mode of modes) {
    if (mode === 'basic' && (!config.email || !config.apiToken)) continue;
    if (mode === 'bearer' && !(config.accessToken || config.apiToken)) continue;
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers: {
        ...jiraAuthHeaders(config, mode),
        ...(options.headers || {})
      },
      body: options.body
    });
    if (response.ok) {
      if (response.status === 204) return null;
      const contentType = String(response.headers.get('content-type') || '').toLowerCase();
      if (!contentType.includes('application/json')) {
        const txt = await response.text().catch(() => '');
        throw new Error(`jira_non_json_response_${response.status}:${txt.slice(0, 280)}`);
      }
      return response.json();
    }
    lastStatus = response.status;
    lastText = await response.text().catch(() => '');
    if (response.status !== 401 && response.status !== 403) {
      break;
    }
  }
  throw new Error(`jira_api_error_${lastStatus}:${lastText.slice(0, 280)}`);
}
function jiraIssueSummary(issue) {
  if (!issue || typeof issue !== 'object') return null;
  const fields = (issue.fields && typeof issue.fields === 'object') ? issue.fields : {};
  const links = Array.isArray(fields.issuelinks) ? fields.issuelinks : [];
  const comments = Array.isArray(fields.comment?.comments) ? fields.comment.comments : [];
  return {
    key: String(issue.key || '').trim(),
    summary: fields.summary || '',
    status: fields.status?.name || '',
    assignee: fields.assignee?.displayName || fields.assignee?.emailAddress || 'Unassigned',
    reporter: fields.reporter?.displayName || fields.reporter?.emailAddress || 'Unknown',
    reporterEmail: fields.reporter?.emailAddress || '',
    linkedIssues: links.map(link => {
      const inward = link?.inwardIssue || null;
      const outward = link?.outwardIssue || null;
      const ref = outward || inward;
      if (!ref?.key) return null;
      return {
        key: String(ref.key || '').trim(),
        summary: ref.fields?.summary || '',
        status: ref.fields?.status?.name || '',
        direction: outward ? 'outward' : 'inward',
        relation: String(link?.outward || link?.inward || '').trim() || 'linked'
      };
    }).filter(Boolean),
    comments: comments.slice(-5).map(comment => ({
      id: String(comment.id || ''),
      author: comment.author?.displayName || comment.author?.emailAddress || 'Unknown',
      body: String(comment.body?.content?.flatMap?.(block => Array.isArray(block?.content) ? block.content.map(node => node?.text || '') : []).join(' ') || comment.body || '').trim(),
      createdAt: comment.created || null
    }))
  };
}
async function jiraFetchIssue(config, issueKey) {
  const key = normalizeJiraKey(issueKey);
  if (!key) throw new Error('missing_jira_issue_key');
  const paths = [
    `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,status,assignee,reporter,issuelinks,comment`,
    `/rest/api/2/issue/${encodeURIComponent(key)}?fields=summary,status,assignee,reporter,issuelinks,comment`,
    `/rest/api/latest/issue/${encodeURIComponent(key)}?fields=summary,status,assignee,reporter,issuelinks,comment`
  ];
  let lastError = null;
  for (const path of paths) {
    try {
      const issue = await jiraApiRequest(config, path);
      return jiraIssueSummary(issue);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('jira_issue_fetch_failed');
}
async function findTicketRecordByKanbanId(kanbanTicketId) {
  const key = String(kanbanTicketId || '').trim();
  if (!key) return null;
  return prisma.ticket.findFirst({
    where: {
      OR: [
        { externalId: key },
        { emailMessageId: key }
      ]
    }
  });
}
async function setTicketJiraLink({ kanbanTicketId, jiraTicketKey, userId = null, metadata = null }) {
  const ticket = await findTicketRecordByKanbanId(kanbanTicketId);
  if (!ticket) return { ticket: null, updated: false };
  const nextKey = jiraTicketKey ? normalizeJiraKey(jiraTicketKey) : null;
  if (String(ticket.jiraTicketKey || '') === String(nextKey || '')) {
    return { ticket, updated: false };
  }
  const updated = await prisma.ticket.update({
    where: { id: ticket.id },
    data: { jiraTicketKey: nextKey }
  });
  await createTicketAuditEvent({
    ticketId: ticket.id,
    userId,
    eventType: nextKey ? 'ticket_jira_linked' : 'ticket_jira_unlinked',
    oldValue: ticket.jiraTicketKey || null,
    newValue: nextKey,
    metadata: metadata || undefined
  });
  return { ticket: updated, updated: true };
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
async function safeWriteState(state) {
  const nextState = (state && typeof state === 'object') ? state : {};
  const currentState = safeReadState();
  const currentMeta = currentState._meta || {};
  const incomingMeta = nextState._meta || {};
  const incomingVersion = Number(incomingMeta.clientVersion || 0);
  const currentVersion = Number(currentMeta.clientVersion || 0);
  const incomingSavedAt = Number(incomingMeta.clientSavedAt || 0);
  const currentSavedAt = Number(currentMeta.clientSavedAt || 0);
  const isStale = incomingVersion < currentVersion || (incomingVersion === currentVersion && incomingSavedAt < currentSavedAt);

  // Merge ticket stages with per-ticket timestamps so stale snapshots cannot roll
  // back a stage that was moved more recently.
  const currentStages = (currentState.ticketState && typeof currentState.ticketState === 'object') ? currentState.ticketState : {};
  const incomingStages = (nextState.ticketState && typeof nextState.ticketState === 'object') ? nextState.ticketState : {};
  const currentTouched = (currentState.ticketStageTouchedAt && typeof currentState.ticketStageTouchedAt === 'object') ? currentState.ticketStageTouchedAt : {};
  const incomingTouched = (nextState.ticketStageTouchedAt && typeof nextState.ticketStageTouchedAt === 'object') ? nextState.ticketStageTouchedAt : {};
  const mergedStages = { ...currentStages };
  const mergedTouched = { ...currentTouched };
  const stageIds = new Set([...Object.keys(currentStages), ...Object.keys(incomingStages)]);
  stageIds.forEach((ticketId) => {
    const curTs = Number(currentTouched[ticketId] || 0);
    const inTs = Number(incomingTouched[ticketId] || 0);
    if (inTs >= curTs) {
      if (Object.prototype.hasOwnProperty.call(incomingStages, ticketId)) mergedStages[ticketId] = incomingStages[ticketId];
      mergedTouched[ticketId] = inTs || curTs || Date.now();
      return;
    }
    mergedStages[ticketId] = currentStages[ticketId];
    mergedTouched[ticketId] = curTs;
  });
  nextState.ticketState = mergedStages;
  nextState.ticketStageTouchedAt = mergedTouched;

  // Ticket numbers must never regress: a browser tab/session that hasn't caught
  // up with numbers assigned elsewhere would otherwise reassign a lower number
  // (or a duplicate) to a ticket that already has a higher one recorded.
  const currentNumbers = (currentState.ticketNumbers && typeof currentState.ticketNumbers === 'object') ? currentState.ticketNumbers : {};
  const incomingNumbers = (nextState.ticketNumbers && typeof nextState.ticketNumbers === 'object') ? nextState.ticketNumbers : {};
  const mergedNumbers = { ...currentNumbers };
  Object.entries(incomingNumbers).forEach(([ticketId, num]) => {
    const n = Number(num || 0);
    if (n > Number(mergedNumbers[ticketId] || 0)) mergedNumbers[ticketId] = n;
  });
  const mergedCounter = Math.max(
    Number(currentState.ticketNumberCounter || 0),
    Number(nextState.ticketNumberCounter || 0),
    ...Object.values(mergedNumbers).map(n => Number(n) || 0),
    0
  );
  nextState.ticketNumbers = mergedNumbers;
  nextState.ticketNumberCounter = mergedCounter;

  // Union tickets by id so a session that hasn't polled/merged every ticket yet
  // can never make tickets known to other sessions vanish from the saved board.
  const currentTickets = Array.isArray(currentState.allTickets) ? currentState.allTickets : [];
  const incomingTickets = Array.isArray(nextState.allTickets) ? nextState.allTickets : [];
  const unionedTickets = new Map(currentTickets.filter(t => t && t.id).map(t => [String(t.id), t]));
  incomingTickets.forEach((t) => {
    if (!t || !t.id) return;
    const key = String(t.id);
    unionedTickets.set(key, { ...(unionedTickets.get(key) || {}), ...t });
  });
  nextState.allTickets = [...unionedTickets.values()];

  const seenIdSet = new Set(Array.isArray(currentState.seenIds) ? currentState.seenIds : []);
  (Array.isArray(nextState.seenIds) ? nextState.seenIds : []).forEach(id => seenIdSet.add(id));
  nextState.seenIds = [...seenIdSet];

  const mergeTicketMap = (field) => ({
    ...((currentState[field] && typeof currentState[field] === 'object') ? currentState[field] : {}),
    ...((nextState[field] && typeof nextState[field] === 'object') ? nextState[field] : {})
  });
  nextState.ticketAssignee = mergeTicketMap('ticketAssignee');
  nextState.ticketCSOwner = mergeTicketMap('ticketCSOwner');
  nextState.ticketAssignmentMode = mergeTicketMap('ticketAssignmentMode');
  nextState.manualSupportOverride = mergeTicketMap('manualSupportOverride');
  nextState.manualCSOverride = mergeTicketMap('manualCSOverride');
  nextState.ticketCreatedBy = mergeTicketMap('ticketCreatedBy');
  nextState.ticketResolutionMeta = mergeTicketMap('ticketResolutionMeta');
  nextState.ticketArchived = mergeTicketMap('ticketArchived');

  const pruneResolvedHiddenTickets = (stateToPrune) => {
    const nowForPrune = Date.now();
    const hiddenIds = new Set(
      (Array.isArray(stateToPrune.allTickets) ? stateToPrune.allTickets : [])
        .filter(t => t && t.id && isResolvedHiddenInState(stateToPrune, String(t.id), nowForPrune))
        .map(t => String(t.id))
    );
    if (!hiddenIds.size) return stateToPrune;
    stateToPrune.allTickets = (Array.isArray(stateToPrune.allTickets) ? stateToPrune.allTickets : []).filter(t => !hiddenIds.has(String(t?.id || '')));
    return stateToPrune;
  };
  pruneResolvedHiddenTickets(nextState);

  // The "Resolved" Teams DM is no longer tracked here at all - it moved to
  // an atomic, DB-level claim in upsertBoardTicketsToDatabase (a dedicated
  // Ticket.resolvedTeamsNotifiedAt column, checked-and-set in one UPDATE).
  // Tracking it in this JSON file via read-then-write raced under concurrent
  // saves (multiple agents' tabs, or a poll cycle overlapping a user action):
  // each one could read "not yet notified" before any of them had written it
  // back, so the same resolve event fired the DM repeatedly.
  const now = Date.now();
  const enrichedMeta = {
    ...(isStale ? currentMeta : incomingMeta),
    serverSavedAt: now
  };
  // A stale snapshot (e.g. from a lagging tab) must not blindly overwrite
  // fields it didn't correctly merge - keep the current state as the base and
  // only layer in the fields we've safely reconciled above by id/timestamp.
  const reconciledFields = ['ticketState', 'ticketStageTouchedAt', 'ticketNumbers', 'ticketNumberCounter', 'allTickets', 'seenIds', 'ticketAssignee', 'ticketCSOwner', 'ticketAssignmentMode', 'manualSupportOverride', 'manualCSOverride', 'ticketResolutionMeta', 'ticketArchived', 'ticketCreatedBy'];
  const finalState = isStale
    ? { ...currentState, ...Object.fromEntries(reconciledFields.map(key => [key, nextState[key]])), _meta: enrichedMeta }
    : { ...nextState, _meta: enrichedMeta };
  pruneResolvedHiddenTickets(finalState);

  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  fs.writeFileSync(DATA_PATH, JSON.stringify(finalState, null, 2), 'utf8');

  let backupCreated = false;
  const lastBackupAt = Number(currentMeta.lastBackupAt || 0);
  if (now - lastBackupAt >= BACKUP_MIN_INTERVAL_MS) {
    const withBackupMeta = { ...finalState, _meta: { ...enrichedMeta, lastBackupAt: now } };
    fs.writeFileSync(DATA_PATH, JSON.stringify(withBackupMeta, null, 2), 'utf8');
    writeBackupSnapshot(withBackupMeta);
    backupCreated = true;
  }

  return { saved: true, partial: isStale, backupCreated, state: finalState };
}
async function hydrateStateFromDatabase(baseState = {}) {
  const state = (baseState && typeof baseState === 'object') ? JSON.parse(JSON.stringify(baseState)) : {};
  const tickets = await prisma.ticket.findMany({
    include: {
      comments: {
        orderBy: { createdAt: 'asc' }
      }
    },
    orderBy: { createdAt: 'desc' }
  });
  if (!tickets.length) return state;

  const existingTickets = Array.isArray(state.allTickets) ? state.allTickets : [];
  const ticketsById = new Map(
    existingTickets
      .filter(ticket => ticket && ticket.id)
      .map(ticket => [String(ticket.id), ticket])
  );
  const seenIds = new Set(Array.isArray(state.seenIds) ? state.seenIds.map(id => String(id)) : []);

  state.ticketState = (state.ticketState && typeof state.ticketState === 'object') ? state.ticketState : {};
  state.ticketStageTouchedAt = (state.ticketStageTouchedAt && typeof state.ticketStageTouchedAt === 'object') ? state.ticketStageTouchedAt : {};
  state.ticketPriority = (state.ticketPriority && typeof state.ticketPriority === 'object') ? state.ticketPriority : {};
  state.ticketCategory = (state.ticketCategory && typeof state.ticketCategory === 'object') ? state.ticketCategory : {};
  state.ticketSubtype = (state.ticketSubtype && typeof state.ticketSubtype === 'object') ? state.ticketSubtype : {};
  state.ticketAssignee = (state.ticketAssignee && typeof state.ticketAssignee === 'object') ? state.ticketAssignee : {};
  state.ticketCSOwner = (state.ticketCSOwner && typeof state.ticketCSOwner === 'object') ? state.ticketCSOwner : {};
  state.ticketAssignmentMode = (state.ticketAssignmentMode && typeof state.ticketAssignmentMode === 'object') ? state.ticketAssignmentMode : {};
  state.ticketComments = (state.ticketComments && typeof state.ticketComments === 'object') ? state.ticketComments : {};
  state.ticketClientEmail = (state.ticketClientEmail && typeof state.ticketClientEmail === 'object') ? state.ticketClientEmail : {};
  state.ticketCreatedAt = (state.ticketCreatedAt && typeof state.ticketCreatedAt === 'object') ? state.ticketCreatedAt : {};
  state.ticketJira = (state.ticketJira && typeof state.ticketJira === 'object') ? state.ticketJira : {};
  state.ticketHubspotId = (state.ticketHubspotId && typeof state.ticketHubspotId === 'object') ? state.ticketHubspotId : {};
  state.ticketArchived = (state.ticketArchived && typeof state.ticketArchived === 'object') ? state.ticketArchived : {};
  state.manualCSOverride = (state.manualCSOverride && typeof state.manualCSOverride === 'object') ? state.manualCSOverride : {};
  state.ticketCreatedBy = (state.ticketCreatedBy && typeof state.ticketCreatedBy === 'object') ? state.ticketCreatedBy : {};
  // Postgres (Ticket.displayNumber) is the source of truth for this, not
  // whatever the client last sent - always overwritten below so the board
  // and MCP tools can never drift apart on what a ticket's number is.
  state.ticketNumbers = (state.ticketNumbers && typeof state.ticketNumbers === 'object') ? state.ticketNumbers : {};

  for (const ticket of tickets) {
    const externalId = String(ticket.externalId || ticket.emailMessageId || ticket.id);
    const rawEmail = (ticket.emailRaw && typeof ticket.emailRaw === 'object' && !Array.isArray(ticket.emailRaw)) ? ticket.emailRaw : {};
    const hydratedEmail = {
      id: rawEmail.id || externalId,
      subject: rawEmail.subject || ticket.subject || '',
      summary: rawEmail.summary || rawEmail.bodyPreview || ticket.body || '',
      sender: rawEmail.sender || ticket.senderEmail || '',
      recipients: Array.isArray(rawEmail.recipients) ? rawEmail.recipients : [],
      conversationId: rawEmail.conversationId || '',
      internetMessageId: rawEmail.internetMessageId || '',
      receivedDateTime: rawEmail.receivedDateTime || ticket.createdAt?.toISOString?.() || null,
      webLink: rawEmail.webLink || null,
      uri: rawEmail.uri || (ticket.emailMessageId ? `mail:///messages/${ticket.emailMessageId}` : null)
    };
    const mergedTicket = {
      ...(ticketsById.get(externalId) || {}),
      id: externalId,
      email: {
        ...((ticketsById.get(externalId) || {}).email || {}),
        ...hydratedEmail
      },
      priority: ticket.priority || (ticketsById.get(externalId) || {}).priority || 'Normal'
    };

    ticketsById.set(externalId, mergedTicket);
    seenIds.add(externalId);
    const dbTouchedAt = new Date(ticket.updatedAt || ticket.createdAt || Date.now()).getTime();
    const currentTouchedAt = Number(state.ticketStageTouchedAt[externalId] || 0);
    if (dbTouchedAt >= currentTouchedAt || !state.ticketState[externalId]) {
      state.ticketState[externalId] = normalizeDbStatusForBoard(ticket.status);
      state.ticketStageTouchedAt[externalId] = dbTouchedAt;
    } else {
      state.ticketStageTouchedAt[externalId] = currentTouchedAt;
    }
    if (ticket.priority) state.ticketPriority[externalId] = ticket.priority;
    if (ticket.category) state.ticketCategory[externalId] = ticket.category;
    if (ticket.assignedAgent) state.ticketAssignee[externalId] = ticket.assignedAgent;
    if (ticket.csAgent) state.ticketCSOwner[externalId] = ticket.csAgent;
    if (ticket.assignedAgent || ticket.csAgent) state.ticketAssignmentMode[externalId] = 'support';
    if (ticket.senderEmail) state.ticketClientEmail[externalId] = ticket.senderEmail;
    if (ticket.createdAt) state.ticketCreatedAt[externalId] = ticket.createdAt.toISOString();
    if (ticket.jiraTicketKey) state.ticketJira[externalId] = ticket.jiraTicketKey;
    if (ticket.hubspotTicketId) state.ticketHubspotId[externalId] = ticket.hubspotTicketId;
    if (ticket.displayNumber) state.ticketNumbers[externalId] = ticket.displayNumber;
    if (Array.isArray(ticket.comments) && ticket.comments.length) {
      state.ticketComments[externalId] = ticket.comments.map(comment => ({
        text: comment.comment,
        comment: comment.comment,
        ts: comment.createdAt?.toISOString?.() || new Date().toISOString(),
        createdAt: comment.createdAt?.toISOString?.() || new Date().toISOString(),
        isInternal: comment.isInternal !== false,
        tags: Array.isArray(comment.tags) ? comment.tags : []
      }));
    }
  }

  state.allTickets = [...ticketsById.values()].sort((a, b) => new Date(b?.email?.receivedDateTime || 0) - new Date(a?.email?.receivedDateTime || 0));
  state.seenIds = [...seenIds];
  return state;
}

async function resolveStoredM365Tokens(req = null) {
  const storedTokens = await getStoredOAuthTokens('m365');
  const fileTokens = getPersistedM365Tokens();
  const sessionTokens = req?.session?.m365Tokens || null;
  const tokens = sessionTokens || storedTokens || fileTokens;
  if (!tokens?.accessToken || !tokens?.refreshToken) throw new Error('m365_not_connected');
  if (!storedTokens && fileTokens?.refreshToken) await setStoredOAuthTokens('m365', fileTokens);
  return tokens;
}

async function refreshStoredM365Tokens(tokens, req = null) {
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: M365_CLIENT_ID,
    client_secret: M365_CLIENT_SECRET,
    refresh_token: tokens.refreshToken,
    redirect_uri: M365_REDIRECT_URI
  });
  const res = await fetch(`https://login.microsoftonline.com/${M365_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form
  });
  if (!res.ok) throw new Error(`graph_refresh_error_${res.status}`);
  const json = await res.json();
  const refreshed = {
    accessToken: json.access_token,
    refreshToken: json.refresh_token || tokens.refreshToken,
    expiresAt: Date.now() + (json.expires_in || 3600) * 1000
  };
  if (req?.session) req.session.m365Tokens = refreshed;
  await setStoredOAuthTokens('m365', refreshed);
  setPersistedM365Tokens(refreshed);
  return refreshed;
}

async function graphDelegatedToken(req) {
  const tokens = await resolveStoredM365Tokens(req);
  if (Date.now() < (tokens.expiresAt || 0) - 60_000) return tokens.accessToken;
  const refreshed = await refreshStoredM365Tokens(tokens, req);
  return refreshed.accessToken;
}

async function graphDelegatedTokenFromStore() {
  const tokens = await resolveStoredM365Tokens(null);
  if (Date.now() < (tokens.expiresAt || 0) - 60_000) return tokens.accessToken;
  const refreshed = await refreshStoredM365Tokens(tokens, null);
  return refreshed.accessToken;
}

async function graphRequest(pathname, token, init = {}) {
  const headers = { Authorization: `Bearer ${token}`, ...(init.headers || {}) };
  const res = await fetch(`https://graph.microsoft.com/v1.0${pathname}`, { ...init, headers });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`graph_error_${res.status}:${txt.slice(0, 400)}`);
  }
  if (res.status === 204) return null;
  const contentType = String(res.headers.get('content-type') || '').toLowerCase();
  if (!contentType.includes('application/json')) return null;
  return res.json();
}

async function graphGet(pathname, token) {
  return graphRequest(pathname, token);
}

async function graphSendPasswordResetEmail(recipientEmail, resetUrl) {
  const token = await graphDelegatedTokenFromStore();
  const html = [
    '<div style="font-family:Segoe UI,Arial,sans-serif;color:#0f172a;line-height:1.5;">',
    '<h2 style="margin:0 0 12px;">Reset your Support Kanban password</h2>',
    '<p>We received a request to reset your password.</p>',
    `<p><a href="${escapeHtml(resetUrl)}" style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;padding:10px 14px;border-radius:8px;font-weight:700;">Change password</a></p>`,
    '<p>This link expires in 1 hour. If you did not request it, you can ignore this email.</p>',
    '</div>'
  ].join('');
  await graphRequest('/me/sendMail', token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject: 'Reset your Support Kanban password',
        body: { contentType: 'HTML', content: html },
        toRecipients: [{ emailAddress: { address: recipientEmail } }]
      },
      saveToSentItems: true
    })
  });
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`webhook_error_${response.status}:${text.slice(0, 400)}`);
  }
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (!contentType.includes('application/json')) return null;
  return response.json().catch(() => null);
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function csTeamsEmails(csOwner) {
  const trigram = String(csOwner || '').trim().toUpperCase();
  if (!trigram) return [];
  const local = trigram.toLowerCase();
  return [...new Set([
    String(CS_TEAMS_EMAIL_OVERRIDES[trigram] || '').trim().toLowerCase(),
    `${local}@${TEAMS_EMAIL_DOMAIN}`,
    `${local}@${TEAMS_FALLBACK_EMAIL_DOMAIN}`
  ].filter(Boolean))];
}

async function graphFindUserByEmail(token, email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return null;
  try {
    return await graphGet(`/users/${encodeURIComponent(normalized)}?$select=id,displayName,mail,userPrincipalName`, token);
  } catch (_) {
    return null;
  }
}

async function graphSendTeamsDirectMessage(token, recipientEmail, htmlMessage) {
  const me = await graphGet('/me?$select=id,displayName,mail,userPrincipalName', token);
  const recipient = await graphFindUserByEmail(token, recipientEmail);
  if (!me?.id) throw new Error('m365_sender_not_resolved');
  if (!recipient?.id) throw new Error(`teams_user_not_found:${recipientEmail}`);
  const chat = await graphRequest('/chats', token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chatType: 'oneOnOne',
      members: [
        {
          '@odata.type': '#microsoft.graph.aadUserConversationMember',
          roles: ['owner'],
          'user@odata.bind': `https://graph.microsoft.com/v1.0/users('${me.id}')`
        },
        {
          '@odata.type': '#microsoft.graph.aadUserConversationMember',
          roles: ['owner'],
          'user@odata.bind': `https://graph.microsoft.com/v1.0/users('${recipient.id}')`
        }
      ]
    })
  });
  if (!chat?.id) throw new Error('teams_chat_create_failed');
  await graphRequest(`/chats/${encodeURIComponent(chat.id)}/messages`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: { contentType: 'html', content: htmlMessage } })
  });
  return { chatId: chat.id, recipientId: recipient.id };
}

function buildResolvedTeamsMessage(item) {
  const ticketNo = escapeHtml(item.ticketNumber ? `#${item.ticketNumber}` : item.ticketId);
  const title = escapeHtml(item.subject || '(no subject)');
  const company = escapeHtml(item.companyName || 'Unknown company');
  const jira = item.jiraKey ? `<div><strong>Jira:</strong> ${escapeHtml(item.jiraKey)}</div>` : '';
  const assignee = item.assignee ? `<div><strong>Support agent:</strong> ${escapeHtml(item.assignee)}</div>` : '';
  return [
    '<div>',
    '<div><strong>Support Kanban update</strong></div>',
    `<div style="margin-top:6px;">Ticket <strong>${ticketNo}</strong> moved to <strong>Resolved</strong>.</div>`,
    `<div style="margin-top:6px;"><strong>Subject:</strong> ${title}</div>`,
    `<div><strong>Company:</strong> ${company}</div>`,
    assignee,
    jira,
    '</div>'
  ].filter(Boolean).join('');
}

function buildResolvedPowerAutomatePayload(item) {
  const ticketNumber = String(item.ticketNumber || item.ticketId || '').trim();
  const subject = String(item.subject || '(no subject)').trim();
  const companyName = String(item.companyName || 'Unknown company').trim();
  const jiraKey = String(item.jiraKey || '').trim();
  const jiraUrl = jiraKey && JIRA_BASE_URL ? `${normalizeJiraBaseUrl(JIRA_BASE_URL)}/browse/${encodeURIComponent(jiraKey)}` : '';
  const supportAgent = String(item.assignee || '').trim().toUpperCase();
  const csOwner = String(item.csOwner || '').trim().toUpperCase();
  // The Power Automate flow's "Post message in a chat or channel" action needs
  // a real email/UPN to resolve the recipient in Graph - the CS trigram alone
  // (e.g. "MBH") is not one, so send the resolved address alongside it.
  const recipientEmail = csTeamsEmails(csOwner)[0] || '';
  // This "message" field ends up inside an Adaptive Card TextBlock (per the
  // flow's existing structured "Ticket:/Status:/Subject:/..." card layout) -
  // those render Markdown, not raw HTML and not auto-linked bare URLs, which
  // is why a plain "View ticket: https://..." line showed as inert text.
  // Markdown link syntax renders as an actual clickable link instead of
  // showing the raw ugly Outlook message-id URL.
  const ticketUrl = item.ticketId ? `${RESOLVED_ALERT_APP_URL}/?ticket=${encodeURIComponent(item.ticketId)}` : '';
  const messageParts = [
    `Ticket #${ticketNumber} moved to Resolved.`,
    `Subject: ${subject}`,
    `Company: ${companyName}`,
    csOwner ? `CS: ${csOwner}` : '',
    supportAgent ? `Support: ${supportAgent}` : '',
    jiraKey ? `Jira: ${jiraKey}` : '',
    ticketUrl ? `[View ticket](${ticketUrl})` : ''
  ].filter(Boolean);
  return {
    ticketId: String(item.ticketId || '').trim(),
    ticketNumber,
    subject,
    companyName,
    csOwner,
    recipientEmail,
    supportAgent,
    jiraKey,
    jiraUrl,
    ticketUrl,
    status: 'Resolved',
    message: messageParts.join('\n'),
    copyEmail: RESOLVED_ALERT_COPY_EMAIL
  };
}

async function sendResolvedWebhookNotifications(items) {
  if (!Array.isArray(items) || !items.length || !POWER_AUTOMATE_RESOLVED_WEBHOOK_URL) return;
  for (const item of items) {
    try {
      await postJson(POWER_AUTOMATE_RESOLVED_WEBHOOK_URL, buildResolvedPowerAutomatePayload(item));
    } catch (error) {
      console.warn(`Resolved notification webhook failed for ${item.ticketId}/${item.csOwner}:`, error?.message || error);
    }
  }
}

async function sendResolvedTeamsNotifications(items) {
  if (!Array.isArray(items) || !items.length) return;
  await sendResolvedWebhookNotifications(items);
}

// Atomic, DB-level claim for the Resolved Teams DM: a dedicated column
// checked-and-set in a single UPDATE, not a JSON-file read-then-write (which
// raced under concurrent saves and fired the same DM repeatedly). Shared by
// the board-state sync path and the MCP ticket-update endpoint so both go
// through the exact same claim.
async function claimResolvedTeamsAlert({ ticketDbId, externalId, csAgent, category, subject, companyName, jiraTicketKey, assignedAgent, ticketNumber = null }) {
  if (category === 'spam') return null;
  const csOwnerForAlert = String(csAgent || '').trim().toUpperCase();
  if (!csOwnerForAlert) return null;
  const claimedRows = await prisma.$executeRaw`UPDATE "Ticket" SET "resolvedTeamsNotifiedAt" = NOW() WHERE id = ${ticketDbId} AND "resolvedTeamsNotifiedAt" IS NULL`;
  if (claimedRows <= 0) return null;
  return { ticketId: externalId, csOwner: csOwnerForAlert, ticketNumber, subject, companyName, jiraKey: jiraTicketKey, assignee: assignedAgent };
}

function mapMessage(msg) {
  const recipients = [
    ...(msg.toRecipients || []),
    ...(msg.ccRecipients || [])
  ].map(r => r.emailAddress?.address?.toLowerCase()).filter(Boolean);
  return {
    id: msg.id,
    subject: msg.subject || '',
    summary: msg.bodyPreview || '',
    sender: msg.from?.emailAddress?.address?.toLowerCase() || '',
    recipients: [...new Set(recipients)],
    conversationId: msg.conversationId || '',
    internetMessageId: msg.internetMessageId || '',
    receivedDateTime: msg.receivedDateTime,
    webLink: msg.webLink,
    uri: `mail:///messages/${msg.id}`
  };
}

async function getHubspotAccessToken(req) {
  const sessionTokens = req?.session?.hubspotTokens;
  const storedTokens = await getStoredOAuthTokens('hubspot');
  const persistedTokens = getPersistedHubspotTokens();
  const tokens = sessionTokens || storedTokens || persistedTokens;
  if (!storedTokens && persistedTokens?.refreshToken) await setStoredOAuthTokens('hubspot', persistedTokens);

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
      await setStoredOAuthTokens('hubspot', refreshed);
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
  if (key === 'due_for_test') return HUBSPOT_TICKET_STAGE_IN_PROGRESS || HUBSPOT_TICKET_STAGE || '';
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
  const msg = await graphGet(`/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(msgId)}?$select=id,subject,body,bodyPreview,from,toRecipients,ccRecipients,receivedDateTime,webLink,hasAttachments`, token);
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

async function buildDataHygieneReport(token) {
  const startedAt = Date.now();
  const deadlineTs = startedAt + DATA_HYGIENE_MAX_DURATION_MS;
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
    const csOwner = firstNonEmptyValue(p, ['co_owner', 'co-owner', 'coowner', 'co_owner_name', 'cs_owner', 'customer_success_owner']) || firstNonEmptyValue(p, ['am_owner', 'account_manager', 'am']);
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
  return {
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
      partial: Date.now() >= deadlineTs || normalizedRows.length >= DATA_HYGIENE_MAX_ROWS,
      durationMs: Date.now() - startedAt
    },
    rows: {
      duplicates,
      ownerMismatch,
      missingContractDate,
      noDealParentOrMonohotel
    }
  };
}

function getCachedDataHygienePayload() {
  if (!dataHygieneCache.payload) return null;
  const ageMs = Date.now() - dataHygieneCache.generatedAt;
  return {
    ...dataHygieneCache.payload,
    meta: {
      ...(dataHygieneCache.payload.meta || {}),
      cacheAgeMs: ageMs,
      cacheFresh: ageMs < DATA_HYGIENE_CACHE_TTL_MS
    }
  };
}

function refreshDataHygieneCache(token) {
  if (dataHygieneBuildPromise) return dataHygieneBuildPromise;
  dataHygieneBuildPromise = buildDataHygieneReport(token)
    .then(payload => {
      dataHygieneCache = { generatedAt: Date.now(), payload };
      return getCachedDataHygienePayload();
    })
    .finally(() => {
      dataHygieneBuildPromise = null;
    });
  return dataHygieneBuildPromise;
}


async function upsertBoardTicketsToDatabase(state, req) {
  if (!state || typeof state !== 'object') return { count: 0 };

  const allTickets = Array.isArray(state.allTickets) ? state.allTickets : [];
  const ticketState = state.ticketState || {};
  const ticketPriority = state.ticketPriority || {};
  const ticketCategory = state.ticketCategory || {};
  const ticketSubtype = state.ticketSubtype || {};
  const ticketAssignee = state.ticketAssignee || {};
  const ticketCSOwner = state.ticketCSOwner || {};
  const ticketClientEmail = state.ticketClientEmail || {};
  const ticketCreatedAt = state.ticketCreatedAt || {};
  const ticketJira = state.ticketJira || {};
  const ticketHubspotId = state.ticketHubspotId || {};
  const ticketComments = state.ticketComments || {};

  const externalIds = [...new Set(allTickets.filter(t => t && t.id).map(t => String(t.id)))];
  // Fetch every existing ticket (and its comments) in one round trip instead of
  // one findUnique per ticket, so a single stage move doesn't have to pay for
  // O(all tickets) database round trips - this is what made saves slow enough
  // to time out as the board grew.
  const existingTickets = externalIds.length
    ? await prisma.ticket.findMany({ where: { externalId: { in: externalIds } }, include: { comments: true } })
    : [];
  const existingByExternalId = new Map(existingTickets.map(t => [t.externalId, t]));

  let count = 0;
  const pendingResolvedTeamsAlerts = [];

  for (const item of allTickets) {
    if (!item || !item.id) continue;

    const externalId = String(item.id);
    const email = item.email || {};
    const subject = String(email.subject || item.subject || '(No subject)').slice(0, 1000);
    const senderEmail = normalizeEmailForDb(ticketClientEmail[externalId] || email.sender || email.from || email.fromAddress || '');
    const senderName = String(email.senderName || email.fromName || '').trim() || null;
    const status = normalizeBoardStatusForDb(ticketState[externalId] || 'new');
    const priority = String(ticketPriority[externalId] || item.priority || 'Normal').trim() || 'Normal';
    const category = String(ticketCategory[externalId] || ticketSubtype[externalId] || '').trim() || null;
    const rawAssignedAgent = String(ticketAssignee[externalId] || '').trim().toUpperCase();
    const rawCsAgent = String(ticketCSOwner[externalId] || '').trim().toUpperCase();
    const assignedAgent = SUPPORT_AGENT_CODES.has(rawAssignedAgent) ? rawAssignedAgent : null;
    const csAgent = CS_AGENT_CODES.has(rawCsAgent) ? rawCsAgent : (CS_AGENT_CODES.has(rawAssignedAgent) ? rawAssignedAgent : null);
    const createdAt = safeDateForDb(email.receivedDateTime || ticketCreatedAt[externalId]) || new Date();
    const body = String(email.bodyPreview || email.preview || email.summary || email.body || email.text || '').trim() || null;
    const companyName = extractCompanyNameFromEmail(senderEmail);
    const hubspotTicketId = ticketHubspotId[externalId] ? String(ticketHubspotId[externalId]) : null;
    const jiraTicketKey = ticketJira[externalId] ? String(ticketJira[externalId]) : null;

    const existingTicket = existingByExternalId.get(externalId) || null;
    const comments = Array.isArray(ticketComments[externalId]) ? ticketComments[externalId] : [];
    const existingCommentTexts = new Set((existingTicket?.comments || []).map(c => c.comment));
    const newComments = comments
      .map(c => ({ text: String(c?.text || c?.comment || '').trim(), ts: c?.ts || c?.createdAt, tags: Array.isArray(c?.tags) ? c.tags.map(t => String(t)).filter(Boolean) : [] }))
      .filter(c => c.text && !existingCommentTexts.has(c.text));

    const previousStatus = existingTicket?.status || null;
    const wasResolved = previousStatus === 'Resolved';
    const resolvedAtForDb = status === 'Resolved'
      ? (wasResolved ? existingTicket?.resolvedAt || new Date() : new Date())
      : null;

    const fieldsUnchanged = existingTicket
      && existingTicket.subject === subject
      && existingTicket.senderEmail === (senderEmail || null)
      && existingTicket.companyName === companyName
      && existingTicket.status === status
      && existingTicket.priority === priority
      && existingTicket.category === category
      && existingTicket.assignedAgent === assignedAgent
      && existingTicket.csAgent === csAgent
      && existingTicket.hubspotTicketId === hubspotTicketId
      && existingTicket.jiraTicketKey === jiraTicketKey
      && existingTicket.body === body;

    if (fieldsUnchanged && !newComments.length) continue;

    // If only new comments arrived and every other field already matches, we
    // already have the ticket id from the batch fetch - no need to upsert.
    const ticket = (fieldsUnchanged && existingTicket) ? existingTicket : await prisma.ticket.upsert({
      where: { externalId },
      create: {
        externalId,
        subject,
        senderName,
        senderEmail: senderEmail || null,
        companyName,
        status,
        priority,
        category,
        assignedAgent,
        csAgent,
        source: 'outlook',
        emailMessageId: externalId,
        hubspotTicketId,
        jiraTicketKey,
        body,
        emailRaw: email,
        createdAt,
        resolvedAt: resolvedAtForDb
      },
      update: {
        subject,
        senderName,
        senderEmail: senderEmail || null,
        companyName,
        status,
        priority,
        category,
        assignedAgent,
        csAgent,
        source: 'outlook',
        emailMessageId: externalId,
        hubspotTicketId,
        jiraTicketKey,
        body,
        emailRaw: email,
        resolvedAt: resolvedAtForDb,
        // Leave untouched (undefined) while staying Resolved - the atomic
        // claim above owns setting it. Reset to null on leaving Resolved so
        // a genuine future re-resolve (e.g. after a CS "send back") can
        // notify again instead of being silently claimed forever.
        resolvedTeamsNotifiedAt: status === 'Resolved' ? undefined : null
      }
    });

    if (status === 'Resolved') {
      const alert = await claimResolvedTeamsAlert({
        ticketDbId: ticket.id,
        externalId,
        csAgent,
        category,
        subject,
        companyName,
        jiraTicketKey,
        assignedAgent,
        ticketNumber: state.ticketNumbers && state.ticketNumbers[externalId] ? String(state.ticketNumbers[externalId]) : null
      });
      if (alert) pendingResolvedTeamsAlerts.push(alert);
    }

    if (!existingTicket) {
      await createTicketAuditEvent({
        ticketId: ticket.id,
        userId: req.session?.userId || null,
        eventType: 'ticket_created',
        oldValue: null,
        newValue: status,
        metadata: { externalId, subject, senderEmail, source: 'outlook' }
      });
    } else if (!fieldsUnchanged) {
      await auditTicketChanges({
        ticketId: ticket.id,
        userId: req.session?.userId || null,
        before: existingTicket,
        after: ticket,
        fields: ['subject', 'senderEmail', 'companyName', 'status', 'priority', 'category', 'assignedAgent', 'csAgent', 'hubspotTicketId', 'jiraTicketKey', 'body']
      });
    }

    for (const comment of newComments) {
      await prisma.ticketComment.create({
        data: {
          ticketId: ticket.id,
          userId: req?.session?.userId || null,
          comment: comment.text,
          isInternal: true,
          tags: comment.tags,
          createdAt: safeDateForDb(comment.ts) || new Date()
        }
      });
    }

    count += 1;
  }

  if (count > 0) {
    await prisma.syncLog.create({
      data: {
        provider: 'kanban',
        syncType: 'board_state_to_ticket_db',
        status: 'success',
        message: `Saved ${count} ticket(s) to database`,
        metadata: { count }
      }
    }).catch(() => null);
  }

  if (pendingResolvedTeamsAlerts.length) {
    void sendResolvedTeamsNotifications(pendingResolvedTeamsAlerts).catch((error) => {
      console.warn('Resolved Teams notifications failed:', error?.message || error);
    });
  }

  return { count, resolvedTeamsAlertsQueued: pendingResolvedTeamsAlerts.length };
}

app.get('/favicon.svg', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('image/svg+xml').sendFile(path.join(__dirname, 'public', 'favicon.svg'));
});

app.get('/favicon.ico', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.redirect(302, '/favicon.svg?v=q-logo-tab-v3');
});

app.get('/login', (req, res) => isAuthed(req) ? res.redirect('/') : res.type('html').sendFile(path.join(__dirname, 'public', 'login.html')));

function renderResetPasswordPage(token) {
  // Base64-encode (not JSON.stringify) before embedding in the inline
  // <script> block: JSON.stringify does not escape "</script>", so a raw
  // ?token=</script><script>...</script> could break out of the block and
  // execute attacker JS. Base64 output only ever contains [A-Za-z0-9+/=],
  // which can never form that sequence.
  const base64TokenJson = JSON.stringify(Buffer.from(String(token || ''), 'utf8').toString('base64'));
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="icon" type="image/svg+xml" sizes="any" href="/favicon.svg?v=q-logo-tab-v3" />
  <link rel="shortcut icon" type="image/svg+xml" href="/favicon.svg?v=q-logo-tab-v3" />
  <title>Reset Password</title>
  <style>
    body{font-family:Segoe UI,Arial,sans-serif;background:linear-gradient(135deg,#f8fafc,#e2e8f0);display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
    .card{background:#fff;padding:28px;border-radius:12px;box-shadow:0 12px 32px rgba(15,23,42,.12);width:min(390px,92vw)}
    h1{margin:0 0 8px;font-size:20px;color:#1e293b}
    p{margin:0 0 16px;color:#64748b;font-size:13px}
    label{display:block;font-size:12px;color:#475569;font-weight:600;margin-bottom:6px}
    input{width:100%;padding:10px;border:1px solid #cbd5e1;border-radius:8px;margin-bottom:12px;box-sizing:border-box}
    button{width:100%;padding:10px;border:none;border-radius:8px;background:#4f46e5;color:#fff;font-weight:700;cursor:pointer}
    button:disabled{opacity:.65;cursor:not-allowed}
    a{color:#4f46e5;text-decoration:none;font-size:13px;font-weight:700}
    .msg{margin-top:10px;font-size:12px;min-height:16px;color:#64748b}
    .msg.err{color:#dc2626}
    .msg.ok{color:#16a34a}
  </style>
</head>
<body>
  <form class="card" id="reset-form">
    <h1>Reset password</h1>
    <p>Choose a new password for your Support Kanban account.</p>
    <label for="password">New password</label>
    <input id="password" name="password" type="password" autocomplete="new-password" minlength="8" required />
    <label for="confirm">Confirm password</label>
    <input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="8" required />
    <button id="submit-btn" type="submit">Change password</button>
    <div class="msg" id="msg"></div>
    <p style="margin-top:14px;margin-bottom:0;"><a href="/login">Back to sign in</a></p>
  </form>
  <script>
    // safeTokenJson is a JSON string literal - JSON.stringify does not escape
    // "</script>", so a raw ?token=</script><script>...</script> could break
    // out of this block. Base64-encode it and decode at runtime instead of
    // embedding the raw JSON, so the script body can never contain "</script".
    const resetToken = atob(${base64TokenJson});
    const form = document.getElementById('reset-form');
    const msg = document.getElementById('msg');
    const btn = document.getElementById('submit-btn');
    if (!resetToken) {
      msg.textContent = 'This reset link is missing its token.';
      msg.className = 'msg err';
      btn.disabled = true;
    }
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      msg.className = 'msg';
      msg.textContent = '';
      const password = document.getElementById('password').value;
      const confirm = document.getElementById('confirm').value;
      if (password.length < 8) {
        msg.textContent = 'Password must be at least 8 characters.';
        msg.className = 'msg err';
        return;
      }
      if (password !== confirm) {
        msg.textContent = 'Passwords do not match.';
        msg.className = 'msg err';
        return;
      }
      btn.disabled = true;
      try {
        const res = await fetch('/auth/reset-password', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          credentials: 'include',
          body: JSON.stringify({ token: resetToken, password })
        });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) {
          msg.textContent = out.error === 'invalid_or_expired_token' ? 'This reset link is invalid or expired.' : 'Unable to change password.';
          msg.className = 'msg err';
          btn.disabled = false;
          return;
        }
        msg.textContent = 'Password changed. You can sign in now.';
        msg.className = 'msg ok';
        setTimeout(() => { location.href = '/login'; }, 1200);
      } catch (_) {
        msg.textContent = 'Network error. Please try again.';
        msg.className = 'msg err';
        btn.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}

app.get('/reset-password', (req, res) => {
  res.type('html').send(renderResetPasswordPage(req.query.token || ''));
});

app.post('/auth/forgot-password', passwordResetLimiter, async (req, res) => {
  try {
    const email = normalizeEmailForDb(req.body?.email || '');
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'invalid_email' });

    const user = await prisma.user.findFirst({
      where: { email, isActive: true }
    });

    if (!user) {
      return res.status(404).json({ error: 'email_not_found' });
    }

    await ensurePasswordResetTable();
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = passwordResetTokenHash(token);
    const expiresAt = passwordResetExpiresAt();
    const resetUrl = `${publicBaseUrlForRequest(req)}/reset-password?token=${encodeURIComponent(token)}`;

    await prisma.$executeRaw`DELETE FROM "PasswordResetToken" WHERE "userId" = ${user.id} AND "usedAt" IS NULL`;
    await prisma.$executeRaw`
      INSERT INTO "PasswordResetToken" ("userId", "tokenHash", "expiresAt")
      VALUES (${user.id}, ${tokenHash}, ${expiresAt})
    `;

    try {
      await graphSendPasswordResetEmail(email, resetUrl);
    } catch (mailError) {
      await prisma.$executeRaw`DELETE FROM "PasswordResetToken" WHERE "tokenHash" = ${tokenHash}`;
      console.error('Password reset email failed:', mailError);
      return res.status(500).json({ error: 'send_email_failed' });
    }

    return res.json({ ok: true });
  } catch (error) {
    console.error('Forgot password failed:', error);
    return res.status(500).json({ error: 'forgot_password_failed' });
  }
});

app.post('/auth/reset-password', passwordResetLimiter, async (req, res) => {
  try {
    const token = String(req.body?.token || '').trim();
    const password = String(req.body?.password || '');
    if (!token) return res.status(400).json({ error: 'missing_token' });
    if (password.length < 8) return res.status(400).json({ error: 'password_too_short' });

    await ensurePasswordResetTable();
    const tokenHash = passwordResetTokenHash(token);
    const rows = await prisma.$queryRaw`
      SELECT "id", "userId", "expiresAt", "usedAt"
      FROM "PasswordResetToken"
      WHERE "tokenHash" = ${tokenHash}
      LIMIT 1
    `;
    const reset = Array.isArray(rows) ? rows[0] : null;

    if (!reset || reset.usedAt || new Date(reset.expiresAt).getTime() < Date.now()) {
      return res.status(400).json({ error: 'invalid_or_expired_token' });
    }

    const user = await prisma.user.findUnique({ where: { id: Number(reset.userId) } });
    if (!user || user.isActive === false) {
      return res.status(400).json({ error: 'invalid_or_expired_token' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { passwordHash } }),
      prisma.$executeRaw`UPDATE "PasswordResetToken" SET "usedAt" = ${new Date()} WHERE "id" = ${Number(reset.id)}`
    ]);

    if (req.session) {
      req.session.authenticated = false;
      delete req.session.userId;
      delete req.session.username;
      delete req.session.role;
    }

    return res.json({ ok: true });
  } catch (error) {
    console.error('Reset password failed:', error);
    return res.status(500).json({ error: 'reset_password_failed' });
  }
});

app.post('/auth/login', authLimiter, async (req, res) => {
  try {
    const username = normalizeUsername(req.body?.username || '');
    const password = String(req.body?.password || '');

    if (!username || !password) {
      return res.status(400).json({ error: 'missing_credentials' });
    }

    const user = await prisma.user.findUnique({
      where: { username },
    });

    if (!user) {
      return res.status(401).json({ error: 'invalid_credentials' });
    }

    if (user.isActive === false) {
      return res.status(403).json({ error: 'user_disabled' });
    }

    const ok = await bcrypt.compare(password, user.passwordHash);

    if (!ok) {
      return res.status(401).json({ error: 'invalid_credentials' });
    }

    req.session.authenticated = true;
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;

    return res.json({ ok: true, user: sanitizeUser(user) });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ error: 'login_failed' });
  }
});

app.get('/auth/microsoft/start', requireAuth, (req, res) => {
  if (!M365_TENANT_ID || !M365_CLIENT_ID || !M365_CLIENT_SECRET) return res.status(500).send('Missing Microsoft env vars.');
  const state = crypto.randomBytes(16).toString('hex');
  req.session.m365State = state;
  const scope = encodeURIComponent(M365_SCOPES);
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
      scope: M365_SCOPES
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
    await setStoredOAuthTokens('m365', tokens);
    setPersistedM365Tokens(tokens);
    delete req.session.m365State;
    return res.redirect('/');
  } catch (e) {
    return res.status(500).send(String(e.message || e));
  }
});

app.get('/auth/microsoft/status', requireAuth, async (req, res) => {
  const connected = !!(req.session?.m365Tokens?.refreshToken || (await getStoredOAuthTokens('m365'))?.refreshToken || getPersistedM365Tokens()?.refreshToken);
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
    await setStoredOAuthTokens('hubspot', tokens);
    setPersistedHubspotTokens(tokens);
    delete req.session.hubspotState;
    return res.redirect('/');
  } catch (e) {
    return res.status(500).send(String(e.message || e));
  }
});

app.get('/auth/hubspot/status', requireAuth, async (req, res) => {
  const connected = !!(req.session?.hubspotTokens?.refreshToken || (await getStoredOAuthTokens('hubspot'))?.refreshToken || getPersistedHubspotTokens()?.refreshToken || HAS_STATIC_HUBSPOT_TOKEN);
  res.json({ connected });
});

app.post('/auth/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

app.get('/healthz', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, app: 'support-kanban', database: 'ok', build: APP_BUILD_VERSION });
  } catch (error) {
    res.status(500).json({ ok: false, app: 'support-kanban', database: 'error', build: APP_BUILD_VERSION, message: error.message });
  }
});

app.get('/auth/me', requireAuth, (req, res) => {
  res.json({ user: { id: req.session.userId, username: req.session.username, role: req.session.role, avatarUrl: avatarUrlForUserId(req.session.userId) } });
});

app.patch('/api/profile', requireAuth, async (req, res) => {
  try {
    const id = Number(req.session.userId);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid_user' });

    const data = {};
    if (req.body?.password) {
      const password = String(req.body.password);
      if (password.length < 8) return res.status(400).json({ error: 'password_too_short' });
      data.passwordHash = await bcrypt.hash(password, 10);
    }
    const avatarChanged = req.body?.avatarBase64 !== undefined;
    if (avatarChanged) {
      try { saveUserAvatarFile(id, req.body.avatarBase64); } catch (avatarError) { return res.status(400).json({ error: 'invalid_avatar_data' }); }
    }

    if (!Object.keys(data).length && !avatarChanged) return res.status(400).json({ error: 'no_changes' });

    const user = Object.keys(data).length
      ? await prisma.user.update({ where: { id }, data })
      : await prisma.user.findUnique({ where: { id } });
    res.json({ ok: true, user: sanitizeUser(user) });
  } catch (error) {
    console.error('Update profile failed:', error);
    res.status(500).json({ error: 'update_profile_failed' });
  }
});
// --- Templates: shared, team-wide reusable message templates ------------
// Any logged-in user can create/edit/delete any template (same trust model
// as the shared ticket board itself) - lastEditedByUserId gives a minimal
// audit trail for "who changed this" without a full event log.
const TEMPLATE_SELECT = {
  id: true, name: true, body: true, createdAt: true, updatedAt: true,
  createdBy: { select: { username: true, displayName: true } },
  lastEditedBy: { select: { username: true, displayName: true } }
};
app.get('/api/templates', requireAuth, async (req, res) => {
  const templates = await prisma.template.findMany({ orderBy: { updatedAt: 'desc' }, select: TEMPLATE_SELECT });
  res.json({ templates });
});
app.get('/api/templates/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid_template_id' });
  const template = await prisma.template.findUnique({ where: { id }, select: TEMPLATE_SELECT });
  if (!template) return res.status(404).json({ error: 'template_not_found' });
  res.json({ template });
});
app.post('/api/templates', requireAuth, async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const body = String(req.body?.body || '');
  if (!name) return res.status(400).json({ error: 'name_required' });
  if (!body.trim()) return res.status(400).json({ error: 'body_required' });
  const template = await prisma.template.create({
    data: { name, body, createdByUserId: req.session.userId, lastEditedByUserId: req.session.userId },
    select: TEMPLATE_SELECT
  });
  res.status(201).json({ template });
});
app.patch('/api/templates/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid_template_id' });
  const data = { lastEditedByUserId: req.session.userId };
  if (req.body?.name !== undefined) {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name_required' });
    data.name = name;
  }
  if (req.body?.body !== undefined) {
    const body = String(req.body.body || '');
    if (!body.trim()) return res.status(400).json({ error: 'body_required' });
    data.body = body;
  }
  try {
    const template = await prisma.template.update({ where: { id }, data, select: TEMPLATE_SELECT });
    res.json({ template });
  } catch (error) {
    res.status(404).json({ error: 'template_not_found' });
  }
});
app.post('/api/templates/:id/duplicate', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid_template_id' });
  const source = await prisma.template.findUnique({ where: { id } });
  if (!source) return res.status(404).json({ error: 'template_not_found' });
  const template = await prisma.template.create({
    data: {
      name: `${source.name} (copy)`,
      body: source.body,
      createdByUserId: req.session.userId,
      lastEditedByUserId: req.session.userId
    },
    select: TEMPLATE_SELECT
  });
  res.status(201).json({ template });
});
app.delete('/api/templates/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid_template_id' });
  try {
    await prisma.template.delete({ where: { id } });
    res.json({ ok: true });
  } catch (error) {
    res.status(404).json({ error: 'template_not_found' });
  }
});

app.get('/api/jira/status', requireAuth, async (req, res) => {
  try {
    const jira = await getJiraConfig();
    return res.json({
      connected: jira.connected,
      baseUrl: jira.baseUrl,
      browseBaseUrl: jira.browseBaseUrl,
      projectKey: jira.projectKey || '',
      email: jira.email || '',
      authMode: jira.authMode,
      hasApiToken: !!jira.apiToken,
      hasAccessToken: !!jira.accessToken,
      emailMasked: jira.emailMasked,
      configuredVia: jira.configuredVia,
      canConfigure: isAdminRole(req.session.role)
    });
  } catch (error) {
    return res.status(500).json({ error: String(error.message || error) });
  }
});
app.post('/api/jira/config', requireAdmin, async (req, res) => {
  try {
    const baseUrl = normalizeJiraBaseUrl(req.body?.baseUrl || '');
    const email = String(req.body?.email || '').trim();
    const apiToken = String(req.body?.apiToken || '').trim();
    const accessToken = String(req.body?.accessToken || '').trim();
    const projectKey = normalizeJiraKey(req.body?.projectKey || '');
    const authMode = String(req.body?.authMode || 'auto').trim().toLowerCase() || 'auto';
    const existing = await getJiraConfig();
    if (!baseUrl || ((!apiToken && !existing?.apiToken) && (!accessToken && !existing?.accessToken))) {
      return res.status(400).json({ error: 'missing_jira_configuration' });
    }
    await setJiraConfig({ baseUrl, email, apiToken, accessToken, projectKey, authMode });
    const jira = await getJiraConfig();
    return res.json({
      ok: true,
      connected: jira.connected,
      baseUrl: jira.baseUrl,
      browseBaseUrl: jira.browseBaseUrl,
      projectKey: jira.projectKey || '',
      email: jira.email || '',
      authMode: jira.authMode,
      hasApiToken: !!jira.apiToken,
      hasAccessToken: !!jira.accessToken,
      emailMasked: jira.emailMasked
    });
  } catch (error) {
    return res.status(500).json({ error: String(error.message || error) });
  }
});
app.post('/api/jira/link', requireAuth, async (req, res) => {
  try {
    const kanbanTicketId = String(req.body?.kanbanTicketId || '').trim();
    const jiraKey = normalizeJiraKey(req.body?.jiraKey || '');
    if (!kanbanTicketId || !jiraKey) {
      return res.status(400).json({ error: 'missing_ticket_or_jira_key' });
    }
    const jira = await getJiraConfig();
    let issue = null;
    let jiraLookupError = null;
    if (jira.connected) {
      try {
        issue = await jiraFetchIssue(jira, jiraKey);
      } catch (error) {
        jiraLookupError = String(error.message || error);
      }
    }
    await setTicketJiraLink({
      kanbanTicketId,
      jiraTicketKey: jiraKey,
      userId: req.session.userId || null,
      metadata: issue ? { source: 'jira_api', key: issue.key } : { source: 'manual', jiraLookupError }
    });
    return res.json({
      ok: true,
      jiraKey,
      issue,
      jiraLookupError,
      browseUrl: jira.browseBaseUrl ? `${jira.browseBaseUrl}${jiraKey}` : null
    });
  } catch (error) {
    return res.status(500).json({ error: String(error.message || error) });
  }
});
app.delete('/api/jira/link/:kanbanTicketId', requireAuth, async (req, res) => {
  try {
    const kanbanTicketId = String(req.params.kanbanTicketId || '').trim();
    if (!kanbanTicketId) return res.status(400).json({ error: 'missing_kanban_ticket_id' });
    await setTicketJiraLink({
      kanbanTicketId,
      jiraTicketKey: null,
      userId: req.session.userId || null,
      metadata: { source: 'manual' }
    });
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: String(error.message || error) });
  }
});
app.get('/api/jira/issues', requireAuth, async (req, res) => {
  try {
    const jira = await getJiraConfig();
    if (!jira.connected) return res.json({ connected: false, issues: [] });
    const keys = String(req.query.keys || '')
      .split(',')
      .map(normalizeJiraKey)
      .filter(Boolean)
      .slice(0, 50);
    const issues = [];
    for (const key of keys) {
      try {
        const issue = await jiraFetchIssue(jira, key);
        issues.push(issue);
      } catch (error) {
        issues.push({ key, error: String(error.message || error) });
      }
    }
    return res.json({
      connected: true,
      browseBaseUrl: jira.browseBaseUrl,
      projectKey: jira.projectKey || '',
      issues
    });
  } catch (error) {
    return res.status(500).json({ error: String(error.message || error) });
  }
});
app.get('/profile', requireAuth, (req, res) => {
  return res.type('html').send(`
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="icon" type="image/svg+xml" sizes="any" href="/favicon.svg?v=q-logo-tab-v3" />
  <link rel="shortcut icon" type="image/svg+xml" href="/favicon.svg?v=q-logo-tab-v3" />
  <title>Profile - Support Kanban</title>
  <style>
    :root {
      --bg: #f8fafc;
      --card: #ffffff;
      --text: #0f172a;
      --muted: #64748b;
      --border: #e2e8f0;
      --primary: #2563eb;
      --primary-dark: #1d4ed8;
      --danger: #dc2626;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      font-family: Inter, Arial, sans-serif;
      background:
        radial-gradient(circle at top left, rgba(37,99,235,.14), transparent 32%),
        radial-gradient(circle at bottom right, rgba(14,165,233,.12), transparent 30%),
        var(--bg);
      color: var(--text);
      min-height: 100vh;
    }

    .topbar {
      height: 68px;
      background: rgba(15, 23, 42, .96);
      color: white;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 28px;
      box-shadow: 0 10px 30px rgba(15,23,42,.18);
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 18px;
      font-weight: 800;
    }

    .brand-mark {
      width: 36px;
      height: 36px;
      border-radius: 12px;
      background: white;
      color: #0f172a;
      display: grid;
      place-items: center;
      font-weight: 900;
    }

    .nav {
      display: flex;
      gap: 10px;
      align-items: center;
    }

    .nav a,
    .nav button {
      border: 1px solid rgba(255,255,255,.18);
      background: rgba(255,255,255,.06);
      color: white;
      padding: 9px 13px;
      border-radius: 11px;
      text-decoration: none;
      cursor: pointer;
      font-size: 14px;
      transition: background .15s ease, transform .15s ease;
    }

    .nav a:hover,
    .nav button:hover {
      background: rgba(255,255,255,.13);
      transform: translateY(-1px);
    }

    .wrap {
      max-width: 940px;
      margin: 42px auto;
      padding: 0 20px;
    }

    .profile-card {
      background: rgba(255,255,255,.92);
      backdrop-filter: blur(18px);
      border: 1px solid rgba(226,232,240,.9);
      border-radius: 24px;
      overflow: hidden;
      box-shadow: 0 24px 70px rgba(15,23,42,.12);
    }

    .hero {
      padding: 34px;
      background:
        linear-gradient(135deg, rgba(15,23,42,.98), rgba(37,99,235,.92) 54%, rgba(20,184,166,.86));
      color: white;
      display: flex;
      align-items: center;
      gap: 22px;
    }

    .avatar-picker {
      position: relative;
      width: 92px;
      height: 92px;
      flex: 0 0 auto;
      border: 0;
      padding: 0;
      border-radius: 999px;
      background: transparent;
      cursor: pointer;
    }

    .avatar-ring {
      position: absolute;
      inset: -5px;
      border-radius: inherit;
      background: conic-gradient(from 140deg, #ffffff, #93c5fd, #5eead4, #ffffff);
      opacity: .96;
    }

    .avatar {
      position: relative;
      width: 100%;
      height: 100%;
      border-radius: inherit;
      background:
        radial-gradient(circle at 30% 22%, rgba(255,255,255,.36), transparent 30%),
        linear-gradient(135deg, rgba(255,255,255,.24), rgba(255,255,255,.10));
      border: 3px solid rgba(255,255,255,.96);
      display: grid;
      place-items: center;
      color: white;
      font-size: 38px;
      font-weight: 900;
      overflow: hidden;
      box-shadow: 0 18px 38px rgba(15,23,42,.26);
      transition: transform .16s ease, box-shadow .16s ease;
    }

    .avatar-picker:hover .avatar,
    .avatar-picker:focus-visible .avatar {
      transform: translateY(-1px) scale(1.02);
      box-shadow: 0 22px 44px rgba(15,23,42,.32);
    }

    .avatar-action {
      position: absolute;
      right: -4px;
      bottom: 2px;
      min-width: 34px;
      height: 34px;
      border-radius: 999px;
      border: 3px solid white;
      background: #0f172a;
      color: white;
      display: grid;
      place-items: center;
      font-size: 16px;
      line-height: 1;
      box-shadow: 0 10px 22px rgba(15,23,42,.28);
    }

    .avatar-help {
      margin-top: 10px;
      color: rgba(255,255,255,.74);
      font-size: 13px;
    }

    h1 {
      margin: 0;
      font-size: 30px;
      line-height: 1.1;
    }

    .subtitle {
      margin-top: 6px;
      color: rgba(255,255,255,.86);
      font-size: 14px;
    }

    .content {
      padding: 28px 32px 32px;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 14px;
      margin-bottom: 22px;
    }

    .stat {
      border: 1px solid var(--border);
      border-radius: 18px;
      background: #fff;
      padding: 16px;
    }

    .stat-label {
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: .04em;
      margin-bottom: 8px;
    }

    .stat-value {
      font-size: 16px;
      font-weight: 800;
      word-break: break-word;
    }

    .details {
      border: 1px solid var(--border);
      border-radius: 18px;
      overflow: hidden;
      background: white;
    }

    .row {
      display: grid;
      grid-template-columns: 190px 1fr;
      gap: 16px;
      padding: 16px 18px;
      border-bottom: 1px solid #f1f5f9;
    }

    .row:last-child {
      border-bottom: 0;
    }

    .label {
      color: var(--muted);
      font-weight: 800;
      font-size: 13px;
    }

    .value {
      color: var(--text);
      font-weight: 650;
      word-break: break-word;
    }

    .form-input {
      width: min(100%, 380px);
      border: 1px solid #cbd5e1;
      border-radius: 12px;
      background: #f8fafc;
      color: var(--text);
      padding: 12px 14px;
      font: inherit;
      font-weight: 650;
      outline: none;
      transition: border-color .15s ease, box-shadow .15s ease, background .15s ease;
    }

    .form-input:focus {
      border-color: var(--primary);
      background: #fff;
      box-shadow: 0 0 0 4px rgba(37,99,235,.12);
    }

    .avatar-upload-panel {
      display: flex;
      align-items: center;
      gap: 14px;
      flex-wrap: wrap;
    }

    .avatar-preview {
      width: 62px;
      height: 62px;
      border-radius: 999px;
      border: 2px solid #dbeafe;
      background:
        radial-gradient(circle at 30% 22%, rgba(255,255,255,.9), transparent 34%),
        linear-gradient(135deg, #2563eb, #14b8a6);
      color: white;
      display: grid;
      place-items: center;
      font-size: 24px;
      font-weight: 900;
      overflow: hidden;
      cursor: pointer;
      box-shadow: 0 12px 26px rgba(37,99,235,.14);
    }

    .avatar-copy {
      min-width: 210px;
    }

    .avatar-title {
      font-weight: 850;
      margin-bottom: 4px;
    }

    .avatar-note {
      color: var(--muted);
      font-size: 13px;
      font-weight: 650;
      line-height: 1.45;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      border-radius: 999px;
      background: #ecfdf5;
      color: #047857;
      font-size: 13px;
      font-weight: 800;
    }

    .actions {
      margin-top: 24px;
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }

    .btn {
      border: 0;
      border-radius: 13px;
      padding: 12px 16px;
      font-weight: 800;
      cursor: pointer;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 14px;
      transition: transform .15s ease, box-shadow .15s ease;
    }

    .btn:hover {
      transform: translateY(-1px);
    }

    .btn-primary {
      background: var(--primary);
      color: white;
      box-shadow: 0 10px 20px rgba(37,99,235,.20);
    }

    .btn-primary:hover {
      background: var(--primary-dark);
    }

    .btn-secondary {
      background: #e2e8f0;
      color: #0f172a;
    }

    .btn-danger {
      background: #fee2e2;
      color: #b91c1c;
    }

    .hidden {
      display: none !important;
    }

    @media (max-width: 720px) {
      .topbar {
        padding: 0 16px;
      }

      .nav {
        gap: 6px;
      }

      .nav a,
      .nav button {
        padding: 8px 9px;
      }

      .hero {
        padding: 24px;
        align-items: flex-start;
      }

      .grid {
        grid-template-columns: 1fr;
      }

      .row {
        grid-template-columns: 1fr;
        gap: 6px;
      }
    }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="brand">
      <div class="brand-mark">Q</div>
      <span>Support Kanban</span>
    </div>

    <div class="nav">
      <a href="/">Board</a>
      <a id="adminTopLink" class="hidden" href="/admin/users">Users</a>
      <button id="logoutTopBtn" type="button">Logout</button>
    </div>
  </header>

  <main class="wrap">
    <section class="profile-card">
      <div class="hero">
        <button class="avatar-picker" id="avatarPicker" type="button" aria-label="Change profile picture">
          <span class="avatar-ring" aria-hidden="true"></span>
          <span class="avatar" id="avatar">?</span>
          <span class="avatar-action" aria-hidden="true">&#128247;</span>
        </button>
        <input id="avatarInput" class="hidden" type="file" accept="image/png,image/jpeg,image/webp" />
        <div>
          <h1 id="profileTitle">Profile</h1>
          <div class="subtitle" id="profileSubtitle">Loading account details...</div>
          <div class="avatar-help">Click your photo to upload a new image.</div>
        </div>
      </div>

      <div class="content">
        <div class="grid">
          <div class="stat">
            <div class="stat-label">Username</div>
            <div class="stat-value" id="statUsername">-</div>
          </div>

          <div class="stat">
            <div class="stat-label">Role</div>
            <div class="stat-value" id="statRole">-</div>
          </div>

          <div class="stat">
            <div class="stat-label">Session</div>
            <div class="stat-value"><span class="badge">Active</span></div>
          </div>
        </div>

        <div class="details">
          <div class="row">
            <div class="label">User ID</div>
            <div class="value" id="userId">-</div>
          </div>

          <div class="row">
            <div class="label">Username</div>
            <div class="value" id="username">-</div>
          </div>

          <div class="row">
            <div class="label">Role</div>
            <div class="value" id="role">-</div>
          </div>

          <div class="row">
            <div class="label">Environment</div>
            <div class="value">Support Kanban Web App</div>
          </div>

          <div class="row">
            <div class="label">Password</div>
            <div class="value">
              <input id="newPassword" class="form-input" type="password" placeholder="Leave blank to keep current password" autocomplete="new-password" />
            </div>
          </div>

          <div class="row">
            <div class="label">Profile picture</div>
            <div class="value">
              <div class="avatar-upload-panel">
                <button class="avatar-preview" id="avatarPreview" type="button">?</button>
                <div class="avatar-copy">
                  <div class="avatar-title">Profile photo</div>
                  <div class="avatar-note">PNG, JPG, or WebP. Your selected image appears here before saving.</div>
                </div>
              </div>
            </div>
          </div>

          <div class="row">
            <div class="label">Claude connector</div>
            <div class="value">
              <div id="mcpTokenStatus" style="font-size:13px;color:var(--muted);margin-bottom:8px;">Loading...</div>
              <div id="mcpTokenReveal" class="hidden" style="margin-bottom:8px;">
                <input id="mcpTokenValue" class="form-input" type="text" readonly style="font-family:monospace;font-size:12px;" />
                <div style="font-size:12px;color:var(--muted);margin-top:4px;">Copy this now - it will not be shown again. Paste it as the Bearer token when adding the Support Kanban connector in Claude.</div>
              </div>
              <button class="btn btn-secondary" id="mcpGenerateBtn" type="button">Generate token</button>
              <button class="btn btn-danger hidden" id="mcpRevokeBtn" type="button">Revoke token</button>
            </div>
          </div>
        </div>

        <div class="actions">
          <a class="btn btn-primary" href="/">&larr; Back to board</a>
          <a id="manageUsersBtn" class="btn btn-secondary hidden" href="/admin/users">Manage users</a>
          <button class="btn btn-secondary" id="saveProfileBtn" type="button">Save profile</button>
          <button class="btn btn-danger" id="logoutBtn" type="button">Logout</button>
        </div>
      </div>
    </section>
  </main>

  <script>
    let selectedAvatarBase64 = null;
    let currentInitial = '?';

    function setText(id, value) {
      const el = document.getElementById(id);
      if (el) el.textContent = value || '-';
    }

    function setAvatarImage(url, initial) {
      const el = document.getElementById('avatar');
      if (!el) return;
      if (url) {
        el.style.backgroundImage = 'url(' + url + ')';
        el.style.backgroundSize = 'cover';
        el.style.backgroundPosition = 'center';
        el.textContent = '';
      } else {
        el.style.backgroundImage = '';
        el.textContent = initial;
      }
    }

    function setAvatarPreview(url) {
      const el = document.getElementById('avatarPreview');
      if (!el) return;
      if (url) {
        el.style.backgroundImage = 'url(' + url + ')';
        el.style.backgroundSize = 'cover';
        el.style.backgroundPosition = 'center';
        el.textContent = '';
      } else {
        el.style.backgroundImage = '';
        el.textContent = currentInitial;
      }
    }

    async function logout() {
      await fetch('/auth/logout', {
        method: 'POST',
        credentials: 'same-origin'
      }).catch(() => null);

      window.location.href = '/login';
    }

    async function loadProfile() {
      const res = await fetch('/auth/me', {
        credentials: 'same-origin'
      });

      if (!res.ok) {
        window.location.href = '/login';
        return;
      }

      const data = await res.json();
      const user = data.user || {};

      const username = user.username || 'User';
      const role = user.role || 'user';
      const initial = String(username).charAt(0).toUpperCase();
      currentInitial = initial;

      setText('avatar', initial);
      setAvatarImage(user.avatarUrl, initial);
      setAvatarPreview(user.avatarUrl);
      setText('profileTitle', username);
      setText('profileSubtitle', 'Signed in as ' + role);
      setText('userId', String(user.id || '-'));
      setText('username', username);
      setText('role', role);
      setText('statUsername', username);
      setText('statRole', role);

      if (role === 'admin' || role === 'owner') {
        document.getElementById('manageUsersBtn')?.classList.remove('hidden');
        document.getElementById('adminTopLink')?.classList.remove('hidden');
      }
    }

    function openAvatarPicker() {
      document.getElementById('avatarInput')?.click();
    }

    document.getElementById('avatarPicker')?.addEventListener('click', openAvatarPicker);
    document.getElementById('avatarPreview')?.addEventListener('click', openAvatarPicker);

    document.getElementById('avatarInput')?.addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        if (!result || typeof result !== 'string') return;
        selectedAvatarBase64 = result;
        setAvatarPreview(result);
      };
      reader.readAsDataURL(file);
    });

    document.getElementById('saveProfileBtn')?.addEventListener('click', async () => {
      const password = document.getElementById('newPassword')?.value.trim();
      const payload = {};
      if (password) payload.password = password;
      if (selectedAvatarBase64 !== null) payload.avatarBase64 = selectedAvatarBase64;
      if (!Object.keys(payload).length) {
        alert('Nothing to save. Change your password or upload a profile picture first.');
        return;
      }
      const res = await fetch('/api/profile', {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const result = await res.json();
      if (!res.ok) {
        alert(result.error || 'Unable to update profile.');
        return;
      }
      const username = result.user?.username || 'User';
      const initial = String(username).charAt(0).toUpperCase();
      setAvatarImage(result.user?.avatarUrl, initial);
      setAvatarPreview(result.user?.avatarUrl);
      selectedAvatarBase64 = null;
      if (document.getElementById('newPassword')) document.getElementById('newPassword').value = '';
      alert('Profile updated successfully.');
    });

    document.getElementById('logoutBtn')?.addEventListener('click', logout);
    document.getElementById('logoutTopBtn')?.addEventListener('click', logout);

    async function loadMcpTokenStatus() {
      const res = await fetch('/api/mcp/token', { credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      const statusEl = document.getElementById('mcpTokenStatus');
      const revokeBtn = document.getElementById('mcpRevokeBtn');
      if (data.token) {
        const when = new Date(data.token.createdAt).toLocaleDateString();
        statusEl.textContent = 'Active token created ' + when + (data.token.lastUsedAt ? ', last used ' + new Date(data.token.lastUsedAt).toLocaleString() : ', not used yet');
        revokeBtn?.classList.remove('hidden');
      } else {
        statusEl.textContent = 'No active token. Generate one to connect Claude to the Support Kanban board.';
        revokeBtn?.classList.add('hidden');
      }
    }

    document.getElementById('mcpGenerateBtn')?.addEventListener('click', async () => {
      if (document.getElementById('mcpRevokeBtn') && !document.getElementById('mcpRevokeBtn').classList.contains('hidden')) {
        if (!confirm('Generating a new token will revoke your current one and disconnect any Claude connector using it. Continue?')) return;
      }
      const res = await fetch('/api/mcp/token', { method: 'POST', credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(data.error || 'Unable to generate token.');
        return;
      }
      document.getElementById('mcpTokenValue').value = data.token;
      document.getElementById('mcpTokenReveal')?.classList.remove('hidden');
      loadMcpTokenStatus();
    });

    document.getElementById('mcpRevokeBtn')?.addEventListener('click', async () => {
      if (!confirm('Revoke your Claude connector token? Any connected Claude sessions will stop working until you generate a new one.')) return;
      await fetch('/api/mcp/token', { method: 'DELETE', credentials: 'same-origin' });
      document.getElementById('mcpTokenReveal')?.classList.add('hidden');
      loadMcpTokenStatus();
    });

    loadProfile();
    loadMcpTokenStatus();
  </script>
</body>
</html>
  `);
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  const users = await prisma.user.findMany({ orderBy: { createdAt: 'desc' } });
  res.json({ users: users.map(sanitizeUser) });
});

app.post('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const username = normalizeUsername(req.body?.username || '');
    const password = String(req.body?.password || '');
    const role = normalizeRole(req.body?.role || 'support');
    const displayName = String(req.body?.displayName || '').trim() || null;
    const email = normalizeEmailForDb(req.body?.email || '') || null;

    if (!username || !password) return res.status(400).json({ error: 'username_and_password_required' });
    if (!role) return res.status(400).json({ error: 'invalid_role' });
    if (role === 'owner' && !isOwnerRole(req.session.role)) return res.status(403).json({ error: 'owner_required' });
    if (password.length < 8) return res.status(400).json({ error: 'password_too_short' });

    const exists = await prisma.user.findUnique({ where: { username } });
    if (exists) return res.status(409).json({ error: 'username_already_exists' });

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { username, passwordHash, role, displayName, email, isActive: true }
    });
    if (req.body?.avatarBase64) {
      try { saveUserAvatarFile(user.id, req.body.avatarBase64); } catch (avatarError) { console.warn('Avatar upload skipped:', avatarError.message || avatarError); }
    }
    res.status(201).json({ user: sanitizeUser(user) });
  } catch (error) {
    console.error('Create user failed:', error);
    res.status(500).json({ error: 'create_user_failed' });
  }
});

app.patch('/api/admin/users/:id', requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid_user_id' });
    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'user_not_found' });
    const isSelf = existing.id === req.session.userId;
    const requesterIsOwner = isOwnerRole(req.session.role);
    if (isOwnerRole(existing.role) && !isSelf && !requesterIsOwner) return res.status(403).json({ error: 'owner_required' });

    const data = {};
    if (req.body?.username !== undefined) {
      const username = normalizeUsername(req.body.username || '');
      if (!username) return res.status(400).json({ error: 'username_required' });
      const sameNameConflict = await prisma.user.findUnique({ where: { username } });
      if (sameNameConflict && sameNameConflict.id !== existing.id) return res.status(409).json({ error: 'username_already_exists' });
      data.username = username;
    }
    if (req.body?.role !== undefined) {
      const role = normalizeRole(req.body.role);
      if (!role) return res.status(400).json({ error: 'invalid_role' });
      if ((role === 'owner' || existing.role === 'owner') && !requesterIsOwner) return res.status(403).json({ error: 'owner_required' });
      data.role = role;
    }
    if (req.body?.displayName !== undefined) data.displayName = String(req.body.displayName || '').trim() || null;
    if (req.body?.email !== undefined) data.email = normalizeEmailForDb(req.body.email || '') || null;
    if (req.body?.isActive !== undefined) data.isActive = Boolean(req.body.isActive);
    if (req.body?.password) {
      const password = String(req.body.password);
      if (password.length < 8) return res.status(400).json({ error: 'password_too_short' });
      data.passwordHash = await bcrypt.hash(password, 10);
    }
    if (req.body?.avatarBase64 !== undefined) {
      try { saveUserAvatarFile(id, req.body.avatarBase64); } catch (avatarError) { return res.status(400).json({ error: 'invalid_avatar_data' }); }
    }

    if (isSelf && data.isActive === false) return res.status(400).json({ error: 'cannot_disable_self' });
    if (isSelf && data.role && !isAdminRole(data.role)) return res.status(400).json({ error: 'cannot_remove_own_admin_role' });
    if (existing.role === 'owner' && data.isActive === false && !requesterIsOwner) return res.status(403).json({ error: 'owner_required' });
    if (!Object.keys(data).length) return res.status(400).json({ error: 'no_changes' });

    const user = await prisma.user.update({ where: { id }, data });
    res.json({ user: sanitizeUser(user) });
  } catch (error) {
    console.error('Update user failed:', error);
    res.status(500).json({ error: 'update_user_failed' });
  }
});

app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid_user_id' });
    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'user_not_found' });
    if (isOwnerRole(existing.role) && id !== req.session.userId && !isOwnerRole(req.session.role)) return res.status(403).json({ error: 'owner_required' });
    removeUserAvatarFiles(id);
    await prisma.user.delete({ where: { id } });
    if (id === req.session.userId) {
      req.session.destroy(() => {});
    }
    res.json({ ok: true, deletedUser: sanitizeUser(existing) });
  } catch (error) {
    console.error('Delete user failed:', error);
    res.status(500).json({ error: 'delete_user_failed' });
  }
});


app.get('/admin/users', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-users.html'));
});

app.get('/api/tickets', requireAuth, async (req, res) => {
  const tickets = await prisma.ticket.findMany({
    include: { comments: { include: { user: true }, orderBy: { createdAt: 'asc' } }, events: { include: { user: true }, orderBy: { createdAt: 'asc' } } },
    orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }]
  });
  res.json({ tickets });
});
app.get('/api/tickets/kpis', requireAuth, async (req, res) => {
  try {
    const bounds = kpiDateBounds(req.query.range);
    const role = normalizeRole(req.session.role) || 'support';
    const username = String(req.session.username || '').trim().toUpperCase();
    const team = String(req.query.team || 'all').trim().toLowerCase();
    const agent = String(req.query.agent || 'all').trim().toUpperCase();
    const company = String(req.query.company || 'all').trim();
    const jiraOnly = String(req.query.jiraOnly || '').toLowerCase() === 'true';

    const baseWhere = {
      NOT: [{ category: { equals: 'Spam', mode: 'insensitive' } }]
    };
    if (company && company !== 'all') baseWhere.companyName = company;
    if (jiraOnly) baseWhere.jiraTicketKey = { not: null };

    const accessWhere = {};
    if (role === 'cs') accessWhere.csAgent = username;
    else if (role === 'support') accessWhere.assignedAgent = username;
    else if (agent && agent !== 'ALL') {
      if (CS_AGENT_CODES.has(agent)) accessWhere.csAgent = agent;
      else if (SUPPORT_AGENT_CODES.has(agent)) accessWhere.assignedAgent = agent;
      else accessWhere.OR = [{ csAgent: agent }, { assignedAgent: agent }];
    } else if (team === 'cs') {
      accessWhere.csAgent = { in: Array.from(CS_AGENT_CODES) };
    } else if (team === 'support') {
      accessWhere.assignedAgent = { in: Array.from(SUPPORT_AGENT_CODES) };
    }
    const rangeWhere = {
      OR: [
        { createdAt: { gte: bounds.start, lte: bounds.end } },
        { updatedAt: { gte: bounds.start, lte: bounds.end } },
        { resolvedAt: { gte: bounds.start, lte: bounds.end } }
      ]
    };
    const statusWhere = { AND: [baseWhere, accessWhere] };
    const where = { AND: [baseWhere, accessWhere, rangeWhere] };

    const tickets = await prisma.ticket.findMany({
      where,
      select: {
        id: true,
        externalId: true,
        subject: true,
        status: true,
        priority: true,
        category: true,
        assignedAgent: true,
        csAgent: true,
        companyName: true,
        senderEmail: true,
        jiraTicketKey: true,
        createdAt: true,
        updatedAt: true,
        resolvedAt: true
      },
      orderBy: [{ createdAt: 'desc' }]
    });
    const statusTickets = await prisma.ticket.findMany({
      where: statusWhere,
      select: {
        id: true,
        status: true,
        assignedAgent: true,
        csAgent: true,
        jiraTicketKey: true
      }
    });
    const scopedTickets = tickets.filter(ticket => kpiTicketInRange(ticket, bounds));

    const statusKeys = ['new', 'inp', 'wus', 'dft', 'wct', 'res'];
    const statusCounts = Object.fromEntries(statusKeys.map(k => [k, 0]));
    const categoryCounts = {};
    const priorityCounts = {};
    const companyCounts = {};
    const agentRows = {};
    const csCounts = {};
    let ticketsWithCs = 0;

    const addAgentRow = (agentCode, statusKey) => {
      const rowAgent = String(agentCode || 'Unassigned').trim().toUpperCase() || 'Unassigned';
      if (!agentRows[rowAgent]) agentRows[rowAgent] = { agent: rowAgent, total: 0, new: 0, inp: 0, wus: 0, dft: 0, wct: 0, res: 0 };
      agentRows[rowAgent].total++;
      if (statusKey in agentRows[rowAgent]) agentRows[rowAgent][statusKey]++;
    };

    for (const ticket of statusTickets) {
      const statusKey = normalizeDbStatusForBoard(ticket.status);
      if (statusKey in statusCounts) statusCounts[statusKey]++;
    }

    for (const ticket of scopedTickets) {
      const statusKey = normalizeDbStatusForBoard(ticket.status);
      const category = String(ticket.category || 'Uncategorized').trim() || 'Uncategorized';
      categoryCounts[category] = (categoryCounts[category] || 0) + 1;
      const priority = String(ticket.priority || 'Normal').trim() || 'Normal';
      priorityCounts[priority] = (priorityCounts[priority] || 0) + 1;
      const companyName = String(ticket.companyName || 'Unknown').trim() || 'Unknown';
      companyCounts[companyName] = (companyCounts[companyName] || 0) + 1;

      const assignee = String(ticket.assignedAgent || '').trim().toUpperCase();
      const csOwner = String(ticket.csAgent || '').trim().toUpperCase();
      if (team === 'cs') addAgentRow(csOwner || 'Unassigned', statusKey);
      else if (team === 'support') addAgentRow(assignee || 'Unassigned', statusKey);
      else {
        addAgentRow(assignee || 'Unassigned', statusKey);
        if (csOwner && csOwner !== assignee) addAgentRow(csOwner, statusKey);
      }
      const csLabel = csOwner || 'Unassigned';
      csCounts[csLabel] = (csCounts[csLabel] || 0) + 1;
      if (csOwner) ticketsWithCs++;
    }

    const sortRows = obj => Object.entries(obj).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const agents = Array.from(new Set([
      ...Array.from(SUPPORT_AGENT_CODES),
      ...Array.from(CS_AGENT_CODES),
      ...tickets.flatMap(t => [t.assignedAgent, t.csAgent]).filter(Boolean).map(v => String(v).trim().toUpperCase())
    ])).sort((a, b) => a.localeCompare(b));

    return res.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      range: { key: String(req.query.range || 'today'), label: bounds.label, start: bounds.start.toISOString(), end: bounds.end.toISOString() },
      filters: { team, agent, company, jiraOnly },
      totals: {
        tickets: statusTickets.length,
        rangeTickets: scopedTickets.length,
        ticketsWithCs,
        uniqueCs: Object.keys(csCounts).filter(k => k !== 'Unassigned').length,
        jiraLinked: statusTickets.filter(t => t.jiraTicketKey).length
      },
      statusCounts,
      categoryRows: sortRows(categoryCounts).map(([category, count]) => ({ category, count })),
      priorityRows: sortRows(priorityCounts).map(([priority, count]) => ({ priority, count })),
      companyRows: sortRows(companyCounts).map(([company, count]) => ({ company, count })),
      csRows: sortRows(csCounts).map(([agent, count]) => ({ agent, count })),
      agentRows: Object.values(agentRows).sort((a, b) => b.total - a.total || a.agent.localeCompare(b.agent)),
      jiraRows: scopedTickets.filter(t => t.jiraTicketKey).slice(0, 50).map(t => ({
        ticket: t.subject || '(no subject)',
        company: t.companyName || 'Unknown',
        agent: t.assignedAgent || 'Unassigned',
        jira: t.jiraTicketKey,
        createdAt: t.createdAt
      })),
      agents
    });
  } catch (error) {
    console.error('Read ticket KPIs failed:', error);
    return res.status(500).json({ error: 'read_ticket_kpis_failed' });
  }
});
app.get('/api/tickets/:id/audit', requireAdmin, async (req, res) => {
  const ticketId = Number(req.params.id);

  if (!Number.isInteger(ticketId) || ticketId <= 0) {
    return res.status(400).json({ error: 'invalid_ticket_id' });
  }

  try {
    const ticket = await prisma.ticket.findUnique({
      where: { id: ticketId }
    });

    if (!ticket) {
      return res.status(404).json({ error: 'ticket_not_found' });
    }

    const events = await prisma.ticketEvent.findMany({
      where: { ticketId },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            role: true,
            displayName: true,
            email: true
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    return res.json({
      ticket,
      events
    });
  } catch (error) {
    console.error('Read ticket audit failed:', error);
    return res.status(500).json({ error: 'read_ticket_audit_failed' });
  }
});

app.get('/api/audit/tickets', requireAdmin, async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 100), 500);

  try {
    const events = await prisma.ticketEvent.findMany({
      take: limit,
      include: {
        ticket: true,
        user: {
          select: {
            id: true,
            username: true,
            role: true,
            displayName: true,
            email: true
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    return res.json({ events });
  } catch (error) {
    console.error('Read ticket audit list failed:', error);
    return res.status(500).json({ error: 'read_ticket_audit_list_failed' });
  }
});
app.get('/audit/tickets', requireAdmin, (req, res) => {
  return res.type('html').send(`
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="icon" type="image/svg+xml" sizes="any" href="/favicon.svg?v=q-logo-tab-v3" />
  <link rel="shortcut icon" type="image/svg+xml" href="/favicon.svg?v=q-logo-tab-v3" />
  <title>Ticket Audit Log</title>
  <style>
    body {
      margin: 0;
      font-family: Inter, Arial, sans-serif;
      background: #f5f7fb;
      color: #0f172a;
    }

    header {
      background: #0f172a;
      color: white;
      padding: 18px 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    header a {
      color: white;
      text-decoration: none;
      border: 1px solid rgba(255,255,255,.2);
      padding: 8px 12px;
      border-radius: 10px;
    }

    main {
      padding: 24px;
      max-width: 1200px;
      margin: 0 auto;
    }

    .card {
      background: white;
      border: 1px solid #e2e8f0;
      border-radius: 18px;
      box-shadow: 0 12px 34px rgba(15,23,42,.08);
      overflow: hidden;
    }

    .toolbar {
      padding: 16px;
      border-bottom: 1px solid #e2e8f0;
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
    }

    button {
      border: 0;
      background: #4f46e5;
      color: white;
      padding: 10px 14px;
      border-radius: 10px;
      font-weight: 800;
      cursor: pointer;
    }

    table {
      width: 100%;
      border-collapse: collapse;
    }

    th, td {
      padding: 12px 14px;
      border-bottom: 1px solid #e2e8f0;
      text-align: left;
      font-size: 13px;
      vertical-align: top;
    }

    th {
      background: #f8fafc;
      color: #64748b;
      text-transform: uppercase;
      font-size: 11px;
      letter-spacing: .04em;
    }

    .muted {
      color: #64748b;
    }

    .pill {
      display: inline-block;
      padding: 4px 8px;
      border-radius: 999px;
      background: #eef2ff;
      color: #4338ca;
      font-weight: 800;
      font-size: 11px;
    }

    .empty {
      padding: 40px;
      text-align: center;
      color: #94a3b8;
    }
  </style>
</head>
<body>
  <header>
    <strong>Ticket Audit Log</strong>
    <div style="display:flex;gap:10px;">
      <a href="/">Board</a>
      <a href="/profile">Profile</a>
    </div>
  </header>

  <main>
    <section class="card">
      <div class="toolbar">
        <div>
          <strong>Recent ticket activity</strong>
          <div class="muted" style="font-size:12px;margin-top:3px;">
            Created tickets, status changes, assignments, priorities, and other tracked edits.
          </div>
        </div>
        <button id="refreshBtn">Refresh</button>
      </div>

      <div id="content">
        <div class="empty">Loading audit log...</div>
      </div>
    </section>
  </main>

  <script>
    function esc(value) {
      return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
    }

    function formatDate(value) {
      if (!value) return '-';
      return new Date(value).toLocaleString();
    }

    function formatUser(user) {
      if (!user) return 'System';
      return user.displayName || user.username || 'User #' + user.id;
    }

    async function loadAudit() {
      const content = document.getElementById('content');
      content.innerHTML = '<div class="empty">Loading audit log...</div>';

      try {
        const res = await fetch('/api/audit/tickets?limit=200', {
          credentials: 'same-origin'
        });

        const data = await res.json();

        if (!res.ok) {
          throw new Error(data.error || 'Could not load audit log');
        }

        const events = data.events || [];

        if (!events.length) {
          content.innerHTML = '<div class="empty">No ticket audit events yet.</div>';
          return;
        }

        content.innerHTML = \`
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Ticket</th>
                <th>Action</th>
                <th>Old</th>
                <th>New</th>
                <th>User</th>
              </tr>
            </thead>
            <tbody>
              \${events.map(event => \`
                <tr>
                  <td>\${esc(formatDate(event.createdAt))}</td>
                  <td>
                    <strong>\${esc(event.ticket?.subject || 'Ticket #' + event.ticketId)}</strong>
                    <div class="muted">ID: \${esc(event.ticketId)}</div>
                  </td>
                  <td><span class="pill">\${esc(event.eventType)}</span></td>
                  <td>\${esc(event.oldValue || '-')}</td>
                  <td>\${esc(event.newValue || '-')}</td>
                  <td>\${esc(formatUser(event.user))}</td>
                </tr>
              \`).join('')}
            </tbody>
          </table>
        \`;
      } catch (error) {
        content.innerHTML = '<div class="empty">' + esc(error.message || 'Could not load audit log') + '</div>';
      }
    }

    document.getElementById('refreshBtn').addEventListener('click', loadAudit);
    loadAudit();
  </script>
</body>
</html>
  `);
});

app.get('/api/tickets/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid_ticket_id' });
  const ticket = await prisma.ticket.findUnique({
    where: { id },
    include: { comments: { include: { user: true }, orderBy: { createdAt: 'asc' } }, events: { include: { user: true }, orderBy: { createdAt: 'asc' } } }
  });
  if (!ticket) return res.status(404).json({ error: 'ticket_not_found' });
  res.json({ ticket });
});

// --- Claude MCP connector -------------------------------------------------
// Self-service token issuance (cookie-session authenticated, one active
// token per user - regenerating revokes the previous one). The plaintext
// token is only ever returned here, once; only its SHA-256 hash is stored.
const mcpTokenLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });
app.get('/api/mcp/token', requireAuth, async (req, res) => {
  const token = await prisma.apiToken.findFirst({
    where: { userId: req.session.userId, revokedAt: null },
    orderBy: { createdAt: 'desc' }
  });
  res.json({ token: token ? { createdAt: token.createdAt, lastUsedAt: token.lastUsedAt } : null });
});
app.post('/api/mcp/token', requireAuth, mcpTokenLimiter, async (req, res) => {
  try {
    await prisma.apiToken.updateMany({
      where: { userId: req.session.userId, revokedAt: null },
      data: { revokedAt: new Date() }
    });
    const rawToken = `kb_${crypto.randomBytes(32).toString('base64url')}`;
    const created = await prisma.apiToken.create({
      data: { userId: req.session.userId, tokenHash: hashApiToken(rawToken), label: 'Claude MCP connector' }
    });
    res.json({ token: rawToken, createdAt: created.createdAt });
  } catch (error) {
    console.error('Token generation failed:', error.message || error);
    res.status(500).json({ error: 'token_generation_failed' });
  }
});
app.delete('/api/mcp/token', requireAuth, async (req, res) => {
  await prisma.apiToken.updateMany({
    where: { userId: req.session.userId, revokedAt: null },
    data: { revokedAt: new Date() }
  });
  res.json({ ok: true });
});

// Ticket API surface backing the Claude MCP connector - reached either via
// the plain REST routes below (used by the standalone mcp-server/ service,
// which forwards the caller's own Bearer token straight through) or directly
// via the in-process /mcp route further down. Both paths call the same
// mcp*() functions so there's exactly one implementation of each operation.
const mcpApiLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });
const MCP_TICKET_SELECT = {
  id: true, externalId: true, displayNumber: true, subject: true, senderName: true, senderEmail: true, companyName: true,
  status: true, priority: true, category: true, assignedAgent: true, csAgent: true, jiraTicketKey: true,
  hubspotTicketId: true, createdAt: true, updatedAt: true, resolvedAt: true
};
const MCP_WRITABLE_STATUSES = new Set(['New', 'In Progress', 'Waiting on Us', 'Due for Test', 'Waiting on Contact', 'Resolved']);

// The board shows agents a short display number (e.g. "#0042") - completely
// different from Ticket.id (the DB primary key) and externalId (a long
// Outlook message ID). MCP tools used to only expose the DB id, so Claude
// had no way to know it wasn't the number agents actually mean when they say
// "ticket 42". Ticket.displayNumber is Postgres-assigned (its own sequence,
// atomic, survives restarts) - hydrateStateFromDatabase seeds it into the
// same ticketNumbers map the board's own ensureTicketNumber() already reads,
// so the board and MCP always agree on the same number with no frontend
// changes needed.
function withMcpTicketNumber(ticket) {
  if (!ticket) return ticket;
  const { id, displayNumber, ...rest } = ticket;
  return { ticketNumber: displayNumber ? `#${String(displayNumber).padStart(4, '0')}` : null, internalId: id, ...rest };
}

async function mcpListTickets({ status, assignee, q, limit }) {
  const where = {};
  if (status) where.status = String(status);
  if (assignee) where.assignedAgent = String(assignee).trim().toUpperCase();
  if (q) {
    const term = String(q).trim();
    where.OR = [
      { subject: { contains: term, mode: 'insensitive' } },
      { companyName: { contains: term, mode: 'insensitive' } },
      { senderEmail: { contains: term, mode: 'insensitive' } }
    ];
  }
  const take = Math.min(Number(limit) || 50, 200);
  const tickets = await prisma.ticket.findMany({ where, take, orderBy: { updatedAt: 'desc' }, select: MCP_TICKET_SELECT });
  return tickets.map(withMcpTicketNumber);
}

async function mcpGetTicket(id) {
  if (!Number.isInteger(id) || id <= 0) throw Object.assign(new Error('invalid_ticket_id'), { status: 400 });
  const ticket = await prisma.ticket.findUnique({ where: { id }, include: { comments: { orderBy: { createdAt: 'asc' } } } });
  if (!ticket) throw Object.assign(new Error('ticket_not_found'), { status: 404 });
  return withMcpTicketNumber(ticket);
}

async function mcpAddComment(apiUser, id, rawText) {
  const text = String(rawText || '').trim();
  if (!Number.isInteger(id) || id <= 0) throw Object.assign(new Error('invalid_ticket_id'), { status: 400 });
  if (!text) throw Object.assign(new Error('text_required'), { status: 400 });
  const ticket = await prisma.ticket.findUnique({ where: { id } });
  if (!ticket) throw Object.assign(new Error('ticket_not_found'), { status: 404 });
  const comment = await prisma.ticketComment.create({ data: { ticketId: id, userId: apiUser.id, comment: text, isInternal: true } });
  await createTicketAuditEvent({ ticketId: id, userId: apiUser.id, eventType: 'comment_added', newValue: text.slice(0, 200), metadata: { via: 'mcp' } });
  return comment;
}

async function mcpUpdateTicket(apiUser, id, fields) {
  if (!Number.isInteger(id) || id <= 0) throw Object.assign(new Error('invalid_ticket_id'), { status: 400 });
  const existingTicket = await prisma.ticket.findUnique({ where: { id } });
  if (!existingTicket) throw Object.assign(new Error('ticket_not_found'), { status: 404 });

  const data = {};
  if (fields?.status !== undefined) {
    const status = String(fields.status || '').trim();
    if (!MCP_WRITABLE_STATUSES.has(status)) throw Object.assign(new Error('invalid_status'), { status: 400 });
    data.status = status;
    data.resolvedAt = status === 'Resolved' ? new Date() : null;
    if (status !== 'Resolved') data.resolvedTeamsNotifiedAt = null;
  }
  if (fields?.assignedAgent !== undefined) data.assignedAgent = fields.assignedAgent ? String(fields.assignedAgent).trim().toUpperCase() : null;
  if (fields?.csAgent !== undefined) data.csAgent = fields.csAgent ? String(fields.csAgent).trim().toUpperCase() : null;
  if (fields?.priority !== undefined) data.priority = String(fields.priority || 'Normal').trim();
  if (!Object.keys(data).length) throw Object.assign(new Error('no_fields'), { status: 400 });

  const updated = await prisma.ticket.update({ where: { id }, data });
  await auditTicketChanges({ ticketId: id, userId: apiUser.id, before: existingTicket, after: updated, fields: ['status', 'assignedAgent', 'csAgent', 'priority'] });

  if (data.status === 'Resolved' && existingTicket.status !== 'Resolved') {
    const alert = await claimResolvedTeamsAlert({
      ticketDbId: updated.id,
      externalId: updated.externalId || String(updated.id),
      csAgent: updated.csAgent,
      category: updated.category,
      subject: updated.subject,
      companyName: updated.companyName,
      jiraTicketKey: updated.jiraTicketKey,
      assignedAgent: updated.assignedAgent
    });
    if (alert) void sendResolvedTeamsNotifications([alert]).catch((error) => console.warn('Resolved Teams notification failed:', error?.message || error));
  }

  return withMcpTicketNumber(updated);
}

function mcpHttpErrorStatus(error) {
  return Number.isInteger(error?.status) ? error.status : 500;
}

app.get('/api/mcp/tickets', requireApiToken, mcpApiLimiter, async (req, res) => {
  const tickets = await mcpListTickets(req.query);
  res.json({ tickets });
});
app.get('/api/mcp/tickets/:id', requireApiToken, mcpApiLimiter, async (req, res) => {
  try {
    const ticket = await mcpGetTicket(Number(req.params.id));
    res.json({ ticket });
  } catch (error) {
    res.status(mcpHttpErrorStatus(error)).json({ error: error.message });
  }
});
app.post('/api/mcp/tickets/:id/comments', requireApiToken, mcpApiLimiter, async (req, res) => {
  try {
    const comment = await mcpAddComment(req.apiUser, Number(req.params.id), req.body?.text);
    res.json({ ok: true, comment });
  } catch (error) {
    res.status(mcpHttpErrorStatus(error)).json({ error: error.message });
  }
});
app.patch('/api/mcp/tickets/:id', requireApiToken, mcpApiLimiter, async (req, res) => {
  try {
    const updated = await mcpUpdateTicket(req.apiUser, Number(req.params.id), req.body || {});
    res.json({ ok: true, ticket: updated });
  } catch (error) {
    res.status(mcpHttpErrorStatus(error)).json({ error: error.message });
  }
});

// --- OAuth 2.1 (Authorization Code + PKCE) for the Claude connector --------
// Wraps the app's *existing* session login - there is no separate identity
// system here. A client (Claude) self-registers once (RFC 7591), then each
// individual person authorizes it by logging into the normal Kanban login
// page; the resulting access token is just a regular ApiToken row, so
// everything downstream (/mcp, /api/mcp/*) needs zero changes.
const oauthLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });
const OAUTH_CODE_TTL_MS = 5 * 60 * 1000;

function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function hashOAuthCode(rawCode) {
  return crypto.createHash('sha256').update(String(rawCode || '')).digest('hex');
}
function oauthIssuer(req) {
  return publicBaseUrlForRequest(req);
}

app.get('/.well-known/oauth-authorization-server', (req, res) => {
  const issuer = oauthIssuer(req);
  res.json({
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none']
  });
});
app.get('/.well-known/oauth-protected-resource', (req, res) => {
  const issuer = oauthIssuer(req);
  res.json({
    resource: `${issuer}/mcp`,
    authorization_servers: [issuer]
  });
});

// Dynamic Client Registration (RFC 7591). Deliberately permissive (anyone
// can register a client) - the security boundary isn't here, it's the
// strict redirect_uri exact-match enforced at /oauth/authorize and
// /oauth/token, which makes a registered client_id useless to an attacker
// without also controlling one of the redirect_uris it registered.
app.post('/oauth/register', oauthLimiter, async (req, res) => {
  const redirectUris = Array.isArray(req.body?.redirect_uris) ? req.body.redirect_uris.map(String) : [];
  if (!redirectUris.length) return res.status(400).json({ error: 'invalid_client_metadata', error_description: 'redirect_uris is required' });
  for (const uri of redirectUris) {
    try {
      const parsed = new URL(uri);
      if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && parsed.hostname === 'localhost')) {
        return res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris must be https (or http://localhost for local dev)' });
      }
    } catch (_error) {
      return res.status(400).json({ error: 'invalid_redirect_uri' });
    }
  }
  const clientId = `mcp_${crypto.randomBytes(16).toString('hex')}`;
  const clientName = req.body?.client_name ? String(req.body.client_name).slice(0, 200) : null;
  await prisma.oAuthClient.create({ data: { clientId, clientName, redirectUris } });
  res.status(201).json({
    client_id: clientId,
    client_name: clientName,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code'],
    response_types: ['code']
  });
});

function renderOAuthConsentPage({ clientName, params }) {
  const hiddenFields = Object.entries(params).map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}" />`).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Authorize Claude - Support Kanban</title>
  <style>
    body{font-family:Segoe UI,Arial,sans-serif;background:linear-gradient(135deg,#f8fafc,#e2e8f0);display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
    .card{background:#fff;padding:28px;border-radius:12px;box-shadow:0 12px 32px rgba(15,23,42,.12);width:min(420px,92vw)}
    h1{margin:0 0 8px;font-size:20px;color:#1e293b}
    p{margin:0 0 20px;color:#64748b;font-size:13px;line-height:1.5}
    .actions{display:flex;gap:10px}
    button{flex:1;padding:10px;border:none;border-radius:8px;font-weight:700;cursor:pointer}
    .allow{background:#4f46e5;color:#fff}
    .deny{background:#f1f5f9;color:#334155}
  </style>
</head>
<body>
  <form class="card" method="POST" action="/oauth/authorize/confirm">
    <h1>Authorize connector</h1>
    <p><strong>${escapeHtml(clientName || 'A Claude connector')}</strong> wants access to your Support Kanban account - it will be able to see and update tickets exactly as you can in the board. Only continue if you started this from Claude.</p>
    ${hiddenFields}
    <div class="actions">
      <button class="deny" type="submit" name="decision" value="deny">Deny</button>
      <button class="allow" type="submit" name="decision" value="allow">Allow</button>
    </div>
  </form>
</body>
</html>`;
}

app.get('/oauth/authorize', oauthLimiter, async (req, res) => {
  const { response_type, client_id, redirect_uri, state, code_challenge, code_challenge_method } = req.query;
  if (response_type !== 'code') return res.status(400).send('unsupported_response_type');
  if (!client_id || !redirect_uri || !code_challenge || code_challenge_method !== 'S256') {
    return res.status(400).send('invalid_request');
  }
  const client = await prisma.oAuthClient.findUnique({ where: { clientId: String(client_id) } });
  if (!client || !client.redirectUris.includes(String(redirect_uri))) {
    return res.status(400).send('invalid_client_or_redirect_uri');
  }
  if (!isAuthed(req)) {
    const next = `/oauth/authorize?${new URLSearchParams(req.query).toString()}`;
    return res.redirect(`/login?next=${encodeURIComponent(next)}`);
  }
  res.type('html').send(renderOAuthConsentPage({
    clientName: client.clientName,
    params: { client_id: String(client_id), redirect_uri: String(redirect_uri), state: String(state || ''), code_challenge: String(code_challenge), code_challenge_method: 'S256' }
  }));
});

app.post('/oauth/authorize/confirm', oauthLimiter, requireAuth, async (req, res) => {
  try {
    const { client_id, redirect_uri, state, code_challenge, code_challenge_method, decision } = req.body || {};
    const client = await prisma.oAuthClient.findUnique({ where: { clientId: String(client_id || '') } });
    if (!client || !client.redirectUris.includes(String(redirect_uri || ''))) {
      return res.status(400).send('invalid_client_or_redirect_uri');
    }
    const redirectUrl = new URL(String(redirect_uri));
    if (decision !== 'allow') {
      redirectUrl.searchParams.set('error', 'access_denied');
      if (state) redirectUrl.searchParams.set('state', String(state));
      return res.redirect(redirectUrl.toString());
    }
    const rawCode = crypto.randomBytes(32).toString('hex');
    await prisma.oAuthAuthCode.create({
      data: {
        codeHash: hashOAuthCode(rawCode),
        clientId: client.id,
        userId: req.session.userId,
        redirectUri: String(redirect_uri),
        codeChallenge: String(code_challenge),
        codeChallengeMethod: String(code_challenge_method || 'S256'),
        expiresAt: new Date(Date.now() + OAUTH_CODE_TTL_MS)
      }
    });
    redirectUrl.searchParams.set('code', rawCode);
    if (state) redirectUrl.searchParams.set('state', String(state));
    res.redirect(redirectUrl.toString());
  } catch (error) {
    console.error('OAuth authorize confirm failed:', error.message || error);
    res.status(400).send('invalid_request');
  }
});

app.post('/oauth/token', oauthLimiter, async (req, res) => {
 try {
  const { grant_type, code, redirect_uri, client_id, code_verifier } = req.body || {};
  if (grant_type !== 'authorization_code') return res.status(400).json({ error: 'unsupported_grant_type' });
  if (!code || !redirect_uri || !client_id || !code_verifier) return res.status(400).json({ error: 'invalid_request' });

  const client = await prisma.oAuthClient.findUnique({ where: { clientId: String(client_id) } });
  if (!client) return res.status(400).json({ error: 'invalid_client' });

  const codeHash = hashOAuthCode(code);
  // Atomic single-use claim, same pattern as the Resolved-Teams-DM and
  // token dedup elsewhere in this file - a single UPDATE ... WHERE usedAt
  // IS NULL guard means a replayed/duplicated exchange can never succeed
  // twice, no read-then-write race.
  const claimed = await prisma.$executeRaw`UPDATE "OAuthAuthCode" SET "usedAt" = NOW() WHERE "codeHash" = ${codeHash} AND "usedAt" IS NULL`;
  if (claimed <= 0) return res.status(400).json({ error: 'invalid_grant' });

  const authCode = await prisma.oAuthAuthCode.findUnique({ where: { codeHash } });
  if (!authCode || authCode.clientId !== client.id || authCode.redirectUri !== String(redirect_uri) || authCode.expiresAt.getTime() < Date.now()) {
    return res.status(400).json({ error: 'invalid_grant' });
  }
  const expectedChallenge = base64url(crypto.createHash('sha256').update(String(code_verifier)).digest());
  if (expectedChallenge !== authCode.codeChallenge) {
    return res.status(400).json({ error: 'invalid_grant', error_description: 'code_verifier mismatch' });
  }

  const user = await prisma.user.findUnique({ where: { id: authCode.userId } });
  if (!user || user.isActive === false) return res.status(400).json({ error: 'invalid_grant' });

  const rawToken = `kb_${crypto.randomBytes(32).toString('base64url')}`;
  await prisma.apiToken.create({ data: { userId: user.id, tokenHash: hashApiToken(rawToken), label: `OAuth (${client.clientName || client.clientId})` } });

  res.json({ access_token: rawToken, token_type: 'Bearer' });
 } catch (error) {
  console.error('OAuth token exchange failed:', error.message || error);
  res.status(400).json({ error: 'invalid_request' });
 }
});

// In-process MCP protocol endpoint - the same Bearer token used above, but
// speaking actual MCP (JSON-RPC over Streamable HTTP) so it can be added as
// a Claude custom connector directly, with no separate service to deploy.
const TICKET_STATUS_ENUM = ['New', 'In Progress', 'Waiting on Us', 'Due for Test', 'Waiting on Contact', 'Resolved'];
let mcpSdkModules = null;
async function loadMcpSdk() {
  if (!mcpSdkModules) {
    const [{ McpServer }, { StreamableHTTPServerTransport }, { z }] = await Promise.all([
      import('@modelcontextprotocol/sdk/server/mcp.js'),
      import('@modelcontextprotocol/sdk/server/streamableHttp.js'),
      import('zod')
    ]);
    mcpSdkModules = { McpServer, StreamableHTTPServerTransport, z };
  }
  return mcpSdkModules;
}
function mcpTextResult(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}
function mcpErrorResult(error) {
  return { content: [{ type: 'text', text: error?.message || String(error) }], isError: true };
}
function buildKanbanMcpServer(apiUser, { McpServer, z }) {
  const server = new McpServer({ name: 'support-kanban', version: '1.0.0' });

  server.registerTool(
    'list_tickets',
    {
      title: 'List support tickets',
      description: 'List/search tickets on the Support Kanban board. Filter by status, assignee, or a free-text search term. Each result has both a "ticketNumber" (e.g. "#0042" - the number agents actually use when they refer to a ticket, shown on the board) and an "internalId" (a database id, only useful as the ticketId argument to get_ticket/add_comment/update_ticket). Always report ticketNumber to the user, never internalId.',
      inputSchema: {
        status: z.enum(TICKET_STATUS_ENUM).optional(),
        assignee: z.string().optional().describe('Agent trigram, e.g. MBH'),
        q: z.string().optional().describe('Free-text search over subject, company name, and sender email'),
        limit: z.number().int().min(1).max(200).optional()
      }
    },
    async (args) => {
      try { return mcpTextResult(await mcpListTickets(args)); } catch (error) { return mcpErrorResult(error); }
    }
  );

  server.registerTool(
    'get_ticket',
    {
      title: 'Get ticket detail',
      description: 'Get full detail for one ticket, including its comments. Report the returned "ticketNumber" (e.g. "#0042") to the user, not "internalId".',
      inputSchema: { ticketId: z.number().int().positive().describe('The internalId from list_tickets/get_ticket - not the #-prefixed ticketNumber shown on the board.') }
    },
    async ({ ticketId }) => {
      try { return mcpTextResult(await mcpGetTicket(ticketId)); } catch (error) { return mcpErrorResult(error); }
    }
  );

  server.registerTool(
    'add_comment',
    {
      title: 'Add a comment to a ticket',
      description: 'Add an internal comment to a ticket.',
      inputSchema: {
        ticketId: z.number().int().positive().describe('The internalId from list_tickets/get_ticket - not the #-prefixed ticketNumber shown on the board.'),
        text: z.string().min(1)
      }
    },
    async ({ ticketId, text }) => {
      try { return mcpTextResult(await mcpAddComment(apiUser, ticketId, text)); } catch (error) { return mcpErrorResult(error); }
    }
  );

  server.registerTool(
    'update_ticket',
    {
      title: 'Update a ticket',
      description: 'Move a ticket to a new stage, (re)assign it, or change its priority. Only send the fields you want to change.',
      inputSchema: {
        ticketId: z.number().int().positive().describe('The internalId from list_tickets/get_ticket - not the #-prefixed ticketNumber shown on the board.'),
        status: z.enum(TICKET_STATUS_ENUM).optional(),
        assignedAgent: z.string().optional().describe('Agent trigram to assign, or empty string to unassign'),
        csAgent: z.string().optional().describe('CS owner trigram, or empty string to clear'),
        priority: z.enum(['Low', 'Normal', 'High', 'Urgent']).optional()
      }
    },
    async ({ ticketId, ...fields }) => {
      try { return mcpTextResult(await mcpUpdateTicket(apiUser, ticketId, fields)); } catch (error) { return mcpErrorResult(error); }
    }
  );

  return server;
}
async function handleMcpRequest(req, res) {
  try {
    const sdk = await loadMcpSdk();
    const server = buildKanbanMcpServer(req.apiUser, sdk);
    const transport = new sdk.StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('MCP request failed:', error);
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
  }
}
app.post('/mcp', requireApiToken, mcpApiLimiter, handleMcpRequest);
// Same endpoint, different path - kept distinct from /mcp because Claude's
// connector UI deduplicates custom connectors by URL. The org already has a
// "Quinta Support Kanban" connector registered at /mcp configured for OAuth
// (which this app doesn't implement), so any plugin pointing back at that
// same URL inherits that broken OAuth requirement instead of using its own
// Bearer-token header. This path lets the personal-token plugin connect
// without colliding with that org-level registration.
app.post('/mcp-plugin', requireApiToken, mcpApiLimiter, handleMcpRequest);

// ---------------------------------------------------------------------------
// Live sync (SSE)
//
// Before this, loadState() ran exactly once at boot and nothing ever re-read
// server state, so every open tab held its own drifting copy of the board:
// an agent's move was invisible to everyone else until they refreshed, and a
// lagging tab's next full-snapshot save would silently revert it.
//
// Rather than rewrite every mutation into a granular endpoint at once, the
// server diffs consecutive board snapshots on save and pushes just the
// changed ticket fields. Clients apply those patches into the same keyed maps
// they already render from, so the board updates in place.
//
// Single-instance only: SSE_CLIENTS is per-process. If this ever runs with
// more than one replica, sseBroadcast() needs to fan out through Postgres
// LISTEN/NOTIFY so clients on other replicas still get patches.
// ---------------------------------------------------------------------------
const SSE_CLIENTS = new Set();
const SSE_BUFFER = [];
const SSE_BUFFER_MAX = 500;
// Above this many changed fields in one save, patching costs more than a
// reload - tell clients to re-pull instead of shipping a huge frame.
const SSE_PATCH_MAX = 400;
let sseRev = 0;

// Per-ticket keyed maps that clients render from. Anything not listed here is
// session-local (caches, read-receipts) and deliberately not broadcast.
const LIVE_SYNC_FIELDS = [
  'ticketState', 'ticketStageTouchedAt', 'ticketAssignee', 'ticketCSOwner',
  'ticketAssignmentMode', 'manualSupportOverride', 'manualCSOverride',
  'ticketPriority', 'ticketCategory', 'ticketSubtype', 'ticketJira',
  'ticketHubspotId', 'ticketArchived', 'ticketResolutionMeta',
  'ticketHasNewReply', 'ticketNumbers', 'ticketComments', 'ticketCreatedBy'
];

function sseFrame(rev, type, data) {
  return `id: ${rev}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sseBroadcast(type, data) {
  sseRev += 1;
  const rev = sseRev;
  SSE_BUFFER.push({ rev, type, data });
  if (SSE_BUFFER.length > SSE_BUFFER_MAX) SSE_BUFFER.splice(0, SSE_BUFFER.length - SSE_BUFFER_MAX);
  const frame = sseFrame(rev, type, data);
  SSE_CLIENTS.forEach((client) => {
    try { client.write(frame); } catch (_) { SSE_CLIENTS.delete(client); }
  });
  return rev;
}

function diffBoardMaps(before, after) {
  const changes = [];
  for (const field of LIVE_SYNC_FIELDS) {
    const prev = (before && typeof before[field] === 'object' && before[field]) || {};
    const next = (after && typeof after[field] === 'object' && after[field]) || {};
    for (const id of new Set([...Object.keys(prev), ...Object.keys(next)])) {
      // JSON compare so object-valued maps (ticketResolutionMeta, comment
      // arrays) diff by content rather than by reference.
      if (JSON.stringify(prev[id]) === JSON.stringify(next[id])) continue;
      changes.push({ id, field, value: next[id] === undefined ? null : next[id] });
      if (changes.length > SSE_PATCH_MAX) return { changes, overflow: true };
    }
  }
  return { changes, overflow: false };
}

function diffBoardTickets(before, after) {
  const prevIds = new Set((Array.isArray(before?.allTickets) ? before.allTickets : []).map(t => String(t?.id || '')));
  const nextList = Array.isArray(after?.allTickets) ? after.allTickets : [];
  const nextIds = new Set(nextList.map(t => String(t?.id || '')));
  return {
    added: nextList.filter(t => t && t.id && !prevIds.has(String(t.id))),
    removed: [...prevIds].filter(id => id && !nextIds.has(id))
  };
}

app.get('/api/events', requireAuth, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Stops nginx/ingress from buffering the stream into uselessness.
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 3000\n\n');

  // Replay anything the client missed while disconnected. EventSource sends
  // Last-Event-ID automatically on reconnect, so a dropped connection
  // resumes instead of silently losing patches.
  const lastEventId = Number(req.headers['last-event-id'] || req.query.lastEventId || 0);
  if (Number.isFinite(lastEventId) && lastEventId > 0) {
    const missed = SSE_BUFFER.filter(e => e.rev > lastEventId);
    // Gap wider than the buffer - can't prove we're complete, so make the
    // client re-pull rather than hand it a partial history.
    if (missed.length && missed[0].rev > lastEventId + 1) {
      res.write(sseFrame(sseRev, 'board_reload', { reason: 'replay_gap' }));
    } else {
      missed.forEach(e => res.write(sseFrame(e.rev, e.type, e.data)));
    }
  }

  res.write(sseFrame(sseRev, 'hello', { rev: sseRev, actor: String(req.session.username || '').toUpperCase() }));
  SSE_CLIENTS.add(res);

  const keepAlive = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) {}
  }, 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    SSE_CLIENTS.delete(res);
    try { res.end(); } catch (_) {}
  });
});

app.get('/api/state', requireAuth, async (req, res) => {
  try {
    const state = await hydrateStateFromDatabase(safeReadState());
    res.json({ ...state, _liveRev: sseRev });
  } catch (error) {
    console.error('State hydrate failed:', error);
    res.json({ ...safeReadState(), _liveRev: sseRev });
  }
});
app.post('/api/state', requireAuth, async (req, res) => {
  const state = req.body || {};
  // Snapshot before the write so we can broadcast just what actually changed.
  const beforeState = safeReadState();
  const result = await safeWriteState(state);
  let ticketDb = { count: 0 };
  try {
    ticketDb = await upsertBoardTicketsToDatabase(result.state || state, req);
  } catch (error) {
    console.error('Ticket database sync failed:', error);
    await prisma.syncLog.create({
      data: { provider: 'kanban', syncType: 'board_state_to_ticket_db', status: 'error', message: error.message || String(error) }
    }).catch(() => null);
  }
  const { state: _fullState, ...resultSummary } = result;

  // Push the delta to every other open board. Note this reflects the MERGED
  // post-write state, not the raw payload - so a stale tab's rejected fields
  // broadcast as the value that actually won, which self-heals that tab.
  let liveRev = sseRev;
  try {
    const afterState = result.state || safeReadState();
    const { changes, overflow } = diffBoardMaps(beforeState, afterState);
    const { added, removed } = diffBoardTickets(beforeState, afterState);
    const actor = String(req.session.username || '').toUpperCase() || null;
    // origin lets the sending tab ignore its own echo, so a patch in flight
    // can't roll back an edit the user made in the meantime.
    const origin = String(state?._meta?.clientId || '') || null;
    if (overflow) {
      liveRev = sseBroadcast('board_reload', { reason: 'patch_overflow', actor });
    } else if (changes.length || added.length || removed.length) {
      liveRev = sseBroadcast('board_patch', { actor, origin, changes, added, removed });
    }
  } catch (error) {
    // A broadcast failure must never fail the save that already succeeded.
    console.error('Live sync broadcast failed:', error?.message || error);
  }

  res.json({ ok: !!result.saved, ...resultSummary, ticketDb, liveRev });
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

    const baseProps = ['name', 'country', 'co_owner', 'co-owner', 'coowner', 'co_owner_name', 'cs_owner', 'customer_success_owner', 'am_owner', 'account_manager', 'am', 'parent_company_id'];
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
          coOwner: parent.properties?.co_owner || parent.properties?.['co-owner'] || parent.properties?.coowner || parent.properties?.co_owner_name || parent.properties?.cs_owner || parent.properties?.customer_success_owner || parent.properties?.am_owner || parent.properties?.account_manager || parent.properties?.am || null
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
      coOwner: c.properties?.co_owner || c.properties?.['co-owner'] || c.properties?.coowner || c.properties?.co_owner_name || c.properties?.cs_owner || c.properties?.customer_success_owner || c.properties?.am_owner || c.properties?.account_manager || c.properties?.am || null
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
            coOwner: c?.properties?.co_owner || c?.properties?.['co-owner'] || c?.properties?.coowner || c?.properties?.co_owner_name || c?.properties?.cs_owner || c?.properties?.customer_success_owner || c?.properties?.am_owner || c?.properties?.account_manager || c?.properties?.am || null,
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
        coOwner: props.co_owner || props['co-owner'] || props.coowner || props.co_owner_name || props.cs_owner || props.customer_success_owner || props.am_owner || props.account_manager || props.am || null,
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
    const token = await getHubspotAccessToken(req);
    const cached = getCachedDataHygienePayload();

    if (!force && cached?.meta?.cacheFresh) return res.json(cached);

    if (!force && cached) {
      void refreshDataHygieneCache(token).catch(err => console.warn('Data hygiene background refresh failed:', err.message || err));
      return res.json({
        ...cached,
        meta: { ...(cached.meta || {}), backgroundRefresh: true }
      });
    }

    return res.json(await refreshDataHygieneCache(token));
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
      const top = Math.min(Math.max(Number(args?.limit || 20), 1), 200);
      const select = '$select=id,subject,bodyPreview,from,toRecipients,ccRecipients,receivedDateTime,webLink,conversationId,internetMessageId';
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

app.post('/api/qt-seize/outpaint', requireAuth, async (req, res) => {
  const imageDataUrl = String(req.body?.imageDataUrl || '');
  const maskDataUrl = String(req.body?.maskDataUrl || '');
  const prompt = String(req.body?.prompt || '').trim();

  if (!imageDataUrl || !maskDataUrl) {
    return res.status(400).json({ error: 'missing_image_or_mask' });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({ error: 'missing_openai_api_key' });
  }

  const workerPath = path.join(__dirname, 'scripts', 'qt_seize_outpaint.py');
  const pythonCmd = process.env.PYTHON || process.env.PYTHON_BIN || 'python';
  const child = spawn(pythonCmd, [workerPath], {
    cwd: __dirname,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const timeout = setTimeout(() => child.kill('SIGTERM'), 120000);
  let stdout = '';
  let stderr = '';

  child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
  child.stdin.end(JSON.stringify({ imageDataUrl, maskDataUrl, prompt }));

  child.on('error', error => {
    clearTimeout(timeout);
    return res.status(500).json({ error: 'python_worker_failed', detail: String(error.message || error) });
  });

  child.on('close', code => {
    clearTimeout(timeout);
    if (code !== 0) {
      return res.status(500).json({ error: 'outpaint_failed', detail: stderr.slice(0, 1200) || stdout.slice(0, 1200) });
    }
    try {
      const payload = JSON.parse(stdout);
      if (!payload?.imageDataUrl) return res.status(500).json({ error: 'missing_ai_image' });
      return res.json(payload);
    } catch (error) {
      return res.status(500).json({ error: 'invalid_worker_response', detail: String(error.message || error) });
    }
  });
});

app.get(['/qt-seize', '/qt-seize/'], requireAuth, (req, res) => {
  res.type('html').sendFile(path.join(__dirname, 'public', 'qt-seize', 'index.html'));
});
app.use('/qt-seize', requireAuth, express.static(path.join(__dirname, 'public', 'qt-seize')));
app.use('/assets', requireAuth, express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => isAuthed(req) ? res.type('html').sendFile(path.join(__dirname, 'index.html')) : res.redirect('/login'));

const server = app.listen(PORT, () => {
  console.log(`Support Kanban secure web app on http://localhost:${PORT}`);
  if (SESSION_SECRET === 'change-this-session-secret') {
    console.log('WARNING: Set SESSION_SECRET before production use.');
  }
});

server.on('error', (err) => {
  if (err?.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use.`);
    console.error('Stop the existing server using that port, or set a different PORT in .env before running npm start.');
    console.error(`On Windows, you can find the process with: netstat -ano | findstr :${PORT}`);
    process.exit(1);
  }

  throw err;
});
