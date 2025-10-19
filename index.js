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

const fs = require('fs');
const chalk = require('chalk');
const path = require('path');
const NodeCache = require('node-cache');
const pino = require('pino');
const readline = require('readline');
const axios = require('axios');
const PhoneNumber = require('awesome-phonenumber');

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

// --- Memory Monitor ---
setInterval(() => {
  try {
    const used = process.memoryUsage().rss / 1024 / 1024;
    if (used > 400) {
      console.log('⚠️ RAM too high (>400MB), restarting bot...');
      process.exit(1);
    }
  } catch (e) {
    console.error('Memory monitor error', e);
  }
}, 30000);

// --- Globals ---
let phoneNumber = "911234567890";
let owner = {};
try {
  owner = JSON.parse(fs.readFileSync('./data/owner.json', 'utf8'));
} catch (e) {
  console.warn('Could not read ./data/owner.json — proceeding with defaults.');
}
global.botname = "KNIGHT BOT";
global.themeemoji = "•";

const pairingCode = process.argv.includes("--pairing-code");
const useMobile = process.argv.includes("--mobile");

// --- Readline Interface ---
const rl = process.stdin.isTTY ? readline.createInterface({
  input: process.stdin,
  output: process.stdout
}) : null;

const question = (text) => rl ? new Promise((resolve) => rl.question(text, resolve)) :
  Promise.resolve(settings.ownerNumber || phoneNumber);

// --- Main Start Function ---
async function startKnightBot() {
  try {
    // fetchLatestBaileysVersion can throw — guard it
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
          console.error('getMessage error', e);
          return null;
        }
      }
    });

    store.bind(sock.ev);
    sock.public = true;

    // --- Pairing Code Setup ---
    if (pairingCode && !sock.authState?.creds?.registered) {
      if (useMobile) throw new Error('Cannot use pairing code with mobile API');

      let userNumber = await question(
        chalk.greenBright(`Enter your WhatsApp number (e.g., 919876543210): `)
      );

      userNumber = (userNumber || '').replace(/[^0-9]/g, '');
      if (!new PhoneNumber('+' + userNumber).isValid()) {
        console.log(chalk.red('❌ Invalid number. Please enter full international format.'));
        process.exit(1);
      }

      setTimeout(async () => {
        try {
          // requestPairingCode exists in some wrappers; guard with try/catch
          if (typeof sock.requestPairingCode === 'function') {
            let code = await sock.requestPairingCode(userNumber);
            code = code?.match(/.{1,4}/g)?.join("-") || code;
            console.log(chalk.bgGreen.black(`Your Pairing Code: ${code}`));
            console.log(chalk.yellow(`\n1️⃣ Open WhatsApp\n2️⃣ Settings → Linked Devices\n3️⃣ Tap “Link a Device”\n4️⃣ Enter the code above`));
          } else {
            console.warn('Pairing code function not available on this socket instance.');
          }
        } catch (err) {
          console.error('Error requesting pairing code:', err);
        }
      }, 3000);
    }

    // --- Message Handler ---
    sock.ev.on('messages.upsert', async (chatUpdate) => {
      try {
        const mek = chatUpdate.messages?.[0];
        if (!mek?.message) return;
        mek.message = mek.message?.ephemeralMessage?.message || mek.message;

        if (mek.key?.remoteJid === 'status@broadcast') {
          return await handleStatus(sock, chatUpdate);
        }

        if (!sock.public && !mek.key.fromMe && chatUpdate.type === 'notify') return;
        if (mek.key.id?.startsWith('BAE5') && mek.key.id.length === 16) return;

        sock.msgRetryCounterCache?.clear();
        await handleMessages(sock, chatUpdate, true);

      } catch (err) {
        console.error("Error in message handler:", err);
      }
    });

    // --- Group Updates ---
    sock.ev.on('group-participants.update', async (update) => {
      try {
        await handleGroupParticipantUpdate(sock, update);
      } catch (e) {
        console.error('group-participants.update handler error', e);
      }
    });

    // --- Status Updates ---
    sock.ev.on('status.update', async (status) => {
      try {
        await handleStatus(sock, status);
      } catch (e) {
        console.error('status.update handler error', e);
      }
    });

    sock.ev.on('messages.reaction', async (reaction) => {
      try {
        await handleStatus(sock, reaction);
      } catch (e) {
        console.error('messages.reaction handler error', e);
      }
    });

    // --- Connection Events ---
    sock.ev.on('connection.update', async (update) => {
      try {
        const { connection, lastDisconnect } = update;
        if (connection === "open") {
          console.log(chalk.greenBright(`✅ Connected as ${sock.user?.name || sock.user?.id || 'unknown'}`));
          try {
            const botNumber = (sock.user?.id || '').split(':')[0] + '@s.whatsapp.net';
            if (botNumber) {
              await sock.sendMessage(botNumber, {
                text: `🤖 Knight Bot Connected!\nTime: ${new Date().toLocaleString()}\nStatus: Online ✅`
              });
            }
          } catch (e) {
            console.warn('Failed to send connected message to bot JID', e);
          }
          console.log(chalk.cyan(`🌿 Knight Bot is running...\nYT: MR UNIQUE HACKER\nGITHUB: mrunqiuehacker`));
        } else if (connection === "close") {
          const reason = lastDisconnect?.error?.output?.statusCode;
          console.log(chalk.yellow('Connection closed — reason code:'), reason);
          if (reason === DisconnectReason.loggedOut || reason === 401) {
            try {
              fs.rmSync('./session', { recursive: true, force: true });
              console.log(chalk.red('Session logged out — session removed.'));
            } catch (e) {
              console.warn('Failed to remove session folder', e);
            }
          }
          // restart with a short delay to avoid tight recursion
          setTimeout(() => {
            startKnightBot().catch(err => console.error('Restart error:', err));
          }, 5000);
        }
      } catch (e) {
        console.error('connection.update handler error', e);
      }
    });

    // --- Save Credentials ---
    sock.ev.on('creds.update', saveCreds);

    return sock;
  } catch (err) {
    console.error("Fatal error while starting Knight Bot:", err);
    // try to restart but avoid infinite fast loop
    setTimeout(() => {
      startKnightBot().catch(e => console.error('Restart after fatal error failed:', e));
    }, 5000);
  }
}

// --- Start Bot ---
startKnightBot().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

// --- Global Error Handling ---
process.on('uncaughtException', (err) => {
  console.error('uncaughtException', err);
});
process.on('unhandledRejection', (err) => {
  console.error('unhandledRejection', err);
});

// --- Hot Reload ---
const file = require.resolve(__filename);
fs.watchFile(file, () => {
  fs.unwatchFile(file);
  console.log(chalk.redBright(`File updated: ${__filename}`));
  delete require.cache[file];
  try {
    require(file);
  } catch (e) {
    console.error('Error reloading file:', e);
  }
});  input: process.stdin,
  output: process.stdout
}) : null;

const question = (text) => rl ? new Promise((resolve) => rl.question(text, resolve)) :
  Promise.resolve(settings.ownerNumber || phoneNumber);

// --- Main Start Function ---
async function startKnightBot() {
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
      let jid = jidNormalizedUser(key.remoteJid);
      let msg = await store.loadMessage(jid, key.id);
      return msg?.message || "";
    }
  });

  store.bind(sock.ev);
  sock.public = true;

  // --- Pairing Code Setup ---
  if (pairingCode && !sock.authState.creds.registered) {
    if (useMobile) throw new Error('Cannot use pairing code with mobile API');

    let userNumber = await question(
      chalk.greenBright(`Enter your WhatsApp number (e.g., 919876543210): `)
    );

    userNumber = userNumber.replace(/[^0-9]/g, '');
    const pn = require('awesome-phonenumber');
    if (!pn('+' + userNumber).isValid()) {
      console.log(chalk.red('❌ Invalid number. Please enter full international format.'));
      process.exit(1);
    }

    setTimeout(async () => {
      try {
        let code = await sock.requestPairingCode(userNumber);
        code = code?.match(/.{1,4}/g)?.join("-") || code;
        console.log(chalk.bgGreen.black(`Your Pairing Code: ${code}`));
        console.log(chalk.yellow(`\n1️⃣ Open WhatsApp
2️⃣ Settings → Linked Devices
3️⃣ Tap “Link a Device”
4️⃣ Enter the code above`));
      } catch (err) {
        console.error('Error requesting pairing code:', err);
      }
    }, 3000);
  }

  // --- Message Handler ---
  sock.ev.on('messages.upsert', async (chatUpdate) => {
    try {
      const mek = chatUpdate.messages?.[0];
      if (!mek?.message) return;
      mek.message = mek.message?.ephemeralMessage?.message || mek.message;

      if (mek.key?.remoteJid === 'status@broadcast') {
        return await handleStatus(sock, chatUpdate);
      }

      if (!sock.public && !mek.key.fromMe && chatUpdate.type === 'notify') return;
      if (mek.key.id.startsWith('BAE5') && mek.key.id.length === 16) return;

      sock.msgRetryCounterCache?.clear();
      await handleMessages(sock, chatUpdate, true);

    } catch (err) {
      console.error("Error in message handler:", err);
    }
  });

  // --- Group Updates ---
  sock.ev.on('group-participants.update', async (update) => {
    await handleGroupParticipantUpdate(sock, update);
  });

  // --- Status Updates ---
  sock.ev.on('status.update', async (status) => {
    await handleStatus(sock, status);
  });

  sock.ev.on('messages.reaction', async (reaction) => {
    await handleStatus(sock, reaction);
  });

  // --- Connection Events ---
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === "open") {
      console.log(chalk.greenBright(`✅ Connected as ${sock.user?.name || sock.user?.id}`));
      const botNumber = sock.user.id.split(':')[0] + '@s.whatsapp.net';
      await sock.sendMessage(botNumber, {
        text: `🤖 Knight Bot Connected!\nTime: ${new Date().toLocaleString()}\nStatus: Online ✅`
      });
      console.log(chalk.cyan(`🌿 Knight Bot is running...\nYT: MR UNIQUE HACKER\nGITHUB: mrunqiuehacker`));
    } else if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      if (reason === DisconnectReason.loggedOut || reason === 401) {
        rmSync('./session', { recursive: true, force: true });
        console.log(chalk.red('Session logged out. Restarting...'));
      }
      startKnightBot();
    }
  });

  // --- Save Credentials ---
  sock.ev.on('creds.update', saveCreds);

  return sock;
}

// --- Start Bot ---
startKnightBot().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

// --- Global Error Handling ---
process.on('uncaughtException', console.error);
process.on('unhandledRejection', console.error);

// --- Hot Reload ---
const file = require.resolve(__filename);
fs.watchFile(file, () => {
  fs.unwatchFile(file);
  console.log(chalk.redBright(`File updated: ${__filename}`));
  delete require.cache[file];
  require(file);
});
