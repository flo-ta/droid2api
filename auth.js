import fs from 'fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'url';
import { logInfo, logDebug } from './logger.js';

// Static Factory API key auth: FACTORY_API_KEY never expires, so there is no
// refresh flow and no droid credential file reading. The key comes from
// environment variables, or from a .env file in the project root (gitignored).
let apiKey = null;
let orgId = null;
let requestTokenDigest = null;

/**
 * Load KEY=VALUE pairs from the .env file in the project root. Real
 * environment variables take precedence and are never overwritten.
 */
function loadEnvFile() {
  const envPath = fileURLToPath(new URL('.env', import.meta.url));
  if (!fs.existsSync(envPath)) {
    return;
  }
  for (const rawLine of fs.readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || process.env[match[1]] !== undefined) {
      continue;
    }
    process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  logDebug(`Loaded ${envPath}`);
}

/**
 * Initialize auth system - validate the required FACTORY_API_KEY environment
 * variable, independent request_auth_token, and optional FACTORY_ORG_ID.
 */
export function initializeAuth() {
  requestTokenDigest = null;
  loadEnvFile();
  const key = process.env.FACTORY_API_KEY;
  if (!key || key.trim() === '') {
    throw new Error('FACTORY_API_KEY environment variable is required.');
  }
  const requestToken = process.env.request_auth_token?.trim();
  if (!requestToken) {
    throw new Error('request_auth_token environment variable is required.');
  }
  if (!/^[\x21-\x7e]+$/.test(requestToken) || requestToken.includes(',')) {
    throw new Error('request_auth_token must contain printable ASCII without spaces or commas.');
  }
  apiKey = key.trim();
  orgId = process.env.FACTORY_ORG_ID?.trim() || null;
  requestTokenDigest = hashToken(requestToken);

  logInfo('Auth system initialized with fixed FACTORY_API_KEY');
  logInfo('Client authentication enabled with request_auth_token');
  if (orgId) {
    logInfo(`Factory organization ID: ${orgId}`);
  }
}

function hashToken(token) {
  return createHash('sha256').update(token).digest();
}

/**
 * Authenticate clients before parsing their request bodies or contacting Factory.
 * If both supported headers are supplied, both must match. Reject duplicate
 * credential headers rather than relying on Node's header merging behavior.
 */
export function requireRequestAuth(req, res, next) {
  if (!requestTokenDigest) {
    return res.status(503).json({ error: {
      message: 'Client authentication is not configured',
      type: 'server_error',
      code: 'authentication_not_configured'
    } });
  }

  const counts = { authorization: 0, 'x-api-key': 0 };
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i].toLowerCase();
    if (Object.hasOwn(counts, name)) counts[name]++;
  }

  const authorization = req.headers.authorization;
  const apiKeyHeader = req.headers['x-api-key'];
  const tokens = [];
  if (authorization !== undefined) {
    tokens.push(typeof authorization === 'string'
      ? authorization.match(/^Bearer[ \t]+([^\s,]+)$/i)?.[1]
      : undefined);
  }
  if (apiKeyHeader !== undefined) tokens.push(apiKeyHeader);

  const matches = tokens.map(token => typeof token === 'string'
    && timingSafeEqual(hashToken(token), requestTokenDigest));
  if (counts.authorization > 1 || counts['x-api-key'] > 1
      || matches.length === 0 || !matches.every(Boolean)) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="droid2api"');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(401).json({ error: {
      message: 'Unauthorized',
      type: 'authentication_error',
      code: 'invalid_api_key'
    } });
  }

  next();
}

/**
 * Upstream Authorization header value.
 */
export function getApiKey() {
  return `Bearer ${apiKey}`;
}

/**
 * Active Factory organization id, used for the x-factory-org-id upstream header.
 */
export function getOrgId() {
  return orgId;
}
