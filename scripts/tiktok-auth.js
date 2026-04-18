#!/usr/bin/env node
'use strict';

/**
 * One-time TikTok OAuth authorization for the TikTok bridge destination.
 * Run: npm run tiktok:auth
 *
 * Starts a local HTTP server on port 8888 to receive the OAuth callback,
 * exchanges the code for tokens, and saves them to .tiktok_tokens.json.
 *
 * Before running:
 *   1. Set TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET in .env
 *   2. Add http://localhost:8888/tiktok/callback as a redirect URI
 *      in your TikTok developer app settings
 */

require('dotenv').config();

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { URL } = require('node:url');
const crypto = require('node:crypto');

const TOKENS_FILE = path.resolve(process.cwd(), '.tiktok_tokens.json');
const REDIRECT_URI = 'http://localhost:8888/tiktok/callback';
const TIKTOK_API_BASE = 'https://open.tiktokapis.com/v2';
const SCOPES = 'user.info.basic,video.upload,video.publish';

const clientKey = process.env.TIKTOK_CLIENT_KEY;
const clientSecret = process.env.TIKTOK_CLIENT_SECRET;

if (!clientKey || !clientSecret) {
  console.error('Error: TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET must be set in .env');
  console.error('  Get them at https://developers.tiktok.com/');
  process.exit(1);
}

const state = crypto.randomBytes(16).toString('hex');

const authUrl = `https://www.tiktok.com/v2/auth/authorize/?`
  + `client_key=${encodeURIComponent(clientKey)}`
  + `&scope=${encodeURIComponent(SCOPES)}`
  + `&response_type=code`
  + `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`
  + `&state=${state}`;

const exchangeCode = async (code) => {
  const resp = await fetch(`${TIKTOK_API_BASE}/oauth/token/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_key: clientKey,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI,
    }),
  });

  const data = await resp.json();

  if (!resp.ok || (data.error?.code && data.error.code !== 'ok')) {
    throw new Error(`Token exchange failed: ${data.error?.message || resp.status}`);
  }

  return {
    access_token: data.data.access_token,
    refresh_token: data.data.refresh_token,
    expires_in: data.data.expires_in,
    refresh_expires_in: data.data.refresh_expires_in,
    scope: data.data.scope,
    saved_at: Date.now(),
  };
};

const waitForCallback = () => new Promise((resolve, reject) => {
  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost:8888');
    } catch {
      res.writeHead(400); res.end(); return;
    }

    if (url.pathname !== '/tiktok/callback') {
      res.writeHead(404); res.end(); return;
    }

    const code = url.searchParams.get('code');
    const returnedState = url.searchParams.get('state');
    const error = url.searchParams.get('error');

    if (error) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<html><body><h2>Authorization failed</h2><p>${error}</p><p>You can close this tab.</p></body></html>`);
      server.close();
      reject(new Error(`TikTok auth error: ${error}`));
      return;
    }

    if (!code) {
      res.writeHead(400); res.end('Missing code'); return;
    }

    if (returnedState !== state) {
      res.writeHead(400); res.end('State mismatch');
      server.close();
      reject(new Error('State parameter mismatch — possible CSRF'));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><body><h2>Authorization successful!</h2><p>You can close this tab and return to the terminal.</p></body></html>');
    server.close();
    resolve(code);
  });

  server.listen(8888, 'localhost', () => {
    console.log('\nWaiting for TikTok authorization on http://localhost:8888 ...\n');
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      reject(new Error('Port 8888 is already in use. Stop the process using it and retry.'));
    } else {
      reject(err);
    }
  });

  setTimeout(() => {
    server.close();
    reject(new Error('Authorization timeout (5 minutes)'));
  }, 5 * 60 * 1000);
});

const main = async () => {
  if (fs.existsSync(TOKENS_FILE)) {
    const existing = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
    const savedAt = existing.saved_at || 0;
    const refreshExpiresIn = existing.refresh_expires_in || 5184000;
    const expiresAt = new Date(savedAt + refreshExpiresIn * 1000);
    console.log(`Existing tokens found (refresh token expires ~${expiresAt.toLocaleDateString()}).`);
    process.stdout.write('Re-authorize and overwrite? [y/N] ');
    const answer = await new Promise((res) => {
      process.stdin.once('data', (d) => res(d.toString().trim().toLowerCase()));
    });
    if (answer !== 'y') { console.log('Aborted.'); process.exit(0); }
  }

  console.log('\n─── TikTok Authorization ───────────────────────────────────────────────────');
  console.log('Prerequisites:');
  console.log('  • TikTok developer app created at https://developers.tiktok.com/');
  console.log(`  • Redirect URI added in app settings: ${REDIRECT_URI}`);
  console.log('────────────────────────────────────────────────────────────────────────────\n');
  console.log('Open this URL in your browser:\n');
  console.log(authUrl);

  const code = await waitForCallback();

  console.log('\nExchanging authorization code for tokens...');
  const tokens = await exchangeCode(code);

  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  console.log(`\nTokens saved → ${TOKENS_FILE}`);
  console.log(`Scopes: ${tokens.scope}`);
  console.log(`Refresh token expires in: ${Math.round(tokens.refresh_expires_in / 86400)} days`);
  console.log('\nDone. Restart the bridge to apply: npm start');

  process.exit(0);
};

main().catch((err) => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
