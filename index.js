/**
 * Knight Bot - A WhatsApp Bot
 * Copyright (c) 2024 Professor
 * 
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the MIT License.
 * 
 * Credits:
 * - Baileys Library by @adiwajshing
 * - Pair Code implementation inspired by TechGod143 & DGXEON
 */
require('./settings')
const { Boom } = require('@hapi/boom')
const fs = require('fs')
const chalk = require('chalk')
const FileType = require('file-type')
const path = require('path')
const axios = require('axios')
const { handleMessages, handleGroupParticipantUpdate, handleStatus } = require('./main');
const PhoneNumber = require('awesome-phonenumber')
const { imageToWebp, videoToWebp, writeExifImg, writeExifVid } = require('./lib/exif')
const { smsg, isUrl, generateMessageTag, getBuffer, getSizeMedia, fetch, await, sleep, reSize } = require('./lib/myfunc')
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    generateForwardMessageContent,
    prepareWAMessageMedia,
    generateWAMessageFromContent,
    generateMessageID,
    downloadContentFromMessage,
    jidDecode,
    proto,
    jidNormalizedUser,
    makeCacheableSignalKeyStore,
    delay
} = require("@whiskeysockets/baileys")
const NodeCache = require("node-cache")
// Using a lightweight persisted store instead of makeInMemoryStore (compat across versions)
const pino = require("pino")
const readline = require("readline")
const { parsePhoneNumber } = require("libphonenumber-js")
const { PHONENUMBER_MCC } = require('@whiskeysockets/baileys/lib/Utils/generics')
const { rmSync, existsSync } = require('fs')
const { join } = require('path')

// Import lightweight store
const store = require('./lib/lightweight_store')

// Initialize store
store.readFromFile()
const settings = require('./settings')
setInterval(() => store.writeToFile(), settings.storeWriteInterval || 10000)

// Memory optimization - Force garbage collection if available
setInterval(() => {
    if (global.gc) {
        global.gc()
        console.log('🧹 Garbage collection completed')
    }
}, 60_000) // every 1 minute

// Memory monitoring - Restart if RAM gets too high
setInterval(() => {
    const used = process.memoryUsage().rss / 1024 / 1024
    if (used > 400) {
        console.log('⚠️ RAM too high (>400MB), restarting bot...')
        process.exit(1) // Panel will auto-restart
    }
}, 30_000) // check every 30 seconds

let phoneNumber = "911234567890"
let owner = JSON.parse(fs.readFileSync('./data/owner.json'))

global.botname = "KNIGHT BOT"
global.themeemoji = "•"
const pairingCode = !!phoneNumber || process.argv.includes("--pairing-code")
const useMobile = process.argv.includes("--mobile")

// Only create readline interface if we're in an interactive environment
const rl = process.stdin.isTTY ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null
const question = (text) => {
    if (rl) {
        return new Promise((resolve) => rl.question(text, resolve))
    } else {
        // In non-interactive environment, use ownerNumber from settings
        return Promise.resolve(settings.ownerNumber || phoneNumber)
    }
}


async function startXeonBotInc() {
    let { version, isLatest } = await fetchLatestBaileysVersion()
    const { state, saveCreds } = await useMultiFileAuthState(`./session`)
    const msgRetryCounterCache = new NodeCache()

    const XeonBotInc = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: !pairingCode,
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
        },
        markOnlineOnConnect: true,
        generateHighQualityLinkPreview: true,
        syncFullHistory: true,
        getMessage: async (key) => {
            let jid = jidNormalizedUser(key.remoteJid)
            let msg = await store.loadMessage(jid, key.id)
            return msg?.message || ""
        },
        msgRetryCounterCache,
        defaultQueryTimeoutMs: undefined,
    })

    store.bind(XeonBotInc.ev)

    // Message handling
    XeonBotInc.ev.on('messages.upsert', async chatUpdate => {
        try {
            const mek = chatUpdate.messages[0]
            if (!mek.message) return
            mek.message = (Object.keys(mek.message)[0] === 'ephemeralMessage') ? mek.message.ephemeralMessage.message : mek.message
            if (mek.key && mek.key.remoteJid === 'status@broadcast') {
                await handleStatus(XeonBotInc, chatUpdate);
                return;
            }
            if (!XeonBotInc.public && !mek.key.fromMe && chatUpdate.type === 'notify') return
            if (mek.key.id.startsWith('BAE5') && mek.key.id.length === 16) return

            // Clear message retry cache to prevent memory bloat
            if (XeonBotInc?.msgRetryCounterCache) {
                XeonBotInc.msgRetryCounterCache.clear()
            }

            try {
                await handleMessages(XeonBotInc, chatUpdate, true)
            } catch (err) {
                console.error("Error in handleMessages:", err)
                // Only try to send error message if we have a valid chatId
                if (mek.key && mek.key.remoteJid) {
                    await XeonBotInc.sendMessage(mek.key.remoteJid, {
                        text: '❌ An error occurred while processing your message.',
                        contextInfo: {
                            forwardingScore: 1,
                            isForwarded: true,
                            forwardedNewsletterMessageInfo: {
                                newsletterJid: '120363161513685998@newsletter',
                                newsletterName: 'KnightBot MD',
                                serverMessageId: -1
                            }
                        }
                    }).catch(console.error);
                }
            }
        } catch (err) {
            console.error("Error in messages.upsert:", err)
        }
    })

    // Add these event handlers for better functionality
    XeonBotInc.decodeJid = (jid) => {
        if (!jid) return jid
        if (/:\d+@/gi.test(jid)) {
            let decode = jidDecode(jid) || {}
            return decode.user && decode.server && decode.user + '@' + decode.server || jid
        } else return jid
    }

    XeonBotInc.ev.on('contacts.update', update => {
        for (let contact of update) {
            let id = XeonBotInc.decodeJid(contact.id)
            if (store && store.contacts) store.contacts[id] = { id, name: contact.notify }
        }
    })

    XeonBotInc.getName = (jid, withoutContact = false) => {
        id = XeonBotInc.decodeJid(jid)
        withoutContact = XeonBotInc.withoutContact || withoutContact
        let v
        if (id.endsWith("@g.us")) return new Promise(async (resolve) => {
            v = store.contacts[id] || {}
            if (!(v.name || v.subject)) v = XeonBotInc.groupMetadata(id) || {}
            resolve(v.name || v.subject || PhoneNumber('+' + id.replace('@s.whatsapp.net', '')).getNumber('international'))
        })
        else v = id === '0@s.whatsapp.net' ? {
            id,
            name: 'WhatsApp'
        } : id === XeonBotInc.decodeJid(XeonBotInc.user.id) ?
            XeonBotInc.user :
            (store.contacts[id] || {})
        return (withoutContact ? '' : v.name) || v.subject || v.verifiedName || PhoneNumber('+' + jid.replace('@s.whatsapp.net', '')).getNumber('international')
    }

    XeonBotInc.public = true

    XeonBotInc.serializeM = (m) => smsg(XeonBotInc, m, store)

    // Handle pairing code
    if (pairingCode && !XeonBotInc.authState.creds.registered) {
        if (useMobile) throw new Error('Cannot use pairing code with mobile api')

        let phoneNumber
        if (!!global.phoneNumber) {
            phoneNumber = global.phoneNumber
        } else {
            phoneNumber = await question(chalk.bgBlack(chalk.greenBright(`Please type your WhatsApp number 😍\nFormat: 6281376552730 (without + or spaces) : `)))
        }

        // Clean the phone number - remove any non-digit characters
        phoneNumber = phoneNumber.replace(/[^0-9]/g, '')

        // Validate the phone number using awesome-phonenumber
        const pn = require('awesome-phonenumber');
        if (!pn('+' + phoneNumber).isValid()) {
            console.log(chalk.red('Invalid phone number. Please enter your full international number (e.g., 15551234567 for US, 447911123456 for UK, etc.) without + or spaces.'));
            process.exit(1);
        }

        setTimeout(async () => {
            try {
                let code = await XeonBotInc.requestPairingCode(phoneNumber)
                code = code?.match(/.{1,4}/g)?.join("-") || code
                console.log(chalk.black(chalk.bgGreen(`Your Pairing Code : `)), chalk.black(chalk.white(code)))
                console.log(chalk.yellow(`\nPlease enter this code in your WhatsApp app:\n1. Open WhatsApp\n2. Go to Settings > Linked Devices\n3. Tap "Link a Device"\n4. Enter the code shown above`))
            } catch (error) {
                console.error('Error requesting pairing code:', error)
                console.log(chalk.red('Failed to get pairing code. Please check your phone number and try again.'))
            }
        }, 3000)
    }

    // Connection handling
    XeonBotInc.ev.on('connection.update', async (s) => {
        const { connection, lastDisconnect } = s
        if (connection == "open") {
            console.log(chalk.magenta(` `))
            console.log(chalk.yellow(`🌿Connected to => ` + JSON.stringify(XeonBotInc.user, null, 2)))

            const botNumber = XeonBotInc.user.id.split(':')[0] + '@s.whatsapp.net';
            await XeonBotInc.sendMessage(botNumber, {
                text: `🤖 Bot Connected Successfully!\n\n⏰ Time: ${new Date().toLocaleString()}\n✅ Status: Online and Ready!
                \n✅Make sure to join below channel`,
                contextInfo: {
                    forwardingScore: 1,
                    isForwarded: true,
                    forwardedNewsletterMessageInfo: {
                        newsletterJid: '120363161513685998@newsletter',
                        newsletterName: 'KnightBot MD',
                        serverMessageId: -1
                    }
                }
            });

            await delay(1999)
            console.log(chalk.yellow(`\n\n                  ${chalk.bold.blue(`[ ${global.botname || 'KNIGHT BOT'} ]`)}\n\n`))
            console.log(chalk.cyan(`< ================================================== >`))
            console.log(chalk.magenta(`\n${global.themeemoji || '•'} YT CHANNEL: MR UNIQUE HACKER`))
            console.log(chalk.magenta(`${global.themeemoji || '•'} GITHUB: mrunqiuehacker`))
            console.log(chalk.magenta(`${global.themeemoji || '•'} WA NUMBER: ${owner}`))
            console.log(chalk.magenta(`${global.themeemoji || '•'} CREDIT: MR UNIQUE HACKER`))
            console.log(chalk.green(`${global.themeemoji || '•'} 🤖 Bot Connected Successfully! ✅`))
            console.log(chalk.blue(`Bot Version: ${settings.version}`))
        }
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode
            if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                try {
                    rmSync('./session', { recursive: true, force: true })
                } catch { }
                console.log(chalk.red('Session logged out. Please re-authenticate.'))
                startXeonBotInc()
            } else {
                startXeonBotInc()
            }
        }
    })

    // Track recently-notified callers to avoid spamming messages
    const antiCallNotified = new Set();

    // Anticall handler: block callers when enabled
    XeonBotInc.ev.on('call', async (calls) => {
        try {
            const { readState: readAnticallState } = require('./commands/anticall');
            const state = readAnticallState();
            if (!state.enabled) return;
            for (const call of calls) {
                const callerJid = call.from || call.peerJid || call.chatId;
                if (!callerJid) continue;
                try {
                    // First: attempt to reject the call if supported
                    try {
                        if (typeof XeonBotInc.rejectCall === 'function' && call.id) {
                            await XeonBotInc.rejectCall(call.id, callerJid);
                        } else if (typeof XeonBotInc.sendCallOfferAck === 'function' && call.id) {
                            await XeonBotInc.sendCallOfferAck(call.id, callerJid, 'reject');
                        }
                    } catch {}

                    // Notify the caller only once within a short window
                    if (!antiCallNotified.has(callerJid)) {
                        antiCallNotified.add(callerJid);
                        setTimeout(() => antiCallNotified.delete(callerJid), 60000);
                        await XeonBotInc.sendMessage(callerJid, { text: '📵 Anticall is enabled. Your call was rejected and you will be blocked.' });
                    }
                } catch {}
                // Then: block after a short delay to ensure rejection and message are processed
                setTimeout(async () => {
                    try { await XeonBotInc.updateBlockStatus(callerJid, 'block'); } catch {}
                }, 800);
            }
        } catch (e) {
            // ignore
        }
    });

    XeonBotInc.ev.on('creds.update', saveCreds)

    XeonBotInc.ev.on('group-participants.update', async (update) => {
        await handleGroupParticipantUpdate(XeonBotInc, update);
    });

    XeonBotInc.ev.on('messages.upsert', async (m) => {
        if (m.messages[0].key && m.messages[0].key.remoteJid === 'status@broadcast') {
            await handleStatus(XeonBotInc, m);
        }
    });

    XeonBotInc.ev.on('status.update', async (status) => {
        await handleStatus(XeonBotInc, status);
    });

    XeonBotInc.ev.on('messages.reaction', async (status) => {
        await handleStatus(XeonBotInc, status);
    });

    return XeonBotInc
}


// Start the bot with error handling
startXeonBotInc().catch(error => {
    console.error('Fatal error:', error)
    process.exit(1)
})
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err)
})

process.on('unhandledRejection', (err) => {
    console.error('Unhandled Rejection:', err)
})

let file = require.resolve(__filename)
fs.watchFile(file, () => {
    fs.unwatchFile(file)
    console.log(chalk.redBright(`Update ${__filename}`))
    delete require.cache[file]
    require(file)
})// --- Globals ---
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
