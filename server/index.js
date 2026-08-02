/**
 * Stratego Online – Socket.io server
 * Authoritative game state per room. Works reliably across browsers and phones.
 */

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  // Helpful on mobile / flaky networks
  pingInterval: 10000,
  pingTimeout: 20000
});

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, '..', 'public');

app.use(express.static(PUBLIC));

// ========== GAME CONSTANTS ==========
const RANKS = {
  '1': { name: 'Marshal', short: '1', count: 1, movable: true },
  '2': { name: 'General', short: '2', count: 1, movable: true },
  '3': { name: 'Colonel', short: '3', count: 2, movable: true },
  '4': { name: 'Major',   short: '4', count: 3, movable: true },
  '5': { name: 'Captain', short: '5', count: 4, movable: true },
  '6': { name: 'Lt.',     short: '6', count: 4, movable: true },
  '7': { name: 'Sgt.',    short: '7', count: 4, movable: true },
  '8': { name: 'Miner',    short: '8', count: 5, movable: true },
  '9': { name: 'Scout',   short: '9', count: 8, movable: true },
  'S': { name: 'Spy',     short: 'S', count: 1, movable: true },
  'B': { name: 'Bomb',    short: 'B', count: 6, movable: false },
  'F': { name: 'Flag',    short: 'F', count: 1, movable: false }
};

const LAKES = new Set([
  '4,2', '4,3', '5,2', '5,3',
  '4,6', '4,7', '5,6', '5,7'
]);

function createRemaining() {
  const r = {};
  for (const [k, v] of Object.entries(RANKS)) r[k] = v.count;
  return r;
}

function emptyBoard() {
  return Array.from({ length: 10 }, () => Array(10).fill(null));
}

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function sanitizeBoard(board, viewerColor) {
  return board.map(row => row.map(cell => {
    if (!cell) return null;
    if (cell.color === viewerColor || cell.revealed) {
      return { rank: cell.rank, color: cell.color, revealed: !!cell.revealed };
    }
    return { rank: '?', color: cell.color, revealed: false };
  }));
}

function combat(attacker, defender) {
  const a = attacker.rank;
  const d = defender.rank;
  if (d === 'F') return 'attacker';
  if (d === 'B') return a === '8' ? 'attacker' : 'defender';
  if (a === 'S' && d === '1') return 'attacker';
  if (a === d) return 'both';
  const val = r => {
    if (r === 'S') return 10;
    if (r === 'B' || r === 'F') return 99;
    return parseInt(r, 10);
  };
  return val(a) < val(d) ? 'attacker' : 'defender';
}

function getValidMoves(board, r, c, piece) {
  const moves = [];
  const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  const isScout = piece.rank === '9';
  for (const [dr, dc] of dirs) {
    let nr = r + dr, nc = c + dc;
    let steps = 0;
    while (nr >= 0 && nr < 10 && nc >= 0 && nc < 10) {
      if (LAKES.has(`${nr},${nc}`)) break;
      const target = board[nr][nc];
      if (target) {
        if (target.color !== piece.color) moves.push({ r: nr, c: nc });
        break;
      }
      moves.push({ r: nr, c: nc });
      if (!isScout) break;
      nr += dr;
      nc += dc;
      steps++;
      if (steps > 9) break;
    }
  }
  return moves;
}

function hasMovable(board, color) {
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 10; c++) {
      const p = board[r][c];
      if (p && p.color === color && RANKS[p.rank] && RANKS[p.rank].movable) return true;
    }
  }
  return false;
}

// roomCode -> room state
const rooms = new Map();
// socketId -> { roomCode, color }
const socketMeta = new Map();

function createRoom(hostName, hostSocketId, keepRevealed) {
  let code;
  do { code = makeRoomCode(); } while (rooms.has(code));
  const room = {
    code,
    players: { red: hostSocketId, blue: null },
    names: { red: hostName || 'Host', blue: null },
    board: emptyBoard(),
    turn: 'red',
    phase: 'waiting', // waiting | placement | playing | ended
    ready: { red: false, blue: false },
    remaining: { red: createRemaining(), blue: createRemaining() },
    captured: { red: [], blue: [] },
    winner: null,
    reason: null,
    // true = ranks stay visible after combat (default)
    // false = hide again after the turn (only battle log remembers)
    keepRevealed: keepRevealed !== false
  };
  rooms.set(code, room);
  socketMeta.set(hostSocketId, { roomCode: code, color: 'red' });
  return room;
}

function clearRevealedFlags(board) {
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 10; c++) {
      if (board[r][c]) board[r][c].revealed = false;
    }
  }
}

function publicRoomState(room, viewerColor) {
  return {
    code: room.code,
    phase: room.phase,
    turn: room.turn,
    names: room.names,
    ready: room.ready,
    remaining: room.remaining[viewerColor],
    board: sanitizeBoard(room.board, viewerColor),
    captured: room.captured,
    myColor: viewerColor,
    winner: room.winner,
    reason: room.reason,
    keepRevealed: !!room.keepRevealed,
    playersConnected: {
      red: !!room.players.red,
      blue: !!room.players.blue
    }
  };
}

function emitToRoom(room, event, payloadFn) {
  for (const color of ['red', 'blue']) {
    const sid = room.players[color];
    if (!sid) continue;
    const sock = io.sockets.sockets.get(sid);
    if (sock) sock.emit(event, payloadFn(color));
  }
}

function broadcastState(room) {
  emitToRoom(room, 'game-state', (color) => publicRoomState(room, color));
}

// ========== SOCKET HANDLERS ==========
io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  socket.on('create-room', ({ name, keepRevealed }, cb) => {
    try {
      const room = createRoom(name || 'Host', socket.id, keepRevealed !== false);
      socket.join(room.code);
      const state = publicRoomState(room, 'red');
      if (typeof cb === 'function') cb({ ok: true, state });
      socket.emit('game-state', state);
    } catch (e) {
      console.error(e);
      if (typeof cb === 'function') cb({ ok: false, error: e.message });
    }
  });

  socket.on('join-room', ({ code, name }, cb) => {
    try {
      const roomCode = (code || '').toUpperCase().trim();
      const room = rooms.get(roomCode);
      if (!room) {
        if (typeof cb === 'function') cb({ ok: false, error: 'Room not found' });
        return;
      }
      if (room.players.blue) {
        if (typeof cb === 'function') cb({ ok: false, error: 'Room is full' });
        return;
      }
      if (room.phase !== 'waiting' && room.phase !== 'placement') {
        if (typeof cb === 'function') cb({ ok: false, error: 'Game already started' });
        return;
      }

      room.players.blue = socket.id;
      room.names.blue = name || 'Guest';
      room.phase = 'placement';
      socket.join(roomCode);
      socketMeta.set(socket.id, { roomCode, color: 'blue' });

      if (typeof cb === 'function') cb({ ok: true, state: publicRoomState(room, 'blue') });
      broadcastState(room);
      io.to(roomCode).emit('log', `${room.names.blue} joined. Both players can place pieces.`);
    } catch (e) {
      console.error(e);
      if (typeof cb === 'function') cb({ ok: false, error: e.message });
    }
  });

  socket.on('place-piece', ({ r, c, rank }, cb) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    const room = rooms.get(meta.roomCode);
    if (!room || room.phase !== 'placement') return;

    const color = meta.color;
    r = +r; c = +c;
    if (r < 0 || r > 9 || c < 0 || c > 9) return;
    if (LAKES.has(`${r},${c}`)) return;

    const myRows = color === 'red' ? [6, 7, 8, 9] : [0, 1, 2, 3];
    if (!myRows.includes(r)) {
      if (typeof cb === 'function') cb({ ok: false, error: 'Wrong side' });
      return;
    }

    // Pick up existing piece
    if (room.board[r][c]) {
      const existing = room.board[r][c];
      if (existing.color !== color) return;
      room.remaining[color][existing.rank]++;
      room.board[r][c] = null;
      if (typeof cb === 'function') cb({ ok: true });
      socket.emit('game-state', publicRoomState(room, color));
      return;
    }

    if (!rank || !room.remaining[color][rank] || room.remaining[color][rank] <= 0) {
      if (typeof cb === 'function') cb({ ok: false, error: 'No pieces of that rank left' });
      return;
    }

    room.board[r][c] = { rank, color, revealed: false };
    room.remaining[color][rank]--;
    if (typeof cb === 'function') cb({ ok: true });
    socket.emit('game-state', publicRoomState(room, color));
  });

  socket.on('random-place', (cb) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    const room = rooms.get(meta.roomCode);
    if (!room || room.phase !== 'placement') return;

    const color = meta.color;
    const rows = color === 'red' ? [6, 7, 8, 9] : [0, 1, 2, 3];
    const empty = [];
    for (const r of rows) {
      for (let c = 0; c < 10; c++) {
        if (!room.board[r][c] && !LAKES.has(`${r},${c}`)) empty.push({ r, c });
      }
    }
    for (let i = empty.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [empty[i], empty[j]] = [empty[j], empty[i]];
    }

    const toPlace = [];
    for (const [rank, count] of Object.entries(room.remaining[color])) {
      for (let i = 0; i < count; i++) toPlace.push(rank);
    }
    if (toPlace.length > empty.length) {
      if (typeof cb === 'function') cb({ ok: false, error: 'Not enough squares' });
      return;
    }

    let idx = 0;
    for (const rank of toPlace) {
      const sq = empty[idx++];
      room.board[sq.r][sq.c] = { rank, color, revealed: false };
      room.remaining[color][rank]--;
    }

    if (typeof cb === 'function') cb({ ok: true, placed: toPlace.length });
    socket.emit('game-state', publicRoomState(room, color));
  });

  socket.on('ready', (cb) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    const room = rooms.get(meta.roomCode);
    if (!room || room.phase !== 'placement') return;

    const color = meta.color;
    const left = Object.values(room.remaining[color]).reduce((a, b) => a + b, 0);
    if (left > 0) {
      if (typeof cb === 'function') cb({ ok: false, error: `${left} pieces still to place` });
      return;
    }

    room.ready[color] = true;
    io.to(room.code).emit('log', `${room.names[color]} is ready.`);

    if (room.ready.red && room.ready.blue) {
      room.phase = 'playing';
      room.turn = 'red';
      io.to(room.code).emit('log', 'Both ready. Red moves first.');
      broadcastState(room);
    } else {
      broadcastState(room);
    }
    if (typeof cb === 'function') cb({ ok: true });
  });

  socket.on('move', ({ fr, fc, tr, tc }, cb) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    const room = rooms.get(meta.roomCode);
    if (!room || room.phase !== 'playing') return;

    const color = meta.color;
    if (room.turn !== color) {
      if (typeof cb === 'function') cb({ ok: false, error: 'Not your turn' });
      return;
    }

    fr = +fr; fc = +fc; tr = +tr; tc = +tc;
    const piece = room.board[fr] && room.board[fr][fc];
    if (!piece || piece.color !== color) {
      if (typeof cb === 'function') cb({ ok: false, error: 'Invalid piece' });
      return;
    }
    if (!RANKS[piece.rank] || !RANKS[piece.rank].movable) {
      if (typeof cb === 'function') cb({ ok: false, error: 'Piece cannot move' });
      return;
    }

    const valid = getValidMoves(room.board, fr, fc, piece).some(m => m.r === tr && m.c === tc);
    if (!valid) {
      if (typeof cb === 'function') cb({ ok: false, error: 'Invalid move' });
      return;
    }

    const defender = room.board[tr][tc];
    let logMsg = '';

    if (!defender) {
      room.board[tr][tc] = piece;
      room.board[fr][fc] = null;
      logMsg = `${color === 'red' ? 'Red' : 'Blue'} moved ${RANKS[piece.rank].name}.`;
    } else {
      piece.revealed = true;
      defender.revealed = true;
      const outcome = combat(piece, defender);

      if (outcome === 'attacker') {
        room.board[tr][tc] = piece;
        room.board[fr][fc] = null;
        room.captured[color].push(defender.rank);
        logMsg = `${color === 'red' ? 'Red' : 'Blue'} ${RANKS[piece.rank].name} captures ${RANKS[defender.rank].name}!`;
        if (defender.rank === 'F') {
          room.phase = 'ended';
          room.winner = color;
          room.reason = 'Flag captured!';
          broadcastState(room);
          io.to(room.code).emit('log', logMsg);
          io.to(room.code).emit('game-over', { winner: color, reason: room.reason });
          if (typeof cb === 'function') cb({ ok: true });
          return;
        }
      } else if (outcome === 'defender') {
        room.board[fr][fc] = null;
        room.captured[defender.color].push(piece.rank);
        logMsg = `${defender.color === 'red' ? 'Red' : 'Blue'} ${RANKS[defender.rank].name} defends and captures ${RANKS[piece.rank].name}!`;
      } else {
        room.board[fr][fc] = null;
        room.board[tr][tc] = null;
        room.captured[color].push(defender.rank);
        room.captured[defender.color].push(piece.rank);
        logMsg = `Both ${RANKS[piece.rank].name} and ${RANKS[defender.rank].name} destroyed!`;
      }
    }

    room.turn = room.turn === 'red' ? 'blue' : 'red';

    // Option: hide revealed ranks again after the turn
    if (!room.keepRevealed) {
      clearRevealedFlags(room.board);
    }

    // Check no movable pieces
    if (!hasMovable(room.board, room.turn)) {
      room.phase = 'ended';
      room.winner = color;
      room.reason = 'Opponent has no movable pieces.';
      broadcastState(room);
      io.to(room.code).emit('log', logMsg);
      io.to(room.code).emit('game-over', { winner: color, reason: room.reason });
      if (typeof cb === 'function') cb({ ok: true });
      return;
    }

    broadcastState(room);
    io.to(room.code).emit('log', logMsg);
    if (typeof cb === 'function') cb({ ok: true });
  });

  socket.on('resign', () => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    const room = rooms.get(meta.roomCode);
    if (!room || room.phase === 'ended') return;

    const winner = meta.color === 'red' ? 'blue' : 'red';
    room.phase = 'ended';
    room.winner = winner;
    room.reason = `${room.names[meta.color]} resigned.`;
    broadcastState(room);
    io.to(room.code).emit('game-over', { winner, reason: room.reason });
    io.to(room.code).emit('log', room.reason);
  });

  socket.on('request-state', () => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    const room = rooms.get(meta.roomCode);
    if (!room) return;
    socket.emit('game-state', publicRoomState(room, meta.color));
  });

  socket.on('disconnect', () => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    const room = rooms.get(meta.roomCode);
    socketMeta.delete(socket.id);
    if (!room) return;

    const color = meta.color;
    room.players[color] = null;
    io.to(room.code).emit('log', `${room.names[color] || color} disconnected.`);

    if (room.phase === 'playing' || room.phase === 'placement') {
      // Don't auto-end; allow reconnect attempt by rejoining same code is complex.
      // For simplicity, mark disconnected and if both gone, clean up later.
    }

    if (!room.players.red && !room.players.blue) {
      rooms.delete(room.code);
      console.log('Room closed:', room.code);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Stratego server running on port ${PORT}`);
  console.log(`Open http://localhost:${PORT}`);
});
