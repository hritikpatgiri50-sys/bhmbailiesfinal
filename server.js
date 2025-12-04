require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, makeInMemoryStore } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 21466;
const SECRET_TOKEN = process.env.SECRET_TOKEN || 'THISISMYSECURETOKEN';
const SESSIONS_DIR = path.join(__dirname, 'sessions');

// Create sessions directory if it doesn't exist
if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// Middleware
app.use(express.json());

// CORS configuration - Allow requests from your Hostinger domain
app.use(cors({
    origin: [
        'https://whatsapp.bhavanamsc2c.com',           // Replace with your Hostinger domain
        'http://whatsapp.bhavanamsc2c.com',            // HTTP version (if needed)
        'https://www.whatsapp.bhavanamsc2c.com',       // WWW version
        'http://www.whatsapp.bhavanamsc2c.com'         // WWW HTTP version
    ],
    credentials: true,
    methods: ['GET', 'POST', 'DELETE', 'PUT', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Health check (public endpoint, no auth required)
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Session diagnostics (public endpoint for debugging) - BEFORE auth middleware
app.get('/api/:session/diagnostics', (req, res) => {
    const sessionName = req.params.session;
    const sessionDir = getSessionDir(sessionName);

    const diagnostics = {
        sessionName,
        sessionDir,
        exists: fs.existsSync(sessionDir),
        hasSocket: sockets.has(sessionName),
        hasQRCode: qrCodes.has(sessionName),
        isConnected: false,
        files: [],
        qrCodePreview: null
    };

    if (diagnostics.exists) {
        diagnostics.files = fs.readdirSync(sessionDir);
    }

    const sock = sockets.get(sessionName);
    if (sock && sock.user) {
        diagnostics.isConnected = true;
        diagnostics.phoneNumber = sock.user.id;
    }

    // Show first 100 chars of QR if available
    const qrCode = qrCodes.get(sessionName);
    if (qrCode) {
        diagnostics.qrCodePreview = qrCode.substring(0, 100) + '...';
        diagnostics.qrCodeLength = qrCode.length;
    }

    res.json(diagnostics);
});

// Authentication middleware
const authenticate = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized: Missing or invalid token' });
    }

    const token = authHeader.substring(7);
    if (token !== SECRET_TOKEN) {
        return res.status(401).json({ error: 'Unauthorized: Invalid token' });
    }

    next();
};

app.use(authenticate);

// Store active sockets
const sockets = new Map();
const qrCodes = new Map();
// Store chats for each session (captured from events)
const sessionChats = new Map();
// Store messages for each session (from messages.upsert events)
const sessionMessages = new Map();
// Store Baileys in-memory stores for each session
const sessionStores = new Map();

// Logger
const logger = pino({
    level: 'info',
    transport: {
        target: 'pino-pretty',
        options: {
            colorize: true
        }
    }
});

// Fallback for makeInMemoryStore – some Baileys versions may not export it directly.
let createInMemoryStore;
if (typeof makeInMemoryStore === 'function') {
    createInMemoryStore = makeInMemoryStore;
} else {
    logger.warn('makeInMemoryStore not found, using custom fallback store implementation.');
    // Minimal custom store matching required API (contacts, bind, read/write)
    createInMemoryStore = function ({ logger }) {
        const chats = new Map();
        const messages = new Map();
        const contacts = new Map();
        const groupMetadata = new Map();
        return {
            chats,
            messages,
            contacts,
            groupMetadata,
            bind(ev) {
                ev.on('contacts.upsert', (contactsList) => {
                    for (const contact of contactsList) {
                        contacts.set(contact.id, Object.assign(contacts.get(contact.id) || {}, contact));
                    }
                });
                ev.on('contacts.update', (updates) => {
                    for (const update of updates) {
                        if (contacts.has(update.id)) {
                            Object.assign(contacts.get(update.id), update);
                        }
                    }
                });
                ev.on('messages.upsert', ({ messages: newMessages, type }) => {
                    if (type === 'append' || type === 'notify') {
                        for (const msg of newMessages) {
                            const jid = msg.key.remoteJid;
                            if (!messages.has(jid)) messages.set(jid, new Map());
                            messages.get(jid).set(msg.key.id, msg);
                        }
                    }
                });
            },
            readFromFile(path) {
                if (fs.existsSync(path)) {
                    try {
                        const data = JSON.parse(fs.readFileSync(path, { encoding: 'utf-8' }));
                        if (data.contacts) {
                            for (const [id, contact] of Object.entries(data.contacts)) {
                                contacts.set(id, contact);
                            }
                        }
                    } catch (error) {
                        logger.error('Failed to read store from file: ' + error.message);
                    }
                }
            },
            writeToFile(path) {
                try {
                    const data = { contacts: Object.fromEntries(contacts) };
                    fs.writeFileSync(path, JSON.stringify(data));
                } catch (error) {
                    logger.error('Failed to write store to file: ' + error.message);
                }
            }
        };
    };
}


// Helper function to get session directory
function getSessionDir(sessionName) {
    return path.join(SESSIONS_DIR, sessionName);
}

// Helper function to get messages for a chat (unread + last N messages)
function getMessagesForChat(sessionName, jid, minCount = 10) {
    const chatMap = sessionChats.get(sessionName);
    const messageMap = sessionMessages.get(sessionName);

    if (!messageMap) {
        logger.debug(`getMessagesForChat: No messageMap for session ${sessionName}`);
        return [];
    }

    // Try exact JID match first
    let allMessages = messageMap.get(jid);

    // If not found, try to find by matching JID (handle different formats)
    if (!allMessages || allMessages.length === 0) {
        logger.debug(`getMessagesForChat: No messages found for exact JID ${jid}, checking all stored JIDs...`);
        // List all stored JIDs for debugging
        const storedJids = Array.from(messageMap.keys());
        logger.debug(`getMessagesForChat: Available JIDs in store: ${storedJids.slice(0, 5).join(', ')}${storedJids.length > 5 ? '...' : ''}`);

        // Try to find a match (case-insensitive, handle URL encoding)
        for (const storedJid of storedJids) {
            if (storedJid === jid || storedJid === decodeURIComponent(jid) || decodeURIComponent(storedJid) === jid) {
                allMessages = messageMap.get(storedJid);
                logger.debug(`getMessagesForChat: Found match! Using ${storedJid} for requested ${jid}`);
                break;
            }
        }
    }

    if (!allMessages || allMessages.length === 0) {
        logger.debug(`getMessagesForChat: No messages found for ${jid} after all checks`);
        return [];
    }

    logger.debug(`getMessagesForChat: Found ${allMessages.length} messages for ${jid}`);

    const chat = chatMap ? chatMap.get(jid) : null;

    // unread count may be in different props depending on version
    const unreadCount = chat?.unreadCount || chat?.count || chat?.unread || 0;

    const need = Math.max(minCount, unreadCount);
    const start = Math.max(0, allMessages.length - need);

    // Sort by timestamp (oldest first for display)
    const sorted = allMessages.sort((a, b) => {
        // Helper to extract timestamp
        const getTs = (msg) => {
            if (!msg) return 0;
            // Check top-level messageTimestamp (standard Baileys)
            if (msg.messageTimestamp) {
                return typeof msg.messageTimestamp === 'string' || typeof msg.messageTimestamp === 'object'
                    ? Number(msg.messageTimestamp)
                    : msg.messageTimestamp;
            }
            // Check timestamp (custom or legacy)
            if (msg.timestamp) {
                return typeof msg.timestamp === 'string' || typeof msg.timestamp === 'object'
                    ? Number(msg.timestamp)
                    : msg.timestamp;
            }
            // Check nested in message (rare but possible)
            if (msg.message && msg.message.messageTimestamp) {
                return Number(msg.message.messageTimestamp);
            }
            return 0;
        };

        const tsA = getTs(a);
        const tsB = getTs(b);
        return tsA - tsB;
    });

    const result = sorted.slice(start);
    logger.debug(`getMessagesForChat: Returning ${result.length} messages (need: ${need}, start: ${start}, total: ${allMessages.length})`);

    return result;
}

// Helper function to start WhatsApp socket
async function startSocket(sessionName, forceNew = false) {
    const sessionDir = getSessionDir(sessionName);

    // If forcing new, delete existing session directory
    if (forceNew && fs.existsSync(sessionDir)) {
        logger.info(`Deleting existing session directory for fresh start: ${sessionName}`);
        try {
            // Close existing socket if any
            const existingSock = sockets.get(sessionName);
            if (existingSock) {
                try {
                    await existingSock.end();
                } catch (e) {
                    // Ignore errors
                }
                sockets.delete(sessionName);
            }
            fs.rmSync(sessionDir, { recursive: true, force: true });
        } catch (err) {
            logger.error(`Error deleting session directory: ${err.message}`);
        }
    }

    // Create session directory if it doesn't exist
    if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    logger.info(`Creating socket for session: ${sessionName}`);
    logger.info(`Session directory: ${sessionDir}`);
    logger.info(`Has credentials: ${fs.existsSync(path.join(sessionDir, 'creds.json'))}`);

    // Initialize in-memory store
    if (!sessionStores.has(sessionName)) {
        logger.info(`Initializing in-memory store for session: ${sessionName}`);
        const store = createInMemoryStore({ logger });

        // Try to read from file if exists
        const storePath = path.join(sessionDir, 'baileys_store.json');
        if (fs.existsSync(storePath)) {
            try {
                store.readFromFile(storePath);
                logger.info(`Loaded store from file for session: ${sessionName}`);
            } catch (err) {
                logger.error(`Failed to load store from file: ${err.message}`);
            }
        }

        // Save to file every 10 seconds
        setInterval(() => {
            try {
                store.writeToFile(storePath);
            } catch (err) {
                // Ignore write errors
            }
        }, 10_000);

        sessionStores.set(sessionName, store);
    }

    const store = sessionStores.get(sessionName);

    const sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: true, // Enable QR code in terminal
        auth: state,
        browser: ['WhatsApp Bulk', 'Chrome', '1.0.0'],
        syncFullHistory: true, // ✅ CRITICAL: Enable full message history sync
        generateHighQualityLinkPreview: true, // Enable link previews
        getMessage: async (key) => {
            // Return message from store if available (according to Baileys docs)
            if (key && key.remoteJid) {
                const messageStore = sessionMessages.get(sessionName);
                if (messageStore && messageStore.has(key.remoteJid)) {
                    const chatMessages = messageStore.get(key.remoteJid);
                    const found = chatMessages.find(m => m.key?.id === key.id);
                    if (found) {
                        return found.message;
                    }
                }
            }
            // Fallback: return placeholder
            return {
                conversation: 'Message'
            };
        }
    });

    // Bind store to socket events
    store.bind(sock.ev);
    sock.store = store; // Attach store to socket for API access

    // Listen for contacts sync
    sock.ev.on('contacts.upsert', (contacts) => {
        logger.info(`📇 Contacts upsert: ${contacts.length} contacts`);
        // Contacts are automatically stored in sock.store.contacts via store.bind
    });

    sock.ev.on('contacts.update', (updates) => {
        logger.info(`📇 Contacts updated: ${updates.length} contacts`);
    });

    // Log when contacts are ready
    setTimeout(() => {
        if (sock.store && sock.store.contacts) {
            const contacts = sock.store.contacts;
            const contactCount = contacts instanceof Map ? contacts.size : Object.keys(contacts).length;
            logger.info(`📇 Contact store has ${contactCount} contacts`);

            // Log sample contacts
            if (contacts instanceof Map) {
                for (const [id, contact] of Array.from(contacts.entries()).slice(0, 5)) {
                    logger.info(`Contact: ${id} => ${contact.name || contact.notify || contact.pushName || 'No name'}`);
                }
            } else {
                const keys = Object.keys(contacts).slice(0, 5);
                for (const key of keys) {
                    const contact = contacts[key];
                    logger.info(`Contact: ${key} => ${contact.name || contact.notify || contact.pushName || 'No name'}`);
                }
            }
        }
    }, 5000);

    // Save credentials whenever they update
    sock.ev.on('creds.update', async () => {
        try {
            await saveCreds();
            logger.info(`✓ Credentials saved for session: ${sessionName}`);
        } catch (err) {
            logger.error(`Error saving credentials: ${err.message}`);
        }
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr, isNewLogin, isOnline } = update;

        // Log all connection updates for debugging
        logger.info(`Session ${sessionName} - connection: ${connection}, hasQR: ${!!qr}, isNewLogin: ${isNewLogin}, isOnline: ${isOnline}`);

        // Handle QR code - according to Baileys docs, QR is emitted when connection === "connecting" or when qr is present
        if (qr) {
            try {
                logger.info(`QR code received for session: ${sessionName}`);
                logger.info(`QR code length: ${qr.length} characters`);

                // Generate QR code image
                const qrImage = await QRCode.toDataURL(qr, {
                    errorCorrectionLevel: 'M',
                    type: 'image/png',
                    quality: 0.92,
                    margin: 1,
                    width: 300
                });

                const base64QR = qrImage.split(',')[1]; // Store base64 without data URL prefix
                qrCodes.set(sessionName, base64QR);
                logger.info(`✓ QR code generated and stored for session: ${sessionName}`);

                // Also log QR to terminal for visibility
                console.log(`\n=== QR CODE FOR ${sessionName} ===`);
                console.log(qr);
                console.log(`=== END QR CODE ===\n`);
            } catch (err) {
                logger.error('Error generating QR code:', err);
                logger.error('Error stack:', err.stack);
            }
        }

        // Handle connection states
        if (connection === 'connecting') {
            logger.info(`Session ${sessionName} is connecting...`);
            // Store socket even during connecting to keep it alive
            if (!sockets.has(sessionName)) {
                sockets.set(sessionName, sock);
            }
        } else if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            logger.info(`Session ${sessionName} disconnected. Status code: ${statusCode}`);
            logger.info(`Should reconnect: ${shouldReconnect}`);

            sockets.delete(sessionName);
            qrCodes.delete(sessionName);
            sessionChats.delete(sessionName); // Clear chats on disconnect

            if (shouldReconnect) {
                logger.info(`Reconnecting session ${sessionName} in 3 seconds...`);
                setTimeout(() => startSocket(sessionName), 3000);
            } else {
                logger.info(`Session ${sessionName} logged out (not reconnecting)`);
            }
        } else if (connection === 'open') {
            logger.info(`✓ Session ${sessionName} connected successfully`);
            logger.info(`User ID: ${sock.user?.id || 'N/A'}`);
            logger.info(`Phone number: ${sock.user?.id?.split(':')[0] || 'N/A'}`);

            // Ensure socket is stored
            sockets.set(sessionName, sock);
            qrCodes.delete(sessionName); // Clear QR as we're connected

            // Force save credentials one more time after connection
            try {
                await saveCreds();
                logger.info(`✓ Final credentials save after connection for session: ${sessionName}`);
            } catch (err) {
                logger.error(`Error in final credentials save: ${err.message}`);
            }
        }
    });

    // Listen for chat updates - this is how Baileys provides chats
    sock.ev.on('chats.update', async (chats) => {
        logger.info(`📱 Chats update event for ${sessionName}: ${chats.length} chats`);
        if (!sessionChats.has(sessionName)) {
            sessionChats.set(sessionName, new Map());
        }
        const chatMap = sessionChats.get(sessionName);

        for (const chat of chats) {
            if (chat.id) {
                chatMap.set(chat.id, chat);
                logger.info(`  - Updated chat: ${chat.id} (${chat.name || chat.subject || 'Unknown'})`);
            }
        }
    });

    // Listen for messaging history set - initial chat load
    sock.ev.on('messaging-history.set', async (history) => {
        logger.info(`📚 Messaging history set for ${sessionName}`);

        // Ensure chat & message stores exist
        if (!sessionChats.has(sessionName)) {
            sessionChats.set(sessionName, new Map());
        }
        if (!sessionMessages.has(sessionName)) {
            sessionMessages.set(sessionName, new Map());
        }

        const chatMap = sessionChats.get(sessionName);
        const messageStore = sessionMessages.get(sessionName);

        // Store chats and extract messages from chats
        let totalMessagesStored = 0;
        if (history.chats) {
            logger.info(`  - Loading ${history.chats.length} chats from history`);
            for (const chat of history.chats) {
                if (chat.id) {
                    chatMap.set(chat.id, chat);

                    // ✅ Extract messages from chat.messages or chat.raw.messages
                    const chatMessages = chat.messages || chat.raw?.messages || [];
                    if (chatMessages.length > 0) {
                        logger.info(`    - Found ${chatMessages.length} messages in chat ${chat.id}`);

                        for (const msgWrapper of chatMessages) {
                            // Handle nested structure: msgWrapper.message or just msgWrapper
                            const msg = msgWrapper.message || msgWrapper;

                            if (!msg || !msg.key) continue;

                            const jid = msg.key.remoteJid || chat.id;
                            const msgId = msg.key.id;
                            if (!jid || !msgId) continue;

                            if (!messageStore.has(jid)) {
                                messageStore.set(jid, []);
                            }
                            const storedMessages = messageStore.get(jid);

                            // avoid duplicates
                            const exists = storedMessages.some(m => m.key?.id === msgId);
                            if (!exists) {
                                // Ensure messageTimestamp is a number (convert string to number)
                                if (msg.messageTimestamp && typeof msg.messageTimestamp === 'string') {
                                    msg.messageTimestamp = parseInt(msg.messageTimestamp, 10);
                                }
                                storedMessages.push(msg);
                                totalMessagesStored++;
                                logger.debug(`      - Stored message ${msgId} for chat ${jid}`);
                                // Keep only last 100 messages per chat to avoid memory issues
                                if (storedMessages.length > 100) {
                                    storedMessages.shift();
                                }
                            } else {
                                logger.debug(`      - Skipped duplicate message ${msgId} for chat ${jid}`);
                            }
                        }
                    }
                }
            }
        }

        // ✅ Also check history.messages (if messages are at root level)
        if (history.messages) {
            logger.info(`  - Loading ${history.messages.length} messages from history.messages`);
            for (const msg of history.messages) {
                const jid = msg.key?.remoteJid;
                const msgId = msg.key?.id;
                if (!jid || !msgId) continue;

                if (!messageStore.has(jid)) {
                    messageStore.set(jid, []);
                }
                const chatMessages = messageStore.get(jid);

                // avoid duplicates
                const exists = chatMessages.some(m => m.key?.id === msgId);
                if (!exists) {
                    chatMessages.push(msg);
                    totalMessagesStored++;
                    // Keep only last 100 messages per chat to avoid memory issues
                    if (chatMessages.length > 100) {
                        chatMessages.shift();
                    }
                }
            }
        }

        if (totalMessagesStored > 0) {
            logger.info(`  ✓ Stored ${totalMessagesStored} messages from history (from chats + root messages)`);
        }
    });

    // Store messages as they come in (according to Baileys docs)
    if (!sessionMessages.has(sessionName)) {
        sessionMessages.set(sessionName, new Map()); // jid -> messages array
    }
    const messageStore = sessionMessages.get(sessionName);

    sock.ev.on('messages.upsert', async (m) => {
        const { messages, type } = m;

        if (!messages || messages.length === 0) return;

        logger.info(`📨 Received ${messages.length} message(s) via messages.upsert (type: ${type})`);

        for (const message of messages) {
            // Store message by chat JID
            if (message.key && message.key.remoteJid) {
                const chatId = message.key.remoteJid;

                // Initialize message array for this chat if needed
                if (!messageStore.has(chatId)) {
                    messageStore.set(chatId, []);
                }

                const chatMessages = messageStore.get(chatId);

                // Check if message already exists (avoid duplicates)
                const messageId = message.key.id;
                const exists = chatMessages.some(m => m.key?.id === messageId);

                if (!exists) {
                    chatMessages.push(message);
                    // Keep only last 100 messages per chat to avoid memory issues
                    if (chatMessages.length > 100) {
                        chatMessages.shift(); // Remove oldest
                    }
                    logger.debug(`  - Stored message ${messageId} for chat ${chatId}`);
                }

                // Also capture chat info from messages
                if (!sessionChats.has(sessionName)) {
                    sessionChats.set(sessionName, new Map());
                }
                const chatMap = sessionChats.get(sessionName);

                // If chat doesn't exist, create a basic entry
                if (!chatMap.has(chatId)) {
                    chatMap.set(chatId, {
                        id: chatId,
                        name: chatId.split('@')[0],
                        conversationTimestamp: message.messageTimestamp
                    });
                }
            }

            // Capture real phone numbers from messages (senderPn workaround)
            if (message.key && message.key.senderPn) {
                const senderId = message.key.remoteJid;
                const realPhone = message.key.senderPn;
                logger.debug(`Received message from ${senderId} with real phone: ${realPhone}`);
            }
        }
    });

    // Track message delivery status
    sock.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            if (update.update && update.update.status) {
                const status = update.update.status;
                const key = update.key;

                if (key && key.remoteJid) {
                    const jid = key.remoteJid;
                    const messageId = key.id;

                    // Log delivery status
                    const statusMap = {
                        1: 'PENDING',
                        2: 'SERVER_ACK (sent to WhatsApp server)',
                        3: 'DELIVERY_ACK (delivered to recipient)',
                        4: 'READ (read by recipient)'
                    };

                    const statusText = statusMap[status] || `UNKNOWN (${status})`;
                    logger.info(`📨 Message ${messageId} to ${jid} - Status: ${statusText}`);

                    // If delivered, log success
                    if (status === 3) {
                        logger.info(`✅ Message ${messageId} successfully delivered to ${jid}`);
                    } else if (status === 4) {
                        logger.info(`✅✅ Message ${messageId} read by ${jid}`);
                    }
                }
            }
        }
    });

    // Track message delivery status
    sock.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            if (update.update) {
                const status = update.update.status;
                const key = update.key;

                if (key && status) {
                    const jid = key.remoteJid;
                    const messageId = key.id;

                    // Log delivery status
                    if (status === 1) {
                        logger.info(`Message ${messageId} to ${jid} - PENDING`);
                    } else if (status === 2) {
                        logger.info(`Message ${messageId} to ${jid} - SERVER_ACK (sent to WhatsApp server)`);
                    } else if (status === 3) {
                        logger.info(`Message ${messageId} to ${jid} - DELIVERY_ACK (delivered to recipient)`);
                    } else if (status === 4) {
                        logger.info(`Message ${messageId} to ${jid} - READ (read by recipient)`);
                    }
                }
            }
        }
    });

    return sock;
}

// API Routes

// Start a new session
app.post('/api/:session/start-session', async (req, res) => {
    const sessionName = req.params.session;
    const forceNew = req.query.force === 'true' || req.body.force === true;

    // Validate session name
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionName)) {
        return res.status(400).json({ error: 'Invalid session name' });
    }

    try {
        // If socket already exists and is connected, return success
        const existingSock = sockets.get(sessionName);
        if (existingSock && existingSock.user && !forceNew) {
            return res.json({ success: true, message: 'Session already connected' });
        }

        // Start new socket (will generate QR if needed)
        logger.info(`Starting new session: ${sessionName} (forceNew: ${forceNew})`);
        await startSocket(sessionName, forceNew);

        // Give it a moment to initialize and potentially generate QR
        await new Promise(resolve => setTimeout(resolve, 2000));

        res.json({ success: true, message: 'Session started. QR code will be available shortly.' });
    } catch (error) {
        logger.error('Error starting session:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get QR code
app.get('/api/:session/qrcode-session', async (req, res) => {
    const sessionName = req.params.session;
    const forceNew = req.query.force === 'true';

    // Check if already connected
    const existingSock = sockets.get(sessionName);
    if (existingSock && existingSock.user && !forceNew) {
        return res.json({ qrcode: null, connected: true, message: 'Session already connected' });
    }

    // Check if there's an existing auth state (no QR needed unless forced)
    const sessionDir = getSessionDir(sessionName);
    const credsPath = path.join(sessionDir, 'creds.json');
    if (fs.existsSync(credsPath) && !forceNew) {
        return res.json({
            qrcode: null,
            message: 'Session has existing credentials. Use ?force=true to generate new QR code.',
            needsForce: true
        });
    }

    // If socket doesn't exist or forcing new, start it
    if (forceNew || !sockets.has(sessionName)) {
        try {
            logger.info(`Starting socket for QR code generation: ${sessionName} (forceNew: ${forceNew})`);
            await startSocket(sessionName, forceNew);

            // Wait for QR code to generate (poll up to 20 seconds)
            let attempts = 0;
            const maxAttempts = 40; // 20 seconds total
            while (!qrCodes.has(sessionName) && attempts < maxAttempts) {
                await new Promise(resolve => setTimeout(resolve, 500));
                attempts++;

                // Log progress every 5 attempts
                if (attempts % 10 === 0) {
                    logger.info(`Waiting for QR code... (${attempts}/${maxAttempts})`);
                }
            }
        } catch (error) {
            logger.error(`Error starting socket for QR: ${error.message}`);
            return res.status(500).json({ error: error.message });
        }
    }

    const qrcode = qrCodes.get(sessionName);

    if (qrcode) {
        logger.info(`Returning QR code for session: ${sessionName}`);
        res.json({ qrcode: { base64: qrcode } });
    } else {
        logger.warn(`QR code not available for session: ${sessionName}`);
        res.json({
            qrcode: null,
            message: 'QR code not available yet. The socket may still be initializing. Please wait a few seconds and refresh.',
            retry: true
        });
    }
});

// Get session status
app.get('/api/:session/status-session', async (req, res) => {
    const sessionName = req.params.session;
    const sock = sockets.get(sessionName);

    if (sock && sock.user) {
        const phoneNumber = sock.user.id.split(':')[0];
        logger.info(`Status check for ${sessionName}: CONNECTED (${phoneNumber})`);
        res.json({
            status: 'CONNECTED',
            connected: true,
            phone: phoneNumber
        });
    } else {
        // Check if socket exists but not fully connected yet
        if (sock) {
            logger.info(`Status check for ${sessionName}: connecting (socket exists but no user yet)`);
            res.json({
                status: 'connecting',
                connected: false
            });
        } else if (qrCodes.has(sessionName)) {
            logger.info(`Status check for ${sessionName}: connecting (QR code exists)`);
            res.json({
                status: 'connecting',
                connected: false
            });
        } else {
            // Check if credentials exist (might be connecting)
            const sessionDir = getSessionDir(sessionName);
            const credsPath = path.join(sessionDir, 'creds.json');
            if (fs.existsSync(credsPath)) {
                logger.info(`Status check for ${sessionName}: connecting (credentials exist)`);
                res.json({
                    status: 'connecting',
                    connected: false
                });
            } else {
                logger.info(`Status check for ${sessionName}: disconnected`);
                res.json({
                    status: 'disconnected',
                    connected: false
                });
            }
        }
    }
});

// Get all chats (groups)
app.get('/api/:session/all-chats', async (req, res) => {
    const sessionName = req.params.session;
    const sock = sockets.get(sessionName);

    if (!sock || !sock.user) {
        return res.status(400).json({ error: 'Session not connected' });
    }

    try {
        const chats = await sock.groupFetchAllParticipating();
        const groups = [];

        for (const [groupId, group] of Object.entries(chats)) {
            if (groupId.endsWith('@g.us')) {
                groups.push({
                    id: groupId,
                    name: group.subject || 'Unknown Group',
                    participants: group.participants || [],
                    description: group.desc || '',
                    creation: group.creation || null
                });
            }
        }

        res.json({ groups });
    } catch (error) {
        logger.error('Error fetching groups:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get all chats (individual + groups) - Using sock.chats directly as per Baileys docs
app.get('/api/:session/chats', async (req, res) => {
    const sessionName = req.params.session;
    const sock = sockets.get(sessionName);

    if (!sock || !sock.user) {
        return res.status(400).json({ error: 'Session not connected' });
    }

    try {
        // Debug: Log all available properties on sock
        logger.info(`=== DEBUG: Checking chats for ${sessionName} ===`);

        let chats = [];
        let chatSource = 'none';

        // Method 1: Get chats from event-captured storage (most reliable)
        if (sessionChats.has(sessionName)) {
            const chatMap = sessionChats.get(sessionName);
            chats = Array.from(chatMap.values());
            chatSource = 'event-captured';
            logger.info(`Method 1: Found ${chats.length} chats from event listeners`);
        }

        // Method 2: Try sock.chats directly (per Baileys docs)
        if (chats.length === 0 && sock.chats) {
            logger.info(`Method 2: Found sock.chats, type: ${typeof sock.chats}`);
            if (typeof sock.chats === 'object') {
                chats = Object.values(sock.chats);
                chatSource = 'sock.chats';
                logger.info(`Found ${chats.length} chats from sock.chats`);
            }
        }

        // Method 3: Try sock.store.chats (Map or object)
        if (chats.length === 0 && sock.store && sock.store.chats) {
            logger.info(`Method 3: Found sock.store.chats`);
            const storeChats = sock.store.chats;

            if (storeChats instanceof Map) {
                chats = Array.from(storeChats.values());
                chatSource = 'store.chats (Map)';
            } else if (typeof storeChats === 'object' && storeChats !== null) {
                chats = Object.values(storeChats);
                chatSource = 'store.chats (object)';
            }
            logger.info(`Found ${chats.length} chats from store.chats`);
        }

        // Method 4: Try to fetch groups separately (fallback)
        if (chats.length === 0) {
            logger.info(`Method 4: Trying to fetch groups separately`);
            try {
                const groups = await sock.groupFetchAllParticipating();
                logger.info(`Fetched ${Object.keys(groups).length} groups`);

                // Convert groups to chat format
                for (const [groupId, group] of Object.entries(groups)) {
                    if (groupId.endsWith('@g.us')) {
                        chats.push({
                            id: groupId,
                            subject: group.subject,
                            name: group.subject || 'Group',
                            participants: group.participants || [],
                            type: 'group'
                        });
                    }
                }
                chatSource = 'groupFetchAllParticipating';
                logger.info(`Added ${chats.length} groups from groupFetchAllParticipating`);
            } catch (groupError) {
                logger.warn(`Error fetching groups: ${groupError.message}`);
            }
        }

        logger.info(`=== Total chats found: ${chats.length}, source: ${chatSource} ===`);

        // Map to store merged chats by canonical ID (Phone JID)
        const mergedChats = new Map();

        // First pass: Process all chats and resolve LIDs
        for (const chat of chats) {
            if (!chat) continue;

            const chatId = chat.id || chat.jid || (typeof chat === 'string' ? chat : null);
            if (!chatId) continue;

            // Skip broadcast and system chats
            if (chatId === 'status@broadcast' || chatId.includes('broadcast') || chatId === 'server@c.us') {
                continue;
            }

            let canonicalId = chatId;
            let chatType = 'individual';
            let chatName = 'Unknown';
            let isLid = false;

            // Determine type and canonical ID
            if (chatId.endsWith('@g.us')) {
                chatType = 'group';
                chatName = chat.subject || chat.name || 'Group';
            } else if (chatId.endsWith('@s.whatsapp.net')) {
                chatType = 'individual';
                const phone = chatId.split(':')[0] || chatId.replace('@s.whatsapp.net', '');
                chatName = chat.name || chat.notify || chat.pushName || phone;
            } else if (chatId.endsWith('@lid')) {
                chatType = 'individual';
                isLid = true;

                // Try to resolve LID to phone number
                let resolvedPhone = null;
                let resolvedName = null;

                if (sock.store && sock.store.contacts) {
                    const contact = sock.store.contacts[chatId] || (sock.store.contacts.get ? sock.store.contacts.get(chatId) : null);
                    if (contact) {
                        resolvedName = contact.name || contact.notify || contact.pushName;
                        if (contact.phoneNumber) {
                            resolvedPhone = contact.phoneNumber;
                        }
                    }
                }

                // If we found a phone number, construct the canonical Phone JID
                if (resolvedPhone) {
                    canonicalId = `${resolvedPhone}@s.whatsapp.net`;
                    chatName = resolvedName || resolvedPhone;
                } else {
                    // Fallback: try to extract from LID if it looks like a number (rare but possible)
                    const lidMatch = chatId.match(/^(\d+)@lid$/);
                    if (lidMatch && lidMatch[1] && lidMatch[1].length >= 10 && lidMatch[1].length <= 15) {
                        canonicalId = `${lidMatch[1]}@s.whatsapp.net`;
                        chatName = resolvedName || lidMatch[1];
                    } else {
                        // Cannot resolve, keep as LID
                        chatName = resolvedName || chat.name || chat.notify || chat.pushName || 'Unknown Contact';
                    }
                }
            } else {
                continue; // Skip unknown formats
            }

            // Prepare formatted chat object
            const formattedChat = {
                id: canonicalId, // Use canonical ID (Phone JID if resolved)
                originalId: chatId, // Keep track of the ID this specific entry came from
                name: chatName,
                type: chatType,
                unreadCount: chat.unreadCount || chat.unread || 0,
                lastMessageTime: chat.conversationTimestamp ? new Date(chat.conversationTimestamp * 1000).toISOString() : null,
                pinned: chat.pinned || false,
                raw: chat
            };

            // Merge into map
            if (mergedChats.has(canonicalId)) {
                const existing = mergedChats.get(canonicalId);

                // Merge logic:
                // 1. Prefer name from Phone JID if available, or whichever is not "Unknown"
                if (existing.name === 'Unknown' && formattedChat.name !== 'Unknown') {
                    existing.name = formattedChat.name;
                }

                // 2. Sum unread counts
                existing.unreadCount += formattedChat.unreadCount;

                // 3. Keep the latest message time
                if (formattedChat.lastMessageTime) {
                    if (!existing.lastMessageTime || new Date(formattedChat.lastMessageTime) > new Date(existing.lastMessageTime)) {
                        existing.lastMessageTime = formattedChat.lastMessageTime;
                        // If the LID has a newer message, we might want to keep its raw data for preview? 
                        // For now, let's keep the raw data of the Phone JID if possible, or update if LID is newer.
                        // Actually, keeping the raw data of the *latest* message is usually better for previews.
                        existing.raw = formattedChat.raw;
                    }
                }

                // 4. If we are merging a LID into a Phone JID, ensure the ID stays as Phone JID
                // (Already handled by using canonicalId as key)

            } else {
                mergedChats.set(canonicalId, formattedChat);
            }
        }

        // Convert map to array
        const formattedChats = Array.from(mergedChats.values());

        // Sort by last message time (most recent first)
        formattedChats.sort((a, b) => {
            if (a.lastMessageTime && b.lastMessageTime) {
                return new Date(b.lastMessageTime) - new Date(a.lastMessageTime);
            }
            if (a.lastMessageTime) return -1;
            if (b.lastMessageTime) return 1;
            return a.name.localeCompare(b.name);
        });

        logger.info(`Returning ${formattedChats.length} formatted chats`);

        res.json({
            success: true,
            chats: formattedChats,
            total: formattedChats.length,
            source: chatSource,
            debug: {
                hasSockChats: !!sock.chats,
                hasStore: !!sock.store,
                hasStoreChats: !!(sock.store && sock.store.chats),
                rawChatsCount: chats.length
            },
            note: chats.length === 0 ?
                'No chats found. This might mean: 1) History sync not completed yet, 2) No chats in account, 3) Chats stored in different location. Check server logs for details.' :
                'Baileys loads chats gradually. Wait 5-20 seconds after connection for all chats to sync.'
        });
    } catch (error) {
        logger.error('Error fetching chats:', error);
        logger.error('Error stack:', error.stack);
        res.status(500).json({ error: error.message });
    }
});

// Get group info - FIXED VERSION
app.get('/api/:session/group-info/:groupId', async (req, res) => {
    const sessionName = req.params.session;
    const groupId = req.params.groupId;
    const sock = sockets.get(sessionName);

    if (!sock || !sock.user) {
        return res.status(400).json({ error: 'Session not connected' });
    }

    const timeout = setTimeout(() => {
        if (!res.headersSent) {
            res.status(504).json({ error: 'Request timeout' });
        }
    }, 60000);

    try {
        logger.info(`Fetching group info for ${groupId}`);

        const groupMetadata = await Promise.race([
            sock.groupMetadata(groupId),
            new Promise((_, reject) => setTimeout(() => reject(new Error('groupMetadata timeout')), 30000))
        ]);

        const participants = [];
        logger.info(`Group has ${groupMetadata.participants.length} participants`);

        // Helper function to get contact name from store
        function getContactName(jid) {
            if (!sock.store || !sock.store.contacts) return null;

            // Handle both Map and Object store implementations
            let contact = null;
            if (sock.store.contacts instanceof Map) {
                contact = sock.store.contacts.get(jid);
            } else {
                contact = sock.store.contacts[jid];
            }

            if (contact) {
                return contact.name || contact.notify || contact.pushName ||
                    contact.verifiedName || null;
            }
            return null;
        }

        // Process participants
        for (const participant of groupMetadata.participants) {
            const participantId = participant.id;
            let phone = null;
            let name = null;

            // Extract phone number
            if (participantId.includes('@s.whatsapp.net')) {
                phone = participantId.split(':')[0].split('@')[0];
            } else if (participantId.includes('@lid')) {
                const lidMatch = participantId.match(/^(\d+)@lid$/);
                if (lidMatch && lidMatch[1]) {
                    phone = lidMatch[1];
                }
            }

            // Try to get name from contact store
            name = getContactName(participantId);

            // If LID and no name, try phone JID
            if (!name && participantId.includes('@lid') && phone) {
                const phoneJid = `${phone}@s.whatsapp.net`;
                name = getContactName(phoneJid);
            }

            // Fallback: Check message history for pushName
            if (!name) {
                const messageStore = sessionMessages.get(sessionName);
                if (messageStore) {
                    const messages = messageStore.get(participantId) ||
                        messageStore.get(`${phone}@s.whatsapp.net`) || [];

                    for (let i = messages.length - 1; i >= 0; i--) {
                        const msg = messages[i];
                        if (msg && msg.pushName) {
                            name = msg.pushName;
                            break;
                        }
                    }
                }
            }

            // Final fallback: Use phone number as name
            if (!name && phone) {
                name = `+${phone}`;
            }

            const isAdmin = participant.admin === 'admin' ||
                participant.admin === 'superadmin';

            participants.push({
                id: participantId,
                phone: phone,
                name: name,
                admin: isAdmin
            });
        }

        const participantsWithNames = participants.filter(p => p.name).length;
        logger.info(`Name fetch complete: ${participantsWithNames}/${participants.length} have names`);

        clearTimeout(timeout);
        res.json({
            response: {
                participants: participants,
                subject: groupMetadata.subject,
                creation: groupMetadata.creation,
                desc: groupMetadata.desc
            }
        });

    } catch (error) {
        clearTimeout(timeout);
        logger.error('Error fetching group info:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: error.message });
        }
    }
});

// Get messages for a specific chat
app.get('/api/:session/messages/:jid', async (req, res) => {
    const sessionName = req.params.session;
    const jid = decodeURIComponent(req.params.jid);
    const requestedLimit = parseInt(req.query.limit) || 20;
    const minMessages = 5; // Minimum messages to return (WhatsApp MD only provides 20-30 max)
    const maxRetries = 5; // Maximum retry attempts
    const retryDelay = 1000; // Delay between retries (ms)
    const sock = sockets.get(sessionName);

    if (!sock || !sock.user) {
        return res.status(400).json({ error: 'Session not connected' });
    }

    try {
        logger.info(`Loading messages for ${jid} from session ${sessionName}, requested limit: ${requestedLimit}`);

        // Get unread count from chat data
        let unreadCount = 0;
        try {
            const chatMap = sessionChats.get(sessionName);
            if (chatMap && chatMap.has(jid)) {
                const chat = chatMap.get(jid);
                unreadCount = chat?.unreadCount || chat?.count || chat?.unread || 0;
            }
        } catch (e) {
            logger.debug(`Could not get unread count: ${e.message}`);
        }

        // Strategy 1: Use helper function to get messages (unread + last N) from our store
        // This includes messages from both messaging-history.set and messages.upsert
        let messages = getMessagesForChat(sessionName, jid, Math.max(minMessages, requestedLimit));

        if (messages.length > 0) {
            logger.info(`✓ Found ${messages.length} messages using getMessagesForChat helper (includes history + new messages)`);
        } else {
            // Fallback: Try to extract messages directly from chat's raw data if available
            logger.info(`No messages in store for ${jid}, checking chat raw data...`);
            const chatMap = sessionChats.get(sessionName);
            if (chatMap && chatMap.has(jid)) {
                const chat = chatMap.get(jid);
                const rawMessages = chat.messages || chat.raw?.messages || [];
                if (rawMessages.length > 0) {
                    logger.info(`Found ${rawMessages.length} messages in chat raw data, extracting...`);
                    // Extract and format messages from raw data
                    for (const msgWrapper of rawMessages) {
                        const msg = msgWrapper.message || msgWrapper;
                        if (msg && msg.key && msg.key.id) {
                            // Ensure messageTimestamp is a number
                            if (msg.messageTimestamp && typeof msg.messageTimestamp === 'string') {
                                msg.messageTimestamp = parseInt(msg.messageTimestamp, 10);
                            }
                            messages.push(msg);
                        }
                    }
                    logger.info(`Extracted ${messages.length} messages from raw chat data`);

                    // Store these messages for future use
                    if (!sessionMessages.has(sessionName)) {
                        sessionMessages.set(sessionName, new Map());
                    }
                    const msgStore = sessionMessages.get(sessionName);
                    if (!msgStore.has(jid)) {
                        msgStore.set(jid, []);
                    }
                    // Add to store (avoid duplicates)
                    for (const msg of messages) {
                        const exists = msgStore.get(jid).some(m => m.key?.id === msg.key?.id);
                        if (!exists) {
                            msgStore.get(jid).push(msg);
                        }
                    }
                }
            }
        }

        // Strategy 2: Try Baileys store (if available) - fallback only
        if (messages.length === 0 && sock.store && sock.store.messages) {
            try {
                const storeMessages = sock.store.messages.get(jid);
                if (storeMessages) {
                    const storeArray = Array.from(storeMessages.values());
                    if (storeArray.length > 0) {
                        // Get last N messages, sorted by timestamp
                        const limit = Math.max(minMessages, requestedLimit);
                        const sorted = storeArray
                            .sort((a, b) => (b.messageTimestamp || 0) - (a.messageTimestamp || 0))
                            .slice(0, limit);
                        messages = sorted;
                        logger.info(`✓ Found ${messages.length} messages in Baileys store for ${jid} (fallback)`);
                    }
                }
            } catch (e) {
                logger.debug(`Baileys store check failed: ${e.message}`);
            }
        }

        // Strategy 3: Try loading from WhatsApp (with small limit - WhatsApp MD limitation)
        if (messages.length === 0) {
            const smallLimit = 10; // WhatsApp MD typically provides 20-30 max
            try {
                logger.info(`Attempting to load ${smallLimit} messages from WhatsApp...`);
                const loadedMessages = await sock.loadMessages(jid, smallLimit);
                if (loadedMessages && loadedMessages.length > 0) {
                    messages = loadedMessages;
                    logger.info(`✓ Successfully loaded ${messages.length} messages from WhatsApp`);

                    // Store these messages for future use
                    if (!messageStore) {
                        sessionMessages.set(sessionName, new Map());
                    }
                    const msgStore = sessionMessages.get(sessionName);
                    if (!msgStore.has(jid)) {
                        msgStore.set(jid, []);
                    }
                    // Add to store (avoid duplicates)
                    for (const msg of loadedMessages) {
                        const exists = msgStore.get(jid).some(m => m.key?.id === msg.key?.id);
                        if (!exists) {
                            msgStore.get(jid).push(msg);
                        }
                    }
                }
            } catch (error) {
                logger.warn(`Failed to load messages from WhatsApp: ${error.message}`);
                logger.info(`This is a WhatsApp MD limitation. Messages should be available from:`);
                logger.info(`  1. History sync (messaging-history.set) - now stored automatically`);
                logger.info(`  2. New messages (messages.upsert) - stored automatically`);
                logger.info(`  3. Recent messages if chat opened on linked device (last resort)`);
            }
        }

        // Final result
        if (messages.length > 0) {
            logger.info(`✓ Final result: ${messages.length} messages loaded for ${jid} (from history sync + new messages)`);
        } else {
            logger.info(`⚠ No messages available for ${jid}`);
            logger.info(`  Messages will appear after:`);
            logger.info(`  1. History sync completes (messaging-history.set event)`);
            logger.info(`  2. New messages arrive (messages.upsert event)`);
            logger.info(`  3. Chat is opened on linked device (for recent messages)`);
        }

        // Format messages for response
        const formattedMessages = messages.map(msg => {
            try {
                const messageId = msg.key?.id;
                const from = msg.key?.remoteJid || jid;
                const fromMe = msg.key?.fromMe || false;

                // Handle timestamp (can be string or number, in seconds)
                let timestamp = null;
                if (msg.messageTimestamp) {
                    try {
                        const ts = typeof msg.messageTimestamp === 'string'
                            ? parseInt(msg.messageTimestamp, 10)
                            : msg.messageTimestamp;
                        if (!isNaN(ts) && ts > 0) {
                            timestamp = new Date(ts * 1000).toISOString();
                        }
                    } catch (e) {
                        logger.debug(`Error parsing timestamp: ${e.message}`);
                    }
                }

                // Check if message is unread (messages that are not from me and might be unread)
                // Note: Baileys doesn't directly mark messages as unread, but we can infer
                // by checking if it's recent and not from me
                const isRecent = timestamp && (Date.now() - new Date(timestamp).getTime()) < 24 * 60 * 60 * 1000; // Last 24 hours
                const mightBeUnread = !fromMe && isRecent;

                // Extract message content
                let messageText = '';
                let messageType = 'unknown';

                if (msg.message?.conversation) {
                    messageText = msg.message.conversation;
                    messageType = 'text';
                } else if (msg.message?.extendedTextMessage?.text) {
                    messageText = msg.message.extendedTextMessage.text;
                    messageType = 'text';
                } else if (msg.message?.imageMessage) {
                    messageText = msg.message.imageMessage.caption || '[Image]';
                    messageType = 'image';
                } else if (msg.message?.videoMessage) {
                    messageText = msg.message.videoMessage.caption || '[Video]';
                    messageType = 'video';
                } else if (msg.message?.audioMessage) {
                    messageText = '[Audio]';
                    messageType = 'audio';
                } else if (msg.message?.documentMessage) {
                    messageText = '[Document] ' + (msg.message.documentMessage.fileName || '');
                    messageType = 'document';
                } else if (msg.message?.stickerMessage) {
                    messageText = '[Sticker]';
                    messageType = 'sticker';
                }

                return {
                    id: messageId,
                    from: from,
                    fromMe: fromMe,
                    text: messageText,
                    type: messageType,
                    timestamp: timestamp,
                    mightBeUnread: mightBeUnread,
                    raw: msg // Include raw for debugging
                };
            } catch (e) {
                logger.warn(`Error formatting message: ${e.message}`, msg);
                // Return a minimal valid message object
                return {
                    id: msg.key?.id || 'unknown',
                    from: msg.key?.remoteJid || jid,
                    fromMe: msg.key?.fromMe || false,
                    text: '[Error formatting message]',
                    type: 'unknown',
                    timestamp: null,
                    mightBeUnread: false,
                    raw: msg
                };
            }
        }).filter(msg => msg !== null && msg.id); // Filter out any null/invalid messages

        // Sort messages: unread/recent first, then by timestamp (newest first for display)
        formattedMessages.sort((a, b) => {
            // Prioritize potentially unread messages
            if (a.mightBeUnread && !b.mightBeUnread) return -1;
            if (!a.mightBeUnread && b.mightBeUnread) return 1;

            // Then sort by timestamp (newest first)
            const timeA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
            const timeB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
            return timeB - timeA;
        });

        // Take the most recent messages (WhatsApp MD limit: 20-30 messages max)
        // Don't try to get more than what WhatsApp provides
        const finalLimit = Math.min(20, Math.max(minMessages, Math.min(requestedLimit, formattedMessages.length)));
        const finalMessages = formattedMessages.slice(0, finalLimit);

        // Reverse to show oldest first (for chat display)
        finalMessages.reverse();

        logger.info(`Returning ${finalMessages.length} messages for ${jid} (from ${formattedMessages.length} total, unread: ${unreadCount})`);

        // Return success even if no messages (WhatsApp MD limitation, not an error)
        res.json({
            success: true,
            messages: finalMessages,
            total: finalMessages.length,
            unreadCount: unreadCount,
            jid: jid,
            warning: messages.length === 0 ?
                'No messages available. This is a WhatsApp MD limitation - messages are only available if the chat was recently opened on the linked device.' :
                null
        });
    } catch (error) {
        logger.error('Error loading messages:', error);
        logger.error('Error stack:', error.stack);
        // Don't return 500 error - return empty messages with explanation
        if (!res.headersSent) {
            res.json({
                success: true,
                messages: [],
                total: 0,
                unreadCount: 0,
                jid: jid,
                error: error.message,
                warning: `Error loading messages: ${error.message}. Messages are only available if the chat was recently opened on the linked device.`
            });
        }
    }
});

// Send message
app.post('/api/:session/send-message', async (req, res) => {
    const sessionName = req.params.session;
    const { phone, message, chatId, chatJid, isGroup } = req.body;
    const sock = sockets.get(sessionName);

    if (!sock || !sock.user) {
        return res.status(400).json({ error: 'Session not connected' });
    }

    if (!message) {
        return res.status(400).json({ error: 'Message is required' });
    }

    try {
        let jid;

        // Support chatJid, chatId (for replying to existing chats) and phone (for new chats)
        // chatJid is the preferred parameter name from frontend
        const targetJid = chatJid || chatId;

        if (targetJid && targetJid.includes('@')) {
            // Direct JID provided (for replying to chats) - can be individual or group
            jid = targetJid;
            const isGroupChat = jid.endsWith('@g.us');
            logger.info(`Sending message to ${isGroupChat ? 'group' : 'chat'}: ${jid}`);
        } else if (isGroup && chatId) {
            jid = chatId;
            logger.info(`Sending message to group: ${jid}`);
        } else if (phone) {
            // Format phone number - remove all non-digits
            let cleanPhone = phone.replace(/[^\d]/g, '');

            // Remove @s.whatsapp.net if present
            cleanPhone = cleanPhone.replace('@s.whatsapp.net', '');

            // Validate phone number length (should be 10-15 digits)
            if (cleanPhone.length < 10 || cleanPhone.length > 15) {
                return res.status(400).json({
                    error: `Invalid phone number length: ${cleanPhone.length} digits. Phone number should be 10-15 digits.`
                });
            }

            jid = `${cleanPhone}@s.whatsapp.net`;
            logger.info(`Sending message to phone: ${jid} (cleaned from: ${phone})`);

            // Verify the number is on WhatsApp before sending (optional but recommended)
            try {
                const exists = await sock.onWhatsApp(jid);
                if (!exists || !exists[0] || !exists[0].exists) {
                    logger.warn(`Phone number ${jid} is not on WhatsApp`);
                    return res.status(400).json({
                        error: `Phone number ${cleanPhone} is not registered on WhatsApp`
                    });
                }
                logger.info(`Verified ${jid} is on WhatsApp`);
            } catch (verifyError) {
                logger.warn(`Could not verify WhatsApp status for ${jid}: ${verifyError.message}`);
                // Continue anyway - sometimes verification fails but message can still be sent
            }
        } else {
            return res.status(400).json({ error: 'Either phone or chatId (with isGroup) is required' });
        }

        // Send the message
        logger.info(`📤 Attempting to send message to ${jid}`);
        logger.info(`📝 Message: ${message.substring(0, 50)}${message.length > 50 ? '...' : ''}`);

        const result = await sock.sendMessage(jid, { text: message });

        if (!result || !result.key) {
            throw new Error('Message send returned invalid response');
        }

        const messageId = result.key.id;
        logger.info(`✅ Message sent to ${jid}, messageId: ${messageId}`);
        logger.info(`📊 Message status will be tracked - check logs for delivery updates`);
        logger.info(`💡 Note: Status 2 = sent to server, Status 3 = delivered, Status 4 = read`);

        res.json({
            success: true,
            messageId: messageId,
            jid: jid,
            status: 'sent',
            note: 'Message accepted by WhatsApp. Check server logs for delivery status (Status 3 = delivered).'
        });
    } catch (error) {
        logger.error('Error sending message:', error);
        logger.error('Error details:', {
            session: sessionName,
            phone: phone,
            chatId: chatId,
            isGroup: isGroup,
            errorMessage: error.message,
            errorStack: error.stack
        });

        // Provide more detailed error message
        let errorMessage = error.message;
        if (error.message.includes('not-authorized')) {
            errorMessage = 'Session not authorized. Please reconnect your WhatsApp session.';
        } else if (error.message.includes('rate limit')) {
            errorMessage = 'Rate limit exceeded. Please wait before sending more messages.';
        } else if (error.message.includes('not found') || error.message.includes('404')) {
            errorMessage = 'Recipient not found on WhatsApp.';
        }

        res.status(500).json({ error: errorMessage });
    }
});

// Close session
app.delete('/api/:session/close-session', async (req, res) => {
    const sessionName = req.params.session;
    const sock = sockets.get(sessionName);

    if (sock) {
        try {
            await sock.logout();
            sockets.delete(sessionName);
        } catch (error) {
            logger.error('Error closing session:', error);
        }
    }

    // Delete session directory
    const sessionDir = getSessionDir(sessionName);
    if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }

    qrCodes.delete(sessionName);

    res.json({ success: true, message: 'Session closed' });
});

// Start server
app.listen(PORT, () => {
    logger.info(`Baileys WhatsApp API server running on port ${PORT}`);
    logger.info(`Sessions directory: ${SESSIONS_DIR}`);
    logger.info(`Secret token: ${SECRET_TOKEN.substring(0, 10)}...`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    logger.info('SIGTERM received, closing all sessions...');
    for (const [sessionName, sock] of sockets.entries()) {
        try {
            sock.end();
        } catch (error) {
            logger.error(`Error closing session ${sessionName}:`, error);
        }
    }
    process.exit(0);
});



