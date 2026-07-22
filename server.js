const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { customAlphabet } = require('nanoid');
const { version } = require('./package.json');

const PORT = process.env.PORT || 3000;
const GIT_COMMIT = process.env.GIT_COMMIT || 'dev';
const TURN_SECRET = process.env.TURN_SECRET || '';
const TURN_HOST = process.env.TURN_HOST || 'monvo.uz';
const TURN_CREDENTIAL_TTL_SECONDS = 24 * 3600;
const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // no 0/O/1/I confusion
const makeRoomCode = customAlphabet(ROOM_CODE_ALPHABET, 6);

const MAX_USERS_PER_ROOM = 6;
const MAX_NAME_LENGTH = 24;
const MAX_MESSAGE_LENGTH = 500;
const MAX_HISTORY = 200;
const ROOM_EMPTY_GRACE_MS = 45000; // keep an empty room alive briefly so a page refresh can rejoin
const MAX_ROOMS_PER_SOCKET = 10; // basic abuse guard against a single connection spamming create-room
const YOUTUBE_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

const app = express();
app.set('trust proxy', true); // behind Caddy + Cloudflare
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: false },
});

// Cloudflare/browsers cache /css and /js by URL for hours. Stamping them with
// the build's commit hash means each deploy gets a brand-new URL, so a stale
// cached copy can never be served after an update — no manual purge needed.
const indexHtml = fs
  .readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8')
  .replace('/css/style.css', `/css/style.css?v=${GIT_COMMIT}`)
  .replace('/js/client.js', `/js/client.js?v=${GIT_COMMIT}`);

app.get('/', (req, res) => {
  res.type('html').send(indexHtml);
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/version', (req, res) => {
  res.json({ version, commit: GIT_COMMIT });
});

// Short-lived TURN credentials (coturn's REST-API / "use-auth-secret" scheme),
// so the client never embeds a permanent shared TURN password.
function generateTurnCredentials() {
  const username = String(Math.floor(Date.now() / 1000) + TURN_CREDENTIAL_TTL_SECONDS);
  const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
  return { username, credential };
}

app.get('/api/ice-servers', (req, res) => {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];

  if (TURN_SECRET) {
    const { username, credential } = generateTurnCredentials();
    iceServers.push(
      { urls: `turn:${TURN_HOST}:3478?transport=udp`, username, credential },
      { urls: `turn:${TURN_HOST}:3478?transport=tcp`, username, credential }
    );
  }

  res.json({ iceServers });
});

// In-memory room store: code -> { users: Map<socketId, {name}>, video: {...} }
const rooms = new Map();

function sanitizeName(raw) {
  if (typeof raw !== 'string') return 'Mehmon';
  const trimmed = raw.trim().slice(0, MAX_NAME_LENGTH);
  return trimmed.length ? trimmed : 'Mehmon';
}

function createRoom() {
  let code;
  do {
    code = makeRoomCode();
  } while (rooms.has(code));

  const room = {
    code,
    users: new Map(),
    video: { url: null, isPlaying: false, currentTime: 0 },
    messages: [],
    emptyTimer: null,
  };
  rooms.set(code, room);
  return room;
}

function roomPeopleList(room) {
  return Array.from(room.users.entries()).map(([id, u]) => ({ id, name: u.name }));
}

function cancelRoomCleanup(room) {
  if (room.emptyTimer) {
    clearTimeout(room.emptyTimer);
    room.emptyTimer = null;
  }
}

// A page refresh briefly empties a room before the client reconnects, so we
// delay deletion instead of dropping the room the instant it's empty.
function scheduleRoomCleanup(room) {
  cancelRoomCleanup(room);
  room.emptyTimer = setTimeout(() => {
    if (room.users.size === 0) rooms.delete(room.code);
  }, ROOM_EMPTY_GRACE_MS);
}

io.on('connection', (socket) => {
  let currentRoomCode = null;
  let roomsCreatedBySocket = 0;

  socket.on('create-room', (payload, ack) => {
    if (typeof ack !== 'function') return;
    if (roomsCreatedBySocket >= MAX_ROOMS_PER_SOCKET) {
      ack({ ok: false, error: 'Juda ko‘p xona yaratildi. Sahifani yangilab qayta urinib ko‘ring.' });
      return;
    }
    roomsCreatedBySocket++;

    const name = sanitizeName(payload && payload.name);
    const clientId = typeof payload?.clientId === 'string' ? payload.clientId.slice(0, 64) : null;
    const room = createRoom();
    room.users.set(socket.id, { name, clientId });
    socket.join(room.code);
    currentRoomCode = room.code;
    socket.data.name = name;

    ack({ ok: true, code: room.code, people: roomPeopleList(room), video: room.video, messages: room.messages });
  });

  socket.on('join-room', (payload, ack) => {
    if (typeof ack !== 'function') return;
    const code = typeof payload?.code === 'string' ? payload.code.trim().toUpperCase() : '';
    const name = sanitizeName(payload && payload.name);
    const clientId = typeof payload?.clientId === 'string' ? payload.clientId.slice(0, 64) : null;
    const room = rooms.get(code);

    if (!room) {
      ack({ ok: false, error: 'Bunday xona topilmadi.' });
      return;
    }

    // A page refresh leaves the old connection lingering for a while (socket.io
    // hasn't noticed the disconnect yet). If this browser is already listed in
    // the room under a stale socket, evict that one instead of treating this
    // as a brand-new participant competing for a capacity slot.
    if (clientId) {
      for (const [sid, u] of room.users) {
        if (sid !== socket.id && u.clientId === clientId) {
          room.users.delete(sid);
          socket.to(room.code).emit('peer-left', { id: sid });
          const staleSocket = io.sockets.sockets.get(sid);
          if (staleSocket) staleSocket.disconnect(true);
        }
      }
    }

    if (room.users.size >= MAX_USERS_PER_ROOM) {
      ack({ ok: false, error: `Xona allaqachon to‘lgan (ko‘pi bilan ${MAX_USERS_PER_ROOM} kishi).` });
      return;
    }

    room.users.set(socket.id, { name, clientId });
    socket.join(room.code);
    currentRoomCode = room.code;
    socket.data.name = name;
    cancelRoomCleanup(room);

    ack({ ok: true, code: room.code, people: roomPeopleList(room), video: room.video, messages: room.messages });
    socket.to(room.code).emit('peer-joined', { id: socket.id, name });
  });

  socket.on('chat-message', (payload) => {
    if (!currentRoomCode) return;
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    const text = typeof payload?.text === 'string' ? payload.text.slice(0, MAX_MESSAGE_LENGTH).trim() : '';
    if (!text) return;

    const name = room.users.get(socket.id)?.name || 'Mehmon';
    const message = { id: socket.id, name, text, ts: Date.now() };
    room.messages.push(message);
    if (room.messages.length > MAX_HISTORY) room.messages.shift();

    io.to(currentRoomCode).emit('chat-message', message);
  });

  socket.on('video-load', (payload) => {
    if (!currentRoomCode) return;
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    const videoId = typeof payload?.videoId === 'string' ? payload.videoId : '';
    if (!YOUTUBE_ID_RE.test(videoId)) return;

    room.video = { url: videoId, isPlaying: false, currentTime: 0 };
    socket.to(currentRoomCode).emit('video-load', { videoId, from: socket.id });
  });

  socket.on('video-sync', (payload) => {
    if (!currentRoomCode) return;
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    const type = payload?.type;
    const currentTime = Number(payload?.currentTime) || 0;
    if (!['play', 'pause', 'seek'].includes(type)) return;

    room.video.isPlaying = type === 'play';
    room.video.currentTime = currentTime;
    socket.to(currentRoomCode).emit('video-sync', { type, currentTime, from: socket.id });
  });

  // --- WebRTC signaling relay (camera/mic mesh call) ---
  // Targeted at a specific peer (not broadcast) so N-way mesh calls don't cross-wire.
  socket.on('webrtc-signal', (payload) => {
    if (!currentRoomCode) return;
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    const to = typeof payload?.to === 'string' ? payload.to : null;
    if (!to || !room.users.has(to)) return;

    io.to(to).emit('webrtc-signal', {
      from: socket.id,
      signal: payload?.signal,
    });
  });

  socket.on('leave-room', () => {
    leaveCurrentRoom();
  });

  socket.on('disconnect', () => {
    leaveCurrentRoom();
  });

  function leaveCurrentRoom() {
    if (!currentRoomCode) return;
    const room = rooms.get(currentRoomCode);
    if (room) {
      room.users.delete(socket.id);
      socket.to(currentRoomCode).emit('peer-left', { id: socket.id });
      if (room.users.size === 0) scheduleRoomCleanup(room);
    }
    socket.leave(currentRoomCode);
    currentRoomCode = null;
  }
});

httpServer.listen(PORT, () => {
  console.log(`Luvu ${PORT}-portda ishlamoqda: http://localhost:${PORT}`);
});
