'use strict';

/**
 * Persistent session storage for the Bridge CLI.
 *
 * Located at $XDG_CONFIG_HOME/max-bot-bridge/session.json
 * (falls back to ~/.config/max-bot-bridge/session.json).
 *
 * The file stores one active session at a time:
 *   { host, port, token, expires_at }
 *
 * Security notes:
 *   - The token is a random 256-bit secret issued by the server.
 *   - The password is NEVER written to disk.
 *   - File mode is 0600 so only the current user can read it.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_DIR_NAME = 'max-bot-bridge';
const SESSION_FILE = 'session.json';

const configDir = () => {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.trim()) return path.join(xdg, APP_DIR_NAME);
  return path.join(os.homedir(), '.config', APP_DIR_NAME);
};

const sessionPath = () => path.join(configDir(), SESSION_FILE);

const loadSession = () => {
  const file = sessionPath();
  if (!fs.existsSync(file)) return null;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.host || !parsed.token) return null;
    return parsed;
  } catch {
    return null;
  }
};

const saveSession = (session) => {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = sessionPath();
  const payload = JSON.stringify(session, null, 2);
  fs.writeFileSync(file, `${payload}\n`, { mode: 0o600 });
};

const clearSession = () => {
  const file = sessionPath();
  if (fs.existsSync(file)) fs.unlinkSync(file);
};

const requireSession = () => {
  const session = loadSession();
  if (!session) {
    const err = new Error('Not logged in. Run `max-bot-bridge login <host>` first.');
    err.exitCode = 2;
    throw err;
  }
  if (session.expires_at && session.expires_at < Date.now()) {
    const err = new Error('Session expired. Run `max-bot-bridge login <host>` again.');
    err.exitCode = 2;
    throw err;
  }
  return session;
};

module.exports = {
  loadSession,
  saveSession,
  clearSession,
  requireSession,
  sessionPath,
};
