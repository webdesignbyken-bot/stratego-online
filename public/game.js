/**
 * Stratego Online v2.0 – Socket.io client
 * Classic ranking: 1=Marshal … 9=Scout, S=Spy
 */
(() => {
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
  const ORDER = ['1','2','3','4','5','6','7','8','9','S','B','F'];
  const LAKES = new Set(['4,2','4,3','5,2','5,3','4,6','4,7','5,6','5,7']);

  let mode = null; // local | online
  let nickname = '';
  let myColor = null;
  let socket = null;
  let game = null; // server state snapshot for online, full state for local
  let selectedTrayRank = null;
  let selectedSquare = null;

  // Local-only full state
  let localGame = null;

  // Session win tracking (persists across rematches until lobby)
  let sessionScores = { red: 0, blue: 0 };
  let lastScoredGameId = null; // avoid double-counting a win
  let rematchRequested = false;

  // Sound effects via Web Audio (no external files)
  let audioCtx = null;
  let soundEnabled = true;

  function ensureAudio() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  function tone(freq, duration, type, volume, when) {
    const ctx = ensureAudio();
    if (!ctx || !soundEnabled) return;
    const t0 = when != null ? when : ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type || 'square';
    osc.frequency.setValueAtTime(freq, t0);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(volume || 0.15, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }

  function playSfx(kind) {
    if (!soundEnabled) return;
    ensureAudio();
    if (!audioCtx) return;
    const t = audioCtx.currentTime;
    if (kind === 'move') {
      tone(180, 0.08, 'triangle', 0.12, t);
      tone(120, 0.1, 'triangle', 0.08, t + 0.06);
    } else if (kind === 'combat') {
      tone(800, 0.06, 'sawtooth', 0.12, t);
      tone(1200, 0.05, 'square', 0.1, t + 0.04);
      tone(600, 0.08, 'sawtooth', 0.08, t + 0.08);
    } else if (kind === 'bomb') {
      tone(80, 0.25, 'sawtooth', 0.2, t);
      tone(50, 0.35, 'triangle', 0.15, t + 0.05);
      tone(40, 0.4, 'sine', 0.12, t + 0.1);
    } else if (kind === 'win') {
      tone(523, 0.12, 'square', 0.12, t);
      tone(659, 0.12, 'square', 0.12, t + 0.12);
      tone(784, 0.2, 'square', 0.14, t + 0.24);
    } else if (kind === 'lose') {
      tone(300, 0.2, 'triangle', 0.12, t);
      tone(200, 0.3, 'triangle', 0.1, t + 0.15);
    }
  }

  const $ = id => document.getElementById(id);
  const lobby = $('lobby');
  const gameScreen = $('game');
  const boardEl = $('board');
  const trayEl = $('tray');
  const logEl = $('log');
  const messageBar = $('message-bar');

  function init() {
    const saved = localStorage.getItem('stratego-nick');
    if (saved) $('nickname').value = saved;

    $('btn-local').onclick = startLocal;
    $('btn-host').onclick = startHost;
    $('btn-create-room').onclick = createRoom;
    $('btn-join').onclick = () => {
      $('join-panel').classList.remove('hidden');
      $('host-panel').classList.add('hidden');
    };
    $('btn-connect').onclick = joinRoom;
    $('btn-copy-code').onclick = () => {
      const code = $('room-code').textContent;
      navigator.clipboard.writeText(code).then(() => {
        $('btn-copy-code').textContent = 'Copied!';
        setTimeout(() => $('btn-copy-code').textContent = 'Copy', 1500);
      }).catch(() => {});
    };
    $('btn-rules').onclick = () => $('rules-modal').classList.remove('hidden');
    $('close-rules').onclick = () => $('rules-modal').classList.add('hidden');
    $('btn-ready').onclick = onReady;
    $('btn-resign').onclick = resign;
    $('btn-menu').onclick = backToLobby;
    $('btn-play-again').onclick = playAgain;
    if ($('btn-to-lobby')) $('btn-to-lobby').onclick = backToLobby;
    $('btn-random').onclick = randomPlaceAll;
    $('join-code').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });

    updateScoreboard();
    // Unlock audio on first user gesture (browser requirement)
    document.body.addEventListener('click', () => ensureAudio(), { once: true });
    console.log('[Stratego] v2.2 – sounds, wider tray');
  }

  // ========== SOCKET ==========
  function connectSocket() {
    if (socket && socket.connected) return socket;
    socket = io({ transports: ['websocket', 'polling'], reconnection: true, reconnectionAttempts: 10 });
    socket.on('connect', () => {
      console.log('[Stratego] connected', socket.id);
      addLog('Connected to server.');
    });
    socket.on('disconnect', () => {
      setMessage('Disconnected from server. Trying to reconnect…');
      addLog('Disconnected from server.');
    });
    socket.on('connect_error', (err) => {
      console.error(err);
      setMessage('Cannot reach server: ' + (err.message || 'network error'));
      if ($('host-status')) $('host-status').textContent = 'Server error – is the Node app running?';
      if ($('join-status')) $('join-status').textContent = 'Server error – is the Node app running?';
    });
    socket.on('game-state', (state) => applyServerState(state));
    socket.on('log', (msg) => addLog(msg));
    socket.on('game-over', (data) => {
      if (data.scores) {
        sessionScores = { red: data.scores.red || 0, blue: data.scores.blue || 0 };
      }
      showWinner(data.winner, data.reason);
    });
    socket.on('rematch-status', ({ votes, names }) => {
      const red = votes && votes.red ? '✓' : '…';
      const blue = votes && votes.blue ? '✓' : '…';
      const nRed = (names && names.red) || 'Red';
      const nBlue = (names && names.blue) || 'Blue';
      if ($('rematch-status')) {
        $('rematch-status').textContent = `Rematch: ${nRed} ${red}  ·  ${nBlue} ${blue}`;
      }
    });
    socket.on('sfx', ({ type }) => playSfx(type));
    return socket;
  }

  function applyServerState(state) {
    const wasEnded = game && game.phase === 'ended';
    game = state;
    myColor = state.myColor;
    if (state.phase === 'placement' || state.phase === 'playing' || state.phase === 'ended') {
      showGame();
    }
    if (state.phase === 'waiting') {
      $('host-status').textContent = 'Status: Waiting for opponent…';
      $('room-code').textContent = state.code;
    }
    if (state.phase === 'placement' && state.playersConnected && state.playersConnected.blue) {
      if ($('host-status')) $('host-status').textContent = 'Opponent joined! Place your pieces.';
    }
    // New game / rematch started
    if (state.phase === 'placement' && wasEnded) {
      rematchRequested = false;
      selectedTrayRank = null;
      $('winner-overlay').classList.add('hidden');
      if ($('rematch-status')) $('rematch-status').textContent = '';
      logEl.innerHTML = '';
      addLog('New game – place your pieces.');
      // New game id so next win can score
      lastScoredGameId = null;
    }
    selectedSquare = null;
    buildBoard();
    buildTray();
    renderBoard();
    updateUI();
    updateCaptures();
    updatePlacementButtons();
    updateScoreboard();

    if (state.phase === 'playing') {
      const yours = state.turn === myColor;
      setMessage(yours ? 'Your turn! Select a piece to move.' : "Opponent's turn…");
    } else if (state.phase === 'placement') {
      const left = Object.values(state.remaining || {}).reduce((a, b) => a + b, 0);
      setMessage(left === 0 ? 'All placed! Click I\'m Ready.' : `${left} pieces left to place. Opponent places at the same time.`);
    } else if (state.phase === 'ended') {
      showWinner(state.winner, state.reason);
    }
  }

  // ========== LOCAL ==========
  function startLocal() {
    nickname = $('nickname').value.trim() || 'Player';
    localStorage.setItem('stratego-nick', nickname);
    mode = 'local';
    myColor = 'red';
    localGame = {
      board: Array.from({ length: 10 }, () => Array(10).fill(null)),
      turn: 'red',
      phase: 'placement',
      ready: { red: false, blue: false },
      remaining: { red: createRemaining(), blue: createRemaining() },
      captured: { red: [], blue: [] },
      names: { red: 'Red', blue: 'Blue' }
    };
    game = snapshotLocal();
    showGame();
    buildBoard();
    buildTray();
    renderBoard();
    updateUI();
    updatePlacementButtons();
    setMessage('Red: place your pieces (bottom 4 rows), then Ready.');
    addLog('Local Hotseat started.');
  }

  function createRemaining() {
    const r = {};
    for (const [k, v] of Object.entries(RANKS)) r[k] = v.count;
    return r;
  }

  function snapshotLocal() {
    return {
      phase: localGame.phase,
      turn: localGame.turn,
      board: localGame.board.map(row => row.map(c => c ? { ...c } : null)),
      remaining: { ...localGame.remaining[myColor] },
      captured: localGame.captured,
      myColor,
      names: localGame.names,
      ready: localGame.ready
    };
  }

  // ========== ONLINE ==========
  function startHost() {
    nickname = $('nickname').value.trim() || 'Host';
    localStorage.setItem('stratego-nick', nickname);
    mode = 'online';
    $('host-panel').classList.remove('hidden');
    $('join-panel').classList.add('hidden');
    $('host-status').textContent = 'Choose your option, then Create Room.';
    $('room-code').textContent = '—';
    connectSocket(); // connect early so Create is fast
  }

  function createRoom() {
    nickname = $('nickname').value.trim() || 'Host';
    localStorage.setItem('stratego-nick', nickname);
    mode = 'online';
    $('host-status').textContent = 'Creating room…';
    const keepRevealed = $('opt-keep-revealed') ? $('opt-keep-revealed').checked : true;
    const s = connectSocket();
    const doCreate = () => {
      s.emit('create-room', { name: nickname, keepRevealed }, (res) => {
        if (!res || !res.ok) {
          $('host-status').textContent = 'Failed: ' + (res && res.error || 'unknown');
          return;
        }
        $('room-code').textContent = res.state.code;
        $('host-status').textContent = 'Waiting for opponent to join…';
        applyServerState(res.state);
        addLog('Room created: ' + res.state.code +
          (keepRevealed ? ' (revealed pieces stay visible)' : ' (revealed pieces hide after each turn)'));
      });
    };
    if (s.connected) doCreate();
    else s.once('connect', doCreate);
  }

  function joinRoom() {
    const code = $('join-code').value.trim().toUpperCase();
    if (!code || code.length < 4) {
      $('join-status').textContent = 'Enter a valid room code';
      return;
    }
    nickname = $('nickname').value.trim() || 'Guest';
    localStorage.setItem('stratego-nick', nickname);
    mode = 'online';
    $('join-status').textContent = 'Connecting…';
    $('btn-connect').disabled = true;

    const s = connectSocket();
    const doJoin = () => {
      s.emit('join-room', { code, name: nickname }, (res) => {
        $('btn-connect').disabled = false;
        if (!res || !res.ok) {
          $('join-status').textContent = res && res.error || 'Join failed';
          return;
        }
        $('join-status').textContent = 'Joined!';
        applyServerState(res.state);
        addLog('Joined room ' + code +
          (res.state.keepRevealed === false
            ? ' (revealed pieces hide after each turn)'
            : ' (revealed pieces stay visible)'));
      });
    };
    if (s.connected) doJoin();
    else s.once('connect', doJoin);
  }

  // ========== BOARD UI ==========
  function isFlipped() {
    return mode === 'online' && myColor === 'blue';
  }
  function toDisplay(r, c) {
    if (!isFlipped()) return { r, c };
    return { r: 9 - r, c: 9 - c };
  }
  function toLogical(dr, dc) {
    if (!isFlipped()) return { r: dr, c: dc };
    return { r: 9 - dr, c: 9 - dc };
  }
  function getSquare(r, c) {
    const d = toDisplay(r, c);
    return boardEl.children[d.r * 10 + d.c];
  }

  function buildBoard() {
    boardEl.innerHTML = '';
    for (let dr = 0; dr < 10; dr++) {
      for (let dc = 0; dc < 10; dc++) {
        const { r, c } = toLogical(dr, dc);
        const sq = document.createElement('div');
        sq.className = 'square ' + ((dr + dc) % 2 === 0 ? 'light' : 'dark');
        sq.dataset.r = r;
        sq.dataset.c = c;
        if (LAKES.has(`${r},${c}`)) sq.classList.add('lake');
        else sq.addEventListener('click', () => onSquareClick(r, c));
        boardEl.appendChild(sq);
      }
    }
  }

  function buildTray() {
    if (!game || (game.phase !== 'placement' && mode === 'online')) {
      if (game && game.phase === 'playing') {
        trayEl.innerHTML = '<div style="color:var(--muted);font-size:0.85rem">Game in progress</div>';
      }
    }
    if (!game || game.phase !== 'placement') {
      if (game && game.phase === 'playing') {
        trayEl.innerHTML = '<div style="color:var(--muted);font-size:0.85rem">Game in progress</div>';
      }
      return;
    }
    trayEl.innerHTML = '<div style="font-size:0.8rem;color:var(--muted);margin-bottom:0.4rem">Your pieces</div>';
    const remaining = game.remaining || {};
    for (const rank of ORDER) {
      const info = RANKS[rank];
      const left = remaining[rank] || 0;
      const item = document.createElement('div');
      item.className = 'tray-item' + (left <= 0 ? ' disabled' : '');
      item.dataset.rank = rank;
      item.innerHTML = `
        <div class="piece-icon ${myColor}">${info.short}</div>
        <span class="tray-name">${info.name}</span>
        <span class="tray-count">×${left}</span>`;
      item.onclick = () => selectTray(rank);
      trayEl.appendChild(item);
    }
  }

  function selectTray(rank) {
    if (!game || game.phase !== 'placement') return;
    if ((game.remaining[rank] || 0) <= 0) return;
    selectedTrayRank = rank;
    selectedSquare = null;
    document.querySelectorAll('.tray-item').forEach(el => {
      el.classList.toggle('selected', el.dataset.rank === rank);
    });
    clearHighlights();
    const rows = myColor === 'red' ? [6,7,8,9] : [0,1,2,3];
    for (const r of rows) {
      for (let c = 0; c < 10; c++) {
        if (!game.board[r][c] && !LAKES.has(`${r},${c}`)) {
          getSquare(r, c).classList.add('placeable');
        }
      }
    }
    setMessage(`Selected ${RANKS[rank].name}. Click an empty square on your side.`);
  }

  function onSquareClick(r, c) {
    if (LAKES.has(`${r},${c}`)) return;
    if (!game) return;
    if (game.phase === 'placement') handlePlacementClick(r, c);
    else if (game.phase === 'playing') handlePlayClick(r, c);
  }

  function handlePlacementClick(r, c) {
    const isMySide = myColor === 'red' ? r >= 6 : r <= 3;
    if (!isMySide) {
      setMessage('You can only place on your own side.');
      return;
    }

    if (mode === 'online') {
      const rank = selectedTrayRank;
      // Server handles pickup if square occupied
      socket.emit('place-piece', { r, c, rank: game.board[r][c] ? null : rank }, (res) => {
        if (res && !res.ok) setMessage(res.error || 'Place failed');
      });
      return;
    }

    // Local
    if (localGame.board[r][c]) {
      const piece = localGame.board[r][c];
      if (piece.color !== myColor) return;
      localGame.remaining[myColor][piece.rank]++;
      localGame.board[r][c] = null;
      selectedTrayRank = piece.rank;
      game = snapshotLocal();
      buildTray();
      renderBoard();
      selectTray(piece.rank);
      updatePlacementButtons();
      return;
    }
    if (!selectedTrayRank) {
      setMessage('Select a piece from the tray first.');
      return;
    }
    if (localGame.remaining[myColor][selectedTrayRank] <= 0) return;
    localGame.board[r][c] = { rank: selectedTrayRank, color: myColor, revealed: false };
    localGame.remaining[myColor][selectedTrayRank]--;
    game = snapshotLocal();
    buildTray();
    renderBoard();
    clearHighlights();
    if (localGame.remaining[myColor][selectedTrayRank] <= 0) selectedTrayRank = null;
    else selectTray(selectedTrayRank);
    updatePlacementButtons();
  }

  function randomPlaceAll() {
    if (!game || game.phase !== 'placement') {
      setMessage('Random is only available during setup.');
      return;
    }
    if (mode === 'online') {
      socket.emit('random-place', (res) => {
        if (res && !res.ok) setMessage(res.error || 'Random failed');
        else addLog('Randomly placed remaining pieces.');
      });
      return;
    }
    // Local
    const rows = myColor === 'red' ? [6,7,8,9] : [0,1,2,3];
    const empty = [];
    for (const r of rows) {
      for (let c = 0; c < 10; c++) {
        if (!localGame.board[r][c] && !LAKES.has(`${r},${c}`)) empty.push({ r, c });
      }
    }
    for (let i = empty.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [empty[i], empty[j]] = [empty[j], empty[i]];
    }
    const toPlace = [];
    for (const rank of ORDER) {
      const count = localGame.remaining[myColor][rank] || 0;
      for (let i = 0; i < count; i++) toPlace.push(rank);
    }
    if (!toPlace.length) {
      setMessage('All pieces already placed.');
      return;
    }
    let idx = 0;
    for (const rank of toPlace) {
      const sq = empty[idx++];
      localGame.board[sq.r][sq.c] = { rank, color: myColor, revealed: false };
      localGame.remaining[myColor][rank]--;
    }
    game = snapshotLocal();
    selectedTrayRank = null;
    clearHighlights();
    buildTray();
    renderBoard();
    updatePlacementButtons();
    addLog(`Randomly placed ${toPlace.length} pieces.`);
    setMessage('Pieces placed randomly. Click I\'m Ready when finished.');
  }

  function updatePlacementButtons() {
    if (!game) return;
    const btnReady = $('btn-ready');
    const btnRandom = $('btn-random');
    if (game.phase !== 'placement') {
      if (btnReady) btnReady.classList.add('hidden');
      if (btnRandom) btnRandom.classList.add('hidden');
      return;
    }
    if (btnRandom) btnRandom.classList.remove('hidden');
    const left = Object.values(game.remaining || {}).reduce((a, b) => a + b, 0);
    if (btnReady) {
      if (left === 0) btnReady.classList.remove('hidden');
      else btnReady.classList.add('hidden');
    }
  }

  function onReady() {
    if (mode === 'online') {
      socket.emit('ready', (res) => {
        if (res && !res.ok) setMessage(res.error || 'Not ready');
        else setMessage('Waiting for opponent to be ready…');
      });
      return;
    }
    // Local sequential
    localGame.ready[myColor] = true;
    if (!localGame.ready.red || !localGame.ready.blue) {
      myColor = myColor === 'red' ? 'blue' : 'red';
      game = snapshotLocal();
      selectedTrayRank = null;
      buildTray();
      renderBoard();
      updateUI();
      updatePlacementButtons();
      setMessage(`${myColor.toUpperCase()}: place your pieces now.`);
      return;
    }
    localGame.phase = 'playing';
    localGame.turn = 'red';
    myColor = 'red'; // for local we allow both via turn
    game = snapshotLocal();
    buildTray();
    renderBoard();
    updateUI();
    updatePlacementButtons();
    setMessage("Red's turn");
    addLog('Both ready. Red moves first.');
  }

  // ========== PLAY ==========
  function handlePlayClick(r, c) {
    const activeColor = mode === 'local' ? (localGame ? localGame.turn : game.turn) : myColor;
    const turn = mode === 'local' ? localGame.turn : game.turn;
    if (turn !== activeColor && mode === 'online') {
      setMessage('Not your turn.');
      return;
    }
    if (mode === 'local' && turn !== activeColor) {
      // in local activeColor is turn, so always ok
    }

    const board = mode === 'local' ? localGame.board : game.board;
    const piece = board[r][c];

    if (selectedSquare) {
      const from = selectedSquare;
      if (from.r === r && from.c === c) {
        selectedSquare = null;
        clearHighlights();
        return;
      }
      attemptMove(from.r, from.c, r, c);
      return;
    }

    if (piece && piece.color === (mode === 'local' ? turn : myColor)) {
      const info = RANKS[piece.rank];
      if (!info || !info.movable) {
        setMessage('That piece cannot move.');
        return;
      }
      // For online, hidden opponent pieces have rank '?'
      if (piece.rank === '?') return;
      selectedSquare = { r, c };
      showValidMoves(r, c, piece, board);
      setMessage(`Selected ${info.name}. Click a highlighted square.`);
    }
  }

  function showValidMoves(r, c, piece, board) {
    clearHighlights();
    getSquare(r, c).classList.add('selected');
    const moves = getValidMoves(board, r, c, piece);
    for (const m of moves) {
      const sq = getSquare(m.r, m.c);
      if (board[m.r][m.c]) sq.classList.add('valid-attack');
      else sq.classList.add('valid-move');
    }
  }

  function getValidMoves(board, r, c, piece) {
    const moves = [];
    const dirs = [[-1,0],[1,0],[0,-1],[0,1]];
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
        nr += dr; nc += dc; steps++;
        if (steps > 9) break;
      }
    }
    return moves;
  }

  function attemptMove(fr, fc, tr, tc) {
    if (mode === 'online') {
      selectedSquare = null;
      clearHighlights();
      setMessage('Sending move…');
      socket.emit('move', { fr, fc, tr, tc }, (res) => {
        if (res && !res.ok) setMessage(res.error || 'Move failed');
      });
      return;
    }
    // Local resolve
    const board = localGame.board;
    const piece = board[fr][fc];
    if (!piece) return;
    const valid = getValidMoves(board, fr, fc, piece).some(m => m.r === tr && m.c === tc);
    if (!valid) { setMessage('Invalid move.'); return; }

    const defender = board[tr][tc];
    if (!defender) {
      board[tr][tc] = piece;
      board[fr][fc] = null;
      addLog(`${piece.color} moved ${RANKS[piece.rank].name}.`);
      playSfx('move');
    } else {
      piece.revealed = true;
      defender.revealed = true;
      const outcome = combat(piece, defender);
      playSfx(defender.rank === 'B' ? 'bomb' : 'combat');
      if (outcome === 'attacker') {
        board[tr][tc] = piece;
        board[fr][fc] = null;
        localGame.captured[piece.color].push(defender.rank);
        addLog(`${piece.color} ${RANKS[piece.rank].name} captures ${RANKS[defender.rank].name}!`);
        if (defender.rank === 'F') {
          localGame.phase = 'ended';
          game = snapshotLocal();
          renderBoard();
          showWinner(piece.color, 'Flag captured!');
          return;
        }
      } else if (outcome === 'defender') {
        board[fr][fc] = null;
        localGame.captured[defender.color].push(piece.rank);
        addLog(`${defender.color} defends with ${RANKS[defender.rank].name}!`);
      } else {
        board[fr][fc] = null;
        board[tr][tc] = null;
        localGame.captured[piece.color].push(defender.rank);
        localGame.captured[defender.color].push(piece.rank);
        addLog('Both pieces destroyed!');
      }
    }
    localGame.turn = localGame.turn === 'red' ? 'blue' : 'red';
    selectedSquare = null;
    clearHighlights();
    game = snapshotLocal();
    renderBoard();
    updateUI();
    updateCaptures();
    setMessage(`${localGame.turn.toUpperCase()}'s turn`);
  }

  function combat(attacker, defender) {
    const a = attacker.rank, d = defender.rank;
    if (d === 'F') return 'attacker';
    if (d === 'B') return a === '8' ? 'attacker' : 'defender';
    if (a === 'S' && d === '1') return 'attacker';
    if (a === d) return 'both';
    const val = r => (r === 'S' ? 10 : (r === 'B' || r === 'F' ? 99 : parseInt(r, 10)));
    return val(a) < val(d) ? 'attacker' : 'defender';
  }

  function resign() {
    if (!confirm('Resign the game?')) return;
    if (mode === 'online' && socket) {
      socket.emit('resign');
      return;
    }
    if (localGame) {
      const winner = myColor === 'red' ? 'blue' : 'red';
      localGame.phase = 'ended';
      showWinner(winner, 'Resignation');
    }
  }

  function recordWin(winner) {
    // Prefer server scores for online (authoritative)
    if (mode === 'online' && game && game.scores) {
      sessionScores = { red: game.scores.red || 0, blue: game.scores.blue || 0 };
      updateScoreboard();
      return;
    }
    const gameId = 'local:' + (sessionScores.red + sessionScores.blue) + ':' + winner;
    if (lastScoredGameId === gameId) return;
    if (winner === 'red' || winner === 'blue') {
      sessionScores[winner]++;
      lastScoredGameId = gameId;
      updateScoreboard();
    }
  }

  function updateScoreboard() {
    const el = $('scoreboard');
    if (!el) return;
    // Online: prefer server scores if present
    if (mode === 'online' && game && game.scores) {
      sessionScores = { red: game.scores.red || 0, blue: game.scores.blue || 0 };
    }
    if (mode === 'online' && game && game.names) {
      const nR = game.names.red || 'Red';
      const nB = game.names.blue || 'Blue';
      el.textContent = `${nR} ${sessionScores.red} – ${sessionScores.blue} ${nB}`;
    } else {
      el.textContent = `Red ${sessionScores.red} – ${sessionScores.blue} Blue`;
    }
  }

  function showWinner(winner, reason) {
    recordWin(winner);
    if (mode === 'local') playSfx('win');
    else playSfx(winner === myColor ? 'win' : 'lose');
    const text = mode === 'local'
      ? (winner === 'red' ? '🔴 Red Wins!' : '🔵 Blue Wins!')
      : (winner === myColor ? '🎉 You Win!' : 'Defeat');
    $('winner-text').textContent = `${text}${reason ? ' – ' + reason : ''}`;
    if ($('winner-score')) {
      if (mode === 'online' && game && game.names) {
        $('winner-score').textContent =
          `Score: ${game.names.red || 'Red'} ${sessionScores.red} – ${sessionScores.blue} ${game.names.blue || 'Blue'}`;
      } else {
        $('winner-score').textContent =
          `Score: Red ${sessionScores.red} – ${sessionScores.blue} Blue`;
      }
    }
    if ($('rematch-status')) {
      $('rematch-status').textContent = mode === 'online'
        ? 'Click Play Again when both want a rematch.'
        : '';
    }
    rematchRequested = false;
    $('winner-overlay').classList.remove('hidden');
    updateScoreboard();
  }

  function playAgain() {
    if (mode === 'local') {
      // Keep scores, restart local match
      myColor = 'red';
      localGame = {
        board: Array.from({ length: 10 }, () => Array(10).fill(null)),
        turn: 'red',
        phase: 'placement',
        ready: { red: false, blue: false },
        remaining: { red: createRemaining(), blue: createRemaining() },
        captured: { red: [], blue: [] },
        names: { red: 'Red', blue: 'Blue' }
      };
      game = snapshotLocal();
      selectedTrayRank = null;
      selectedSquare = null;
      lastScoredGameId = null;
      logEl.innerHTML = '';
      $('winner-overlay').classList.add('hidden');
      showGame();
      buildBoard();
      buildTray();
      renderBoard();
      updateUI();
      updateCaptures();
      updatePlacementButtons();
      updateScoreboard();
      setMessage('Red: place your pieces (bottom 4 rows), then Ready.');
      addLog('New local game. Score carries over.');
      return;
    }
    if (mode === 'online' && socket) {
      rematchRequested = true;
      socket.emit('request-rematch');
      if ($('rematch-status')) {
        $('rematch-status').textContent = 'Waiting for opponent to accept rematch…';
      }
      setMessage('Rematch requested – waiting for opponent…');
    }
  }

  // ========== RENDER ==========
  function renderBoard() {
    if (!game || !game.board) return;
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 10; c++) {
        const sq = getSquare(r, c);
        if (!sq) continue;
        const existing = sq.querySelector('.piece');
        if (existing) existing.remove();
        const cell = game.board[r][c];
        if (!cell) continue;
        const pieceEl = document.createElement('div');
        // Local hotseat: only the active player's ranks are visible (plus revealed pieces)
        const viewerColor = mode === 'local'
          ? (game.phase === 'placement' ? myColor : (localGame ? localGame.turn : game.turn))
          : myColor;
        const isMine = cell.color === viewerColor;
        const showRank = isMine || cell.revealed || game.phase === 'ended';
        if (showRank && cell.rank !== '?') {
          pieceEl.className = `piece ${cell.color}`;
          const info = RANKS[cell.rank] || { short: '?', name: '?' };
          pieceEl.innerHTML = `<span class="rank">${info.short}</span><span class="name">${info.name}</span>`;
        } else {
          pieceEl.className = `piece back ${cell.color}`;
          pieceEl.innerHTML = `<span class="rank">?</span>`;
        }
        sq.appendChild(pieceEl);
      }
    }
  }

  function clearHighlights() {
    boardEl.querySelectorAll('.square').forEach(sq => {
      sq.classList.remove('selected', 'valid-move', 'valid-attack', 'placeable');
    });
  }

  function updateCaptures() {
    if (!game || !game.captured) return;
    const myCap = $('my-captures');
    const oppCap = $('opp-captures');
    myCap.innerHTML = '';
    oppCap.innerHTML = '';
    const mine = game.captured[myColor] || [];
    const opp = game.captured[myColor === 'red' ? 'blue' : 'red'] || [];
    for (const rank of mine) {
      const d = document.createElement('div');
      d.className = 'cap-piece';
      d.style.background = myColor === 'red' ? 'var(--blue)' : 'var(--red)';
      d.textContent = RANKS[rank]?.short || rank;
      myCap.appendChild(d);
    }
    for (const rank of opp) {
      const d = document.createElement('div');
      d.className = 'cap-piece';
      d.style.background = myColor === 'red' ? 'var(--red)' : 'var(--blue)';
      d.textContent = RANKS[rank]?.short || rank;
      oppCap.appendChild(d);
    }
  }

  function updateUI() {
    if (!game) return;
    const sideNote = myColor === 'blue' ? ' (your side is bottom)' : '';
    $('player-label').textContent = mode === 'local'
      ? `Local – acting as ${(mode === 'local' && localGame ? localGame.turn : myColor || '').toUpperCase()}`
      : `You are ${(myColor || '').toUpperCase()} (${nickname})${sideNote}`;
    if (game.phase === 'placement') {
      $('turn-indicator').textContent = 'Placement phase';
    } else if (game.phase === 'ended') {
      $('turn-indicator').textContent = 'Game over';
    } else {
      const turnName = (game.turn || '?').toUpperCase();
      const yours = mode === 'local' ? true : game.turn === myColor;
      if (mode === 'local') {
        $('turn-indicator').textContent = `${turnName}'s turn`;
        $('player-label').textContent = `Local – ${turnName}'s turn`;
      } else {
        $('turn-indicator').textContent = yours ? `Your turn (${turnName})` : `Opponent's turn (${turnName})`;
      }
    }
  }

  function setMessage(msg) { messageBar.textContent = msg || ''; }
  function addLog(text) {
    const div = document.createElement('div');
    div.textContent = text;
    logEl.prepend(div);
  }
  function showGame() {
    lobby.classList.add('hidden');
    gameScreen.classList.remove('hidden');
    $('winner-overlay').classList.add('hidden');
  }
  function backToLobby() {
    if (socket) {
      socket.disconnect();
      socket = null;
    }
    game = null;
    localGame = null;
    mode = null;
    myColor = null;
    selectedSquare = null;
    selectedTrayRank = null;
    sessionScores = { red: 0, blue: 0 };
    lastScoredGameId = null;
    rematchRequested = false;
    $('winner-overlay').classList.add('hidden');
    if ($('rematch-status')) $('rematch-status').textContent = '';
    gameScreen.classList.add('hidden');
    lobby.classList.remove('hidden');
    $('host-panel').classList.add('hidden');
    $('join-panel').classList.add('hidden');
    $('room-code').textContent = '—';
    $('join-status').textContent = '';
    $('host-status').textContent = '';
    $('btn-connect').disabled = false;
    logEl.innerHTML = '';
    updateScoreboard();
  }

  init();
})();
