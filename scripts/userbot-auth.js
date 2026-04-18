#!/usr/bin/env node
'use strict';

/**
 * One-time userbot authorization for Telegram Stories destination.
 * Run: npm run userbot:auth
 *
 * Reads TELEGRAM_API_ID, TELEGRAM_API_HASH, and optionally USERBOT_PHONE,
 * USERBOT_PASSWORD from .env. Saves the session string to .userbot_session.
 */

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const readline = require('readline/promises');

let TelegramClient, StringSession;
try {
  ({ TelegramClient } = require('telegram'));
  ({ StringSession } = require('telegram/sessions'));
} catch {
  console.error('Error: gramjs not installed. Run: npm install telegram');
  process.exit(1);
}

const SESSION_FILE = path.resolve(
  process.cwd(),
  process.env.USERBOT_SESSION_FILE || '.userbot_session',
);

const main = async () => {
  const apiId = Number.parseInt(process.env.TELEGRAM_API_ID || '0', 10);
  const apiHash = process.env.TELEGRAM_API_HASH || '';

  if (!apiId || !apiHash) {
    console.error('Error: TELEGRAM_API_ID and TELEGRAM_API_HASH must be set in .env');
    console.error('  Get them at https://my.telegram.org/apps');
    process.exit(1);
  }

  if (fs.existsSync(SESSION_FILE)) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`Session file already exists at ${SESSION_FILE}. Overwrite? [y/N] `);
    rl.close();
    if (answer.trim().toLowerCase() !== 'y') {
      console.log('Aborted.');
      process.exit(0);
    }
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const phone = process.env.USERBOT_PHONE
    || await rl.question('Phone number (+country code): ');

  console.log(`\nConnecting as ${phone}...`);

  const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
    connectionRetries: 3,
  });

  await client.start({
    phoneNumber: async () => phone,
    phoneCode: async () => {
      return rl.question('Verification code from Telegram: ');
    },
    password: async () => {
      const pw = process.env.USERBOT_PASSWORD;
      if (pw) {
        console.log('2FA: using USERBOT_PASSWORD from env');
        return pw;
      }
      return rl.question('2FA password (press Enter if none): ');
    },
    onError: (err) => console.error('Auth error:', err.message),
  });

  rl.close();

  const sessionString = client.session.save();
  fs.writeFileSync(SESSION_FILE, sessionString, { mode: 0o600 });

  const me = await client.getMe();
  const displayName = [me.firstName, me.lastName].filter(Boolean).join(' ');
  const displayHandle = me.username ? `@${me.username}` : String(me.phone);

  console.log(`\nAuthorized as: ${displayName} (${displayHandle})`);
  console.log(`Session saved  → ${SESSION_FILE}`);
  console.log('\nNext steps:');
  console.log('  1. Add the account as admin to your Telegram channel');
  console.log('  2. Add a telegram_stories destination in config/routes.json');
  console.log('  3. Restart the bridge (npm start)');

  await client.disconnect();
  process.exit(0);
};

main().catch((err) => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
