#!/usr/bin/env node
/*
 * Is the Microsoft 365 connection actually able to read mail?
 *
 * Run this whenever tickets open without their formatting or their images:
 *
 *   node scripts/check-m365.js
 *
 * That symptom has one cause and several disguises. The board keeps working
 * (tickets, notes, assignment and SLA all live in our own database), the modal
 * still shows text, and Graph's failure arrives as a bare 401 - so it reads as
 * a rendering bug for as long as nobody thinks to check the credential. This
 * checks the credential.
 *
 * It is read-only. It asks Azure for an app-only token, which validates the
 * client secret and nothing else, and prints what came back. No secret is
 * printed, nothing is stored, and no message is touched.
 *
 * The two failures look almost identical in the logs and need opposite fixes:
 *
 *   invalid_client (401, AADSTS7000215/7000222)
 *     The app's own secret is wrong or expired. Reconnecting achieves nothing.
 *     Azure portal > App registrations > this app > Certificates & secrets >
 *     New client secret, then copy the VALUE column - not the Secret ID - into
 *     M365_CLIENT_SECRET and restart. A GUID-shaped value is always the ID.
 *
 *   invalid_grant (400, AADSTS70008x)
 *     The secret is fine; the stored refresh token has expired or been revoked.
 *     Sign in again at /auth/microsoft/start.
 */
require('dotenv').config();

const tenant = process.env.M365_TENANT_ID || '';
const clientId = process.env.M365_CLIENT_ID || '';
const secret = process.env.M365_CLIENT_SECRET || '';
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function line(label, value) {
  console.log(`  ${label.padEnd(20)} ${value}`);
}

(async () => {
  console.log('\nMicrosoft 365 configuration');
  line('M365_TENANT_ID', tenant ? `${tenant.slice(0, 8)}...` : 'MISSING');
  line('M365_CLIENT_ID', clientId ? `${clientId.slice(0, 8)}...` : 'MISSING');
  line('M365_CLIENT_SECRET', secret ? `set, ${secret.length} chars` : 'MISSING');
  line('M365_REDIRECT_URI', process.env.M365_REDIRECT_URI || '(localhost default)');
  line('SUPPORT_MAILBOX', process.env.SUPPORT_MAILBOX || 'helpdesk@quinta.im');

  if (!tenant || !clientId || !secret) {
    console.log('\nFAIL: required variables are missing. Nothing can reach Graph until they are set.\n');
    process.exitCode = 1;
    return;
  }

  if (GUID_RE.test(secret)) {
    console.log('\nFAIL: M365_CLIENT_SECRET is GUID-shaped, so it is the client secret ID, not the');
    console.log('      secret VALUE. Azure will reject every token request with AADSTS7000215 and');
    console.log('      no ticket can load its body or its inline images.');
    console.log('      Fix: Certificates & secrets > New client secret > copy the Value column.\n');
    process.exitCode = 1;
    return;
  }

  const form = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: secret,
    scope: 'https://graph.microsoft.com/.default'
  });
  let res, body;
  try {
    res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form
    });
    body = await res.json().catch(() => ({}));
  } catch (err) {
    console.log(`\nFAIL: could not reach login.microsoftonline.com (${err.message}).\n`);
    process.exitCode = 1;
    return;
  }

  console.log(`\nAzure AD token endpoint: HTTP ${res.status}`);
  if (!res.ok) {
    line('error', String(body.error || '(none)'));
    line('error_codes', JSON.stringify(body.error_codes || []));
    console.log(`  ${String(body.error_description || '').split(/\r?\n/)[0]}`);
    if (body.error === 'invalid_client') {
      console.log('\nFAIL: the client secret is rejected. It has expired, or the wrong value was');
      console.log('      pasted. An admin must renew it in Azure and update M365_CLIENT_SECRET.');
      console.log('      Reconnecting Outlook in the app will NOT help.\n');
    } else {
      console.log('\nFAIL: see the description above.\n');
    }
    process.exitCode = 1;
    return;
  }

  console.log('\nOK: the client secret is valid.');
  // App-only tokens carry the application permissions the tenant granted. The
  // board reads mail with DELEGATED permissions, so an empty list here is
  // normal and not a problem - it is printed only because it is free context
  // when someone is deciding whether app-only access is an option.
  try {
    const claims = JSON.parse(Buffer.from(String(body.access_token).split('.')[1], 'base64').toString('utf8'));
    line('app roles', claims.roles ? claims.roles.join(', ') : '(none - delegated only)');
  } catch (_) { /* token shape is not this script's business */ }
  console.log('\nIf tickets still open without formatting or images, the stored refresh token is');
  console.log('the remaining suspect: sign in again at /auth/microsoft/start.\n');
})();
