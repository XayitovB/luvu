const path = require('path');
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { customAlphabet } = require('nanoid');

const PORT = process.env.PORT || 3000;
const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // no 0/O/1/I confusion
const makeRoomCode = customAlphabet(ROOM_CODE_ALPHABET, 6);

const MAX_USERS_PER_ROOM = 2;
const MAX_NAME_LENGTH = 24;
const MAX_MESSAGE_LENGTH = 500;

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: false },
});

app.use(express.static(path.join(__dirname, 'public')));

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
  };
  rooms.set(code, room);
  return room;
}

function roomPeopleList(room) {
  return Array.from(room.users.entries()).map(([id, u]) => ({ id, name: u.name }));
}

function cleanupRoomIfEmpty(room) {
  if (room.users.size === 0) {
    rooms.delete(room.code);
  }
}

io.on('connection', (socket) => {
  let currentRoomCode = null;

  socket.on('create-room', (payload, ack) => {
    if (typeof ack !== 'function') return;
    const name = sanitizeName(payload && payload.name);
    const room = createRoom();
    room.users.set(socket.id, { name });
    socket.join(room.code);
    currentRoomCode = room.code;
    socket.data.name = name;

    ack({ ok: true, code: room.code, people: roomPeopleList(room) });
  });

  socket.on('join-room', (payload, ack) => {
    if (typeof ack !== 'function') return;
    const code = typeof payload?.code === 'string' ? payload.code.trim().toUpperCase() : '';
    const name = sanitizeName(payload && payload.name);
    const room = rooms.get(code);

    if (!room) {
      ack({ ok: false, error: 'Bunday xona topilmadi.' });
      return;
    }
    if (room.users.size >= MAX_USERS_PER_ROOM) {
      ack({ ok: false, error: 'Xona allaqachon to‘lgan (faqat 2 kishi).' });
      return;
    }

    room.users.set(socket.id, { name });
    socket.join(room.code);
    currentRoomCode = room.code;
    socket.data.name = name;

    ack({ ok: true, code: room.code, people: roomPeopleList(room), video: room.video });
    socket.to(room.code).emit('peer-joined', { id: socket.id, name });
  });

  socket.on('chat-message', (payload) => {
    if (!currentRoomCode) return;
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    const text = typeof payload?.text === 'string' ? payload.text.slice(0, MAX_MESSAGE_LENGTH).trim() : '';
    if (!text) return;

    const name = room.users.get(socket.id)?.name || 'Mehmon';
    io.to(currentRoomCode).emit('chat-message', {
      id: socket.id,
      name,
      text,
      ts: Date.now(),
    });
  });

  socket.on('video-load', (payload) => {
    if (!currentRoomCode) return;
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    const videoId = typeof payload?.videoId === 'string' ? payload.videoId.slice(0, 32) : '';
    if (!videoId) return;

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

  // --- WebRTC signaling relay (camera/mic call) ---
  socket.on('webrtc-signal', (payload) => {
    if (!currentRoomCode) return;
    socket.to(currentRoomCode).emit('webrtc-signal', {
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
      cleanupRoomIfEmpty(room);
    }
    socket.leave(currentRoomCode);
    currentRoomCode = null;
  }
});

httpServer.listen(PORT, () => {
  console.log(`Luvu ${PORT}-portda ishlamoqda: http://localhost:${PORT}`);
});
