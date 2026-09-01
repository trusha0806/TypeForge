const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname)));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// In-memory rooms storage
// roomCode -> { code, hostSocketId, hostName, guestSocketId, guestName, state, raceText }
const rooms = new Map();

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return rooms.has(code) ? generateRoomCode() : code;
}

io.on('connection', (socket) => {
  console.log(`[Socket] Connected: ${socket.id}`);

  // Create room flow (Host)
  socket.on('create-room', ({ name }, callback) => {
    const code = generateRoomCode();
    const room = {
      code,
      hostSocketId: socket.id,
      hostName: name || 'Host',
      guestSocketId: null,
      guestName: null,
      state: 'lobby',
      raceText: ''
    };

    rooms.set(code, room);
    socket.join(`room:${code}`);
    socket.data.roomCode = code;
    socket.data.role = 'host';
    socket.data.name = name || 'Host';

    console.log(`[Room Created] Code: ${code} by ${name} (${socket.id})`);
    if (typeof callback === 'function') {
      callback({ success: true, code });
    }
  });

  // Join room flow (Guest)
  socket.on('join-room', ({ code, name }, callback) => {
    const cleanCode = (code || '').trim().toUpperCase();
    const room = rooms.get(cleanCode);

    if (!room) {
      if (typeof callback === 'function') {
        callback({ success: false, message: 'Room code not found. Check the code and try again.' });
      }
      return;
    }

    if (room.guestSocketId && io.sockets.sockets.has(room.guestSocketId)) {
      if (typeof callback === 'function') {
        callback({ success: false, message: 'Room is already full.' });
      }
      return;
    }

    // Connect guest to room
    room.guestSocketId = socket.id;
    room.guestName = name || 'Guest';
    socket.join(`room:${cleanCode}`);
    socket.data.roomCode = cleanCode;
    socket.data.role = 'guest';
    socket.data.name = name || 'Guest';

    console.log(`[Room Joined] Code: ${cleanCode} by ${name} (${socket.id})`);

    // Notify host that guest has joined
    io.to(room.hostSocketId).emit('peer-joined', {
      name: room.guestName,
      guestSocketId: socket.id
    });

    if (typeof callback === 'function') {
      callback({ success: true, hostName: room.hostName, code: cleanCode });
    }
  });

  // Start race flow (Host triggers)
  socket.on('start-race', ({ text }) => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (!room || room.hostSocketId !== socket.id) return;

    room.state = 'racing';
    room.raceText = text;

    console.log(`[Race Started] Room: ${roomCode}`);
    io.to(`room:${roomCode}`).emit('race-started', {
      text,
      hostName: room.hostName
    });
  });

  // Real-time progress update broadcasting
  socket.on('progress-update', (data) => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;
    socket.to(`room:${roomCode}`).emit('opponent-progress', {
      pct: data.pct,
      wpm: data.wpm,
      acc: data.acc,
      finished: data.finished,
      senderName: socket.data.name
    });
  });

  // Rematch request
  socket.on('rematch-race', () => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (!room || room.hostSocketId !== socket.id) return;

    room.state = 'lobby';
    io.to(`room:${roomCode}`).emit('race-rematch');
  });

  // Leave room manually
  socket.on('leave-room', () => {
    handleDisconnect(socket);
  });

  // Disconnect handler
  socket.on('disconnect', () => {
    console.log(`[Socket] Disconnected: ${socket.id}`);
    handleDisconnect(socket);
  });
});

function handleDisconnect(socket) {
  const roomCode = socket.data.roomCode;
  if (!roomCode) return;

  const room = rooms.get(roomCode);
  if (!room) return;

  // Notify remaining room participant
  socket.to(`room:${roomCode}`).emit('peer-left', {
    name: socket.data.name || 'Opponent'
  });

  if (socket.id === room.hostSocketId) {
    console.log(`[Host Left] Room ${roomCode} closing.`);
    rooms.delete(roomCode);
  } else if (socket.id === room.guestSocketId) {
    console.log(`[Guest Left] Room ${roomCode} guest removed.`);
    room.guestSocketId = null;
    room.guestName = null;
    room.state = 'lobby';
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`⚡ TypeForge Backend Server running on http://localhost:${PORT}`);
});
