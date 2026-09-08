import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Plan usage is not something Claude Code writes to disk, and there is no
// read-only endpoint for it. It arrives as rate-limit headers on an ordinary
// API response -- so the cheapest possible request is sent and only the headers
// are read. The body is one token to Haiku, discarded.
//
// The mechanism (endpoint, headers, credential locations) follows Narlei
// Moreira's Claude Code Usage plugin, MIT licensed. See the README.

const IS_MAC = process.platform === 'darwin';

const CREDENTIALS_FILE = '.credentials.json';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const DEFAULT_CONFIG_DIR = path.join(os.homedir(), '.claude');
const API_URL = 'https://api.anthropic.com/v1/messages';
const TIMEOUT_MS = 15000;

const HEADERS = {
  'anthropic-version': '2023-06-01',
  'anthropic-beta': 'oauth-2025-04-20',
  'Content-Type': 'application/json',
};

const BODY = JSON.stringify({
  model: 'claude-haiku-4-5-20251001',
  max_tokens: 1,
  messages: [{ role: 'user', content: 'hi' }],
});

export const UsageError = Object.freeze({
  NO_TOKEN: 'NO_TOKEN',
  AUTH: 'AUTH',
  NETWORK: 'NETWORK',
  UNKNOWN: 'UNKNOWN',
});

export function credentialsPath(configDir) {
  return path.join(configDir || DEFAULT_CONFIG_DIR, CREDENTIALS_FILE);
}

// The token lives in a JSON file on Windows and Linux, and in the login
// keychain on macOS. Only the access token is ever read; nothing is written.
export function tokenFromJson(raw) {
  try {
    const parsed = JSON.parse(raw);
    const oauth = parsed.claudeAiOauth || parsed;
    return typeof oauth.accessToken === 'string' && oauth.accessToken ? oauth.accessToken : null;
  } catch {
    return null;
  }
}

// Returns the expiry as epoch seconds, or null when it cannot be read. Callers
// use it to say "your login expired" rather than the vaguer "auth failed".
export function expiryFromJson(raw) {
  try {
    const parsed = JSON.parse(raw);
    const oauth = parsed.claudeAiOauth || parsed;
    const at = Number(oauth.expiresAt);
    if (!at) return null;
    return at > 1e11 ? Math.floor(at / 1000) : at; // milliseconds or seconds
  } catch {
    return null;
  }
}

function readKeychain() {
  return new Promise((resolve) => {
    const child = spawn('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? out.trim() : null));
  });
}

export async function readCredentials(configDir) {
  if (IS_MAC) {
    const raw = await readKeychain();
    return raw ? { raw, where: 'keychain' } : null;
  }
  const file = credentialsPath(configDir);
  try {
    return { raw: fs.readFileSync(file, 'utf8'), where: file };
  } catch {
    return null;
  }
}

// Only the utilisation headers matter; the response body is thrown away.
function readHeaders(headers) {
  const get = (name) => headers.get(name);
  // Number(null) is 0, so an absent header would otherwise read as 0% used --
  // a dead API would look like a full quota. Absent must stay absent.
  const number = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  const pct = (value) => {
    const n = number(value);
    return n === null ? null : n / 100;
  };
  const epoch = (value) => {
    const n = number(value);
    return n !== null && n > 0 ? n : null;
  };
  return {
    util5h: pct(get('anthropic-ratelimit-unified-5h-utilization')),
    reset5h: epoch(get('anthropic-ratelimit-unified-5h-reset')),
    util7d: pct(get('anthropic-ratelimit-unified-7d-utilization')),
    reset7d: epoch(get('anthropic-ratelimit-unified-7d-reset')),
    fetchedAt: Math.floor(Date.now() / 1000),
  };
}

export async function fetchUsage({ configDir, fetchImpl = fetch } = {}) {
  const creds = await readCredentials(configDir);
  if (!creds) {
    return { ok: false, kind: UsageError.NO_TOKEN, message: 'no credentials file' };
  }
  const token = tokenFromJson(creds.raw);
  if (!token) {
    return { ok: false, kind: UsageError.NO_TOKEN, message: 'no access token in credentials' };
  }

  const expiry = expiryFromJson(creds.raw);
  const expired = expiry !== null && expiry < Math.floor(Date.now() / 1000);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let resp;
  try {
    resp = await fetchImpl(API_URL, {
      method: 'POST',
      headers: { ...HEADERS, Authorization: `Bearer ${token}` },
      body: BODY,
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = controller.signal.aborted;
    return {
      ok: false,
      kind: UsageError.NETWORK,
      message: aborted ? `timed out after ${TIMEOUT_MS}ms` : err.message || 'request failed',
    };
  } finally {
    clearTimeout(timer);
  }

  if (resp.status === 401 || resp.status === 403) {
    // The plugin deliberately does not refresh the token itself: that means
    // driving someone's login, and getting it wrong could invalidate a working
    // session. Saying which it is costs nothing and points at the fix.
    return {
      ok: false,
      kind: UsageError.AUTH,
      expired,
      message: expired ? 'login expired' : `HTTP ${resp.status}`,
    };
  }

  const data = readHeaders(resp.headers);
  if (data.util5h === null && data.util7d === null) {
    return { ok: false, kind: UsageError.UNKNOWN, message: 'no rate-limit headers on the response' };
  }
  return { ok: true, data };
}

export function formatReset(epochSec) {
  if (!epochSec) return '';
  const seconds = epochSec - Math.floor(Date.now() / 1000);
  if (seconds <= 0) return 'now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h${minutes % 60}m` : `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
