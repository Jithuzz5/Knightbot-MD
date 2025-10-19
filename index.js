/**
 * Knight Bot - A WhatsApp Bot
 * Copyright (c) 2024 Professor
 *
 * Licensed under the MIT License.
 *
 * Credits:
 * - Baileys Library by @adiwajshing
 * - Pair Code implementation inspired by TechGod143 & DGXEON
 */

require('./settings');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const chalk = require('chalk');
const path = require('path');
const NodeCache = require('node-cache');
const pino = require('pino');
const readline = require('readline');
const axios = require('axios');
const PhoneNumber = require('awesome-phonenumber');
const { rmSync } = require('fs');
const { join } = require('path');
const { handleMessages, handleGroupParticipantUpdate, handleStatus } = require('./main');
const { smsg, sleep } = require('./lib/myfunc');
const { imageToWebp, videoToWebp, writeExifImg, writeExifVid } = require('./lib/exif');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidDecode,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  delay
} = require("@whiskeysockets/baileys");

const store = require('./lib/lightweight_store');
store.readFromFile();

const settings = require('./settings');
setInterval(() => store.writeToFile(), settings.storeWriteInterval || 10000);

// --- Garbage Collector (if node started with --expose-gc) ---
setInterval(() => {
  if (global.gc) {
    global.gc();
    console.log('🧹 Garbage collection completed');
  }
}, 60_000);

// --- RAM Monitor ---
setInterval(() => {
  try {
    const used = process.memoryUsage().rss / 1024 / 1024;
    if (used > 400) {
      console.log('⚠️ RAM too high (>400MB), exiting for restart...');
      process.exit(1);
    }
  } catch (e) {
    console.error('RAM monitor error:', e);
  }
}, 30_000);

// --- Globals ---
let phoneNumber = "911234567890";
let owner = {};
try {
  owner = JSON.parse(fs.readFileSync('./data/owner.json', 'utf8'));
} catch (e) {
  console.warn('Could not read ./data/owner.json — continuing with default owner variable.');
}
global.botname = global.botname || "KNIGHT BOT";
global.themeemoji = global.themeemoji || "•";

const pairingCode = process.argv.includes("--pairing-code");
const useMobile = process.argv.includes("--mobile");

// Readline (only in interactive TTY)
const rl = process.stdin.isTTY ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
const question = (text) => {
  if (rl) {
    return new Promise((resolve) => rl.question(text, resolve));
  } else {
    return Promise.resolve(settings.ownerNumber || phoneNumber);
  }
};

async function startBot() {
  try {
    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState('./session');
    const msgRetryCounterCache = new NodeCache();

    const sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: !pairingCode,
      browser: ["KnightBot", "Chrome", "1.0.0"],
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }))
      },
      markOnlineOnConnect: true,
      generateHighQualityLinkPreview: true,
      syncFullHistory: true,
      msgRetryCounterCache,
      defaultQueryTimeoutMs: undefined,
      getMessage: async (key) => {
        try {
          const jid = jidNormalizedUser(key.remoteJid || '');
          const msg = await store.loadMessage(jid, key.id);
          return msg?.message || null;
        } catch (e) {
          return null;
        }
      }
    });

    // Bind store and helpers
    store.bind(sock.ev);
    sock.public = true;
    sock.decodeJid = (jid) => {
      if (!jid) return jid;
      if (/:\d+@/gi.test(jid)) {
        const decoded = jidDecode(jid) || {};
        return (decoded.user && decoded.server && decoded.user + '@' + decoded.server) || jid;
      }
      return jid;
    };

    // Convenience methods
    sock.getName = async (jid, withoutContact = false) => {
      const id = sock.decodeJid(jid);
      if (id.endsWith('@g.us')) {
        let v = store.contacts[id] || {};
        if (!(v.name || v.subject)) {
          try {
            const meta = await sock.groupMetadata(id);
            v = meta || v;
          } catch {}
        }
        return v.name || v.subject || PhoneNumber('+' + id.replace('@s.whatsapp.net', '')).getNumber('international');
      } else {
        const v = id === '0@s.whatsapp.net' ? { id, name: 'WhatsApp' } : (store.contacts[id] || {});
        return (withoutContact ? '' : v.name) || v.subject || v.verifiedName || PhoneNumber('+' + id.replace('@s.whatsapp.net', '')).getNumber('international');
      }
    };

    sock.serializeM = (m) => smsg(sock, m, store);

    // --- Pairing code flow (optional) ---
    if (pairingCode && !state.creds?.registered) {
      if (useMobile) throw new Error('Cannot use pairing code with mobile api');

      let pn;
      if (!!global.phoneNumber) {
        pn = global.phoneNumber;
      } else {
        pn = await question(chalk.bgBlack(chalk.greenBright(`Please type your WhatsApp number (international, no + or spaces): `)));
      }
      pn = pn.replace(/[^0-9]/g, '');
      const pnCheck = new PhoneNumber('+' + pn);
      if (!pnCheck.isValid()) {
        console.log(chalk.red('Invalid phone number. Please check format and try again.'));
        process.exit(1);
      }
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(pn).catch(() => null);
          const formatted = code?.match(/.{1,4}/g)?.join('-') || code;
          console.log(chalk.black(chalk.bgGreen('Your Pairing Code : ')), chalk.white(formatted || 'N/A'));
          console.log(chalk.yellow('\nEnter the code in WhatsApp -> Settings -> Linked Devices -> Link a device'));
        } catch (err) {
          console.error('Error requesting pairing code:', err);
        }
      }, 3000);
    }

    // --- Message handling ---
    sock.ev.on('messages.upsert', async (chatUpdate) => {
      try {
        const mek = chatUpdate.messages?.[0];
        if (!mek?.message) return;
        mek.message = mek.message?.ephemeralMessage?.message || mek.message;

        if (mek.key?.remoteJid === 'status@broadcast') {
          await handleStatus(sock, chatUpdate).catch(console.error);
          return;
        }

        if (!sock.public && !mek.key.fromMe && chatUpdate.type === 'notify') return;
        if (mek.key?.id && mek.key.id.startsWith('BAE5') && mek.key.id.length === 16) return;

        sock.msgRetryCounterCache?.clear();
        await handleMessages(sock, chatUpdate, true).catch(async (err) => {
          console.error('Error in handleMessages:', err);
          if (mek.key?.remoteJid) {
            try {
              await sock.sendMessage(mek.key.remoteJid, { text: '❌ An error occurred while processing your message.' });
            } catch (e) { /* ignore send errors */ }
          }
        });
      } catch (err) {
        console.error('Error in messages.upsert handler:', err);
      }
    });

    // --- Connection updates ---
    sock.ev.on('connection.update', async (update) => {
      try {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') {
          console.log(chalk.greenBright(`✅ Connected as ${sock.user?.name || sock.user?.id}`));
          const botNumber = sock.user.id.split(':')[0] + '@s.whatsapp.net';
          await sock.sendMessage(botNumber, {
            text: `🤖 ${global.botname || 'Knight Bot'} Connected!\n\nTime: ${new Date().toLocaleString()}\nStatus: Online ✅`
          }).catch(() => {});
          console.log(chalk.cyan(`🌿 Knight Bot is running...\nYT: MR UNIQUE HACKER\nGITHUB: mrunqiuehacker`));
        } else if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          console.log(chalk.yellow('Connection closed, status code:'), statusCode);
          if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
            try { rmSync('./session', { recursive: true, force: true }); } catch (e) {}
            console.log(chalk.red('Session logged out. Clearing session and restarting...'));
            // small delay to avoid rapid restart loops
            setTimeout(() => startBot().catch(console.error), 3000);
          } else {
            // Reconnect with a small backoff
            setTimeout(() => startBot().catch(console.error), 1500);
          }
        }
      } catch (e) {
        console.error('Error in connection.update handler:', e);
      }
    });

    // --- Group participants ---
    sock.ev.on('group-participants.update', async (update) => {
      try {
        await handleGroupParticipantUpdate(sock, update);
      } catch (e) { console.error('group-participants.update error:', e); }
    });

    // --- Status & reactions ---
    sock.ev.on('status.update', async (status) => {
      try {
        await handleStatus(sock, status);
      } catch (e) { /* ignore */ }
    });
    sock.ev.on('messages.reaction', async (reaction) => {
      try {
        await handleStatus(sock, reaction);
      } catch (e) { /* ignore */ }
    });

    // --- Incoming calls handling (anticall) ---
    const antiCallNotified = new Set();
    sock.ev.on('call', async (calls) => {
      try {
        const { readState: readAnticallState } = require('./commands/anticall');
        const state = readAnticallState();
        if (!state.enabled) return;
        for (const call of calls) {
          const callerJid = call.from || call.peerJid || call.chatId;
          if (!callerJid) continue;
          try {
            if (typeof sock.rejectCall === 'function' && call.id) {
              await sock.rejectCall(call.id, callerJid).catch(() => {});
            } else if (typeof sock.sendCallOfferAck === 'function' && call.id) {
              await sock.sendCallOfferAck(call.id, callerJid, 'reject').catch(() => {});
            }
          } catch {}
          if (!antiCallNotified.has(callerJid)) {
            antiCallNotified.add(callerJid);
            setTimeout(() => antiCallNotified.delete(callerJid), 60_000);
            try {
              await sock.sendMessage(callerJid, { text: '📵 Anticall is enabled. Your call was rejected and you will be blocked.' }).catch(() => {});
            } catch {}
          }
          setTimeout(async () => {
            try { await sock.updateBlockStatus(callerJid, 'block'); } catch {}
          }, 800);
        }
      } catch (e) { /* ignore overall call handler errors */ }
    });

    // --- Save credentials when updated ---
    sock.ev.on('creds.update', saveCreds);

    // Final return (socket ready)
    return sock;
  } catch (err) {
    console.error('Fatal error starting bot:', err);
    throw err;
  }
}

// --- Start the bot with error handling ---
startBot().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

// --- Global Error Logging ---
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
});

// --- Hot Reload (watch this file) ---
const file = require.resolve(__filename);
fs.watchFile(file, () => {
  try {
    fs.unwatchFile(file);
    console.log(chalk.redBright(`File updated: ${__filename}`));
    delete require.cache[file];
    require(file);
  } catch (e) {
    console.error('Hot reload error:', e);
  }
});
