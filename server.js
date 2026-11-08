'use strict';
/*
 * Mythological Treasure Hunt — authoritative multiplayer room server.
 * (c) Bridgett Fowler. All rights reserved.
 *
 * One Node process: HTTP serves this folder, WebSocket runs the game.
 * The server owns ALL game state; clients only send intentions.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const DATA = require('./questions');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = __dirname;

/* ---------------- static data ---------------- */
const CHARACTERS = ['Archaeologist', 'Professor', 'Researcher', 'Student', 'Treasure Hunter', 'Guide'];
const TREASURES = [
  'Book of Thoth', 'Ankh of Isis', 'Mask of Tutankhamun', 'Benben Stone', 'Eye of Horus',
  'Golden Fleece', "Pandora's Box", 'Thunderbolt of Zeus', 'Aegis Shield', 'Lyre of Orpheus',
  'Mjölnir', 'Gungnir', 'Draupnir', 'Holy Grail', 'Excalibur',
  "Monkey King's Staff", 'Dragon Pearl', 'Peaches of Immortality', 'Ring of Solomon', "Aladdin's Lamp",
  'Ark of the Covenant', 'El Dorado', 'Aztec Sun Stone', 'Rosetta Stone', 'Terracotta Warrior',
  'Antikythera Mechanism', "Philosopher's Stone", 'Emerald Tablet', 'Sapphire Tablets', 'Crystal Skull'
];
const GOLDEN = new Set([
  'Book of Thoth', 'Ark of the Covenant', 'Holy Grail', 'Excalibur', 'Mjölnir',
  'Golden Fleece', 'Ring of Solomon', "Philosopher's Stone", 'Emerald Tablet', "Monkey King's Staff"
]);
// Board: 71 spaces. 0 = Start, 70 = Finish, 1..69 cycle through the pattern.
const PATTERN = ['eye', 'medusa', 'snake', 'phoenix', 'chest'];
const BOARD = [];
for (let i = 0; i < 71; i++) {
  if (i === 0) BOARD.push('start');
  else if (i === 70) BOARD.push('finish');
  else BOARD.push(PATTERN[(i - 1) % PATTERN.length]);
}
const SPACE_LEVEL = { eye: 1, snake: 2, phoenix: 3 }; // medusa = player's choice
const COINS_BY_LEVEL = { 1: 1, 2: 2, 3: 3 };
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ'; // no I/L/O lookalikes

/* ---------------- helpers ---------------- */
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function newCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');
  } while (rooms.has(code));
  return code;
}
function pointsOf(p) { return p.coins + p.gems * 5 + p.treasures.length * 10; }
function goldenEquiv(p) { return p.keysGold + Math.floor(p.keysBlack / 3); }

/* ---------------- rooms ---------------- */
const rooms = new Map(); // code -> room

function newRoom(code, hostId, gatePrice) {
  return {
    code, hostId, gatePrice,
    phase: 'lobby', // lobby | playing | finished
    players: [], // seats in join order
    current: 0, // index into players = whose turn
    gateOpen: false,
    pending: null, // server-side pending action (includes answer index — never broadcast)
    decks: null, // {1:[],2:[],3:[], chest:[]}
    log: []
  };
}
function newPlayer(id, name) {
  return {
    id, name, character: null, connected: true,
    pos: 0, coins: 0, gems: 0, treasures: [],
    keysGold: 0, keysBlack: 0,
    stuck: false, missTurn: false, finished: false, finishOrder: 0
  };
}
function buildDecks() {
  const decks = {};
  for (const lv of [1, 2, 3]) decks[lv] = shuffle(DATA.questions[lv].map((_, i) => i));
  const chest = [];
  for (const name of TREASURES) chest.push({ kind: 'treasure', name, key: GOLDEN.has(name) ? 'gold' : 'black' });
  for (const t of DATA.traps) chest.push({ kind: 'trap', name: t.name, text: t.text, effect: t.effect });
  decks.chest = shuffle(chest);
  return decks;
}
function drawQuestion(room, level) {
  let deck = room.decks[level];
  if (!deck.length) deck = room.decks[level] = shuffle(DATA.questions[level].map((_, i) => i)); // reshuffle on exhaustion
  const idx = deck.pop();
  return DATA.questions[level][idx];
}
function drawChest(room) {
  if (!room.decks.chest.length) room.decks.chest = buildDecks().chest;
  return room.decks.chest.pop();
}
function roomLog(room, text) {
  room.log.push(text);
  if (room.log.length > 200) room.log.shift();
}

/* Public snapshot — NEVER includes the pending question's answer index. */
function publicState(room) {
  let pending = null;
  if (room.pending) {
    const p = room.pending;
    if (p.kind === 'question') {
      pending = { kind: 'question', forPlayer: p.forPlayer, level: p.level, spaceType: p.spaceType, q: p.q.q, choices: p.q.choices, stuckAttempt: !!p.stuckAttempt };
    } else if (p.kind === 'chest') {
      pending = { kind: 'chest', forPlayer: p.forPlayer, card: p.card };
    } else if (p.kind === 'gate') {
      pending = { kind: 'gate', forPlayer: p.forPlayer, price: room.gatePrice, equiv: goldenEquiv(room.players.find(x => x.id === p.forPlayer)) };
    } else if (p.kind === 'choose_level') {
      pending = { kind: 'choose_level', forPlayer: p.forPlayer, spaceType: 'medusa' };
    }
  }
  const standings = [...room.players]
    .map(p => ({ id: p.id, name: p.name, character: p.character, coins: p.coins, gems: p.gems, treasures: p.treasures, keysGold: p.keysGold, keysBlack: p.keysBlack, points: pointsOf(p), finished: p.finished, finishOrder: p.finishOrder }))
    .sort((a, b) => (b.points - a.points) || ((a.finishOrder || 99) - (b.finishOrder || 99)));
  return {
    code: room.code, phase: room.phase, gatePrice: room.gatePrice, gateOpen: room.gateOpen,
    board: BOARD, hostId: room.hostId,
    currentId: room.phase === 'playing' && room.players[room.current] ? room.players[room.current].id : null,
    players: room.players.map(p => ({
      id: p.id, name: p.name, character: p.character, connected: p.connected,
      pos: p.pos, coins: p.coins, gems: p.gems, treasures: p.treasures,
      keysGold: p.keysGold, keysBlack: p.keysBlack, points: pointsOf(p),
      stuck: p.stuck, missTurn: p.missTurn, finished: p.finished, finishOrder: p.finishOrder
    })),
    pending,
    lastRoll: room.lastRoll || null,
    lastMove: room.lastMove || null,
    lastResult: room.lastResult || null,
    chestLeft: room.decks ? room.decks.chest.length : 55,
    standings: room.phase === 'finished' ? standings : null,
    log: room.log.slice(-60)
  };
}

/* ---------------- HTTP ---------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };
const httpServer = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.join(PUBLIC_DIR, urlPath);
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('Not found'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

/* ---------------- WebSocket game ---------------- */
const wss = new WebSocketServer({ server: httpServer });
let nextPlayerId = 1;

function send(ws, obj) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); }
function broadcast(room) {
  const msg = JSON.stringify({ type: 'state', state: publicState(room) });
  for (const p of room.players) if (p.ws && p.ws.readyState === p.ws.OPEN) p.ws.send(msg);
}
function broadcastChat(room, from, text) {
  const msg = JSON.stringify({ type: 'chat', from, text, ts: Date.now() });
  for (const p of room.players) if (p.ws && p.ws.readyState === p.ws.OPEN) p.ws.send(msg);
}
function err(ws, message) { send(ws, { type: 'error', message }); }

function currentPlayer(room) { return room.players[room.current]; }

/* Advance to the next unfinished player exactly once. */
function passTurn(room) {
  if (room.players.every(p => p.finished)) return finishGame(room);
  let i = room.current;
  do { i = (i + 1) % room.players.length; } while (room.players[i].finished);
  room.current = i;
}
function finishGame(room) {
  room.phase = 'finished';
  room.pending = null;
  roomLog(room, 'The hunt is complete — every hunter has finished!');
  broadcast(room);
}

/* After a move lands: resolve the space. */
function resolveLanding(room, player) {
  const type = BOARD[player.pos];
  room.lastResult = null;
  if (type === 'eye' || type === 'snake' || type === 'phoenix') {
    return askQuestion(room, player, SPACE_LEVEL[type], type, false);
  }
  if (type === 'medusa') {
    room.pending = { kind: 'choose_level', forPlayer: player.id };
    roomLog(room, `${player.name} faces Medusa — they choose the question's difficulty.`);
    return broadcast(room);
  }
  if (type === 'chest') {
    const card = drawChest(room);
    if (card.kind === 'treasure') {
      player.treasures.push(card.name);
      if (card.key === 'gold') player.keysGold++; else player.keysBlack++;
      roomLog(room, `${player.name} found the ${card.name} (+10 pts, ${card.key === 'gold' ? 'golden' : 'black'} key).`);
    } else {
      if (card.effect === 'coin') { player.coins = Math.max(0, player.coins - 1); roomLog(room, `${player.name} hit ${card.name}: lose 1 coin.`); }
      if (card.effect === 'miss') { player.missTurn = true; roomLog(room, `${player.name} hit ${card.name}: miss the next turn.`); }
      if (card.effect === 'back') {
        const from = player.pos;
        player.pos = Math.max(0, player.pos - 3);
        room.lastMove = { playerId: player.id, path: stepsBetween(from, player.pos), roll: room.lastRoll ? room.lastRoll.value : null };
        roomLog(room, `${player.name} hit ${card.name}: back 3 spaces to ${player.pos}.`);
      }
    }
    room.pending = { kind: 'chest', forPlayer: player.id, card: { kind: card.kind, name: card.name, text: card.text || null, key: card.key || null } };
    return broadcast(room);
  }
  // start or any quiet space: turn just ends
  passTurn(room);
  broadcast(room);
}
function stepsBetween(from, to) {
  const path = [];
  if (to > from) for (let i = from + 1; i <= to; i++) path.push(i);
  else for (let i = from - 1; i >= to; i--) path.push(i);
  return path;
}
function askQuestion(room, player, level, spaceType, stuckAttempt) {
  const q = drawQuestion(room, level);
  room.pending = { kind: 'question', forPlayer: player.id, level, spaceType, q, stuckAttempt };
  roomLog(room, `${player.name} draws a level ${level} question (${spaceType}).`);
  broadcast(room);
}

/* Movement incl. gate/doorstep/exact-roll rules. Returns true if a pending action was set. */
function doMove(room, player, roll) {
  const from = player.pos;
  room.lastRoll = { playerId: player.id, value: roll };
  if (!room.gateOpen) {
    const target = from + roll;
    if (target >= 70) {
      // Steps onto the Finish while locked: stop at the doorstep (69) and face the gate.
      const steps = Math.max(0, 69 - from);
      player.pos = from + steps;
      room.lastMove = { playerId: player.id, path: stepsBetween(from, player.pos), roll };
      room.pending = { kind: 'gate', forPlayer: player.id };
      roomLog(room, `${player.name} reaches the locked gate at the Finish.`);
      broadcast(room);
      return true;
    }
    player.pos = target;
    room.lastMove = { playerId: player.id, path: stepsBetween(from, target), roll };
    return false;
  }
  // Gate open: exact roll required.
  const target = from + roll;
  if (target > 70) {
    room.lastMove = { playerId: player.id, path: [], roll };
    roomLog(room, `${player.name} rolled ${roll} — too far. The Finish needs an exact roll.`);
    return false; // no move; caller ends the turn
  }
  player.pos = target;
  room.lastMove = { playerId: player.id, path: stepsBetween(from, target), roll };
  if (target === 70) {
    player.finished = true;
    player.finishOrder = room.players.filter(p => p.finished).length;
    roomLog(room, `${player.name} steps through the gate and FINISHES (#${player.finishOrder})!`);
    return false;
  }
  return false;
}

const handlers = {
  create_room(ws, session, msg) {
    const name = String(msg.name || '').trim().slice(0, 24);
    if (!name) return err(ws, 'Tell us your name first.');
    const gatePrice = msg.gatePrice === 2 ? 2 : 1;
    const code = newCode();
    const room = newRoom(code, null, gatePrice);
    rooms.set(code, room);
    const player = newPlayer('p' + nextPlayerId++, name);
    room.hostId = player.id;
    room.players.push(player);
    attach(ws, session, room, player);
    roomLog(room, `${name} opened the room. Gate price: ${gatePrice} golden key${gatePrice > 1 ? 's' : ''}.`);
    send(ws, { type: 'room_joined', code, playerId: player.id, isHost: true });
    broadcast(room);
  },
  join_room(ws, session, msg) {
    const code = String(msg.code || '').trim().toUpperCase();
    const name = String(msg.name || '').trim().slice(0, 24);
    const room = rooms.get(code);
    if (!room) return err(ws, 'No room with that code.');
    if (!name) return err(ws, 'Tell us your name first.');
    // Reconnect: same name reclaims a disconnected seat.
    const away = room.players.find(p => p.name.toLowerCase() === name.toLowerCase() && !p.connected);
    if (away) {
      attach(ws, session, room, away);
      roomLog(room, `${name} reconnected.`);
      send(ws, { type: 'room_joined', code, playerId: away.id, isHost: room.hostId === away.id });
      return broadcast(room);
    }
    if (room.phase !== 'lobby') return err(ws, 'That hunt has already started.');
    if (room.players.length >= 6) return err(ws, 'That room is full (6 hunters).');
    if (room.players.some(p => p.name.toLowerCase() === name.toLowerCase())) return err(ws, 'That name is taken in this room.');
    const player = newPlayer('p' + nextPlayerId++, name);
    room.players.push(player);
    attach(ws, session, room, player);
    roomLog(room, `${name} joined the hunt.`);
    send(ws, { type: 'room_joined', code, playerId: player.id, isHost: false });
    broadcast(room);
  },
  pick_character(ws, session, msg) {
    const { room, player } = session;
    if (!room || room.phase !== 'lobby') return;
    if (!CHARACTERS.includes(msg.character)) return err(ws, 'Unknown hunter.');
    if (room.players.some(p => p !== player && p.character === msg.character)) return err(ws, 'That hunter is already taken.');
    player.character = msg.character;
    roomLog(room, `${player.name} will hunt as the ${msg.character}.`);
    broadcast(room);
  },
  start_game(ws, session) {
    const { room, player } = session;
    if (!room || room.hostId !== player.id) return err(ws, 'Only the host can start the hunt.');
    if (room.phase !== 'lobby') return;
    if (room.players.length < 2) return err(ws, 'You need at least 2 hunters to start.');
    if (room.players.some(p => !p.character)) return err(ws, 'Every hunter must pick a character first.');
    room.phase = 'playing';
    room.decks = buildDecks();
    room.current = 0;
    roomLog(room, 'The hunt begins!');
    broadcast(room);
  },
  roll(ws, session) {
    const { room, player } = session;
    if (!room || room.phase !== 'playing' || room.pending) return;
    if (currentPlayer(room) !== player) return err(ws, 'Not your turn.');
    if (player.finished) return err(ws, 'You have already finished.');
    // Miss-a-turn flag: the turn is spent, exactly one pass.
    if (player.missTurn) {
      player.missTurn = false;
      room.lastRoll = { playerId: player.id, value: null };
      roomLog(room, `${player.name} misses this turn (trap).`);
      passTurn(room);
      return broadcast(room);
    }
    // Stay rule: a stuck hunter must answer a fresh question from this space first.
    if (player.stuck) {
      const type = BOARD[player.pos];
      if (type === 'medusa') {
        room.pending = { kind: 'choose_level', forPlayer: player.id, stuckAttempt: true };
        roomLog(room, `${player.name} is still stuck before Medusa — choose a difficulty to try to break free.`);
        return broadcast(room);
      }
      return askQuestion(room, player, SPACE_LEVEL[type] || 1, type, true);
    }
    const roll = 1 + Math.floor(Math.random() * 8);
    const hadPending = doMove(room, player, roll);
    if (hadPending) return; // gate offer already broadcast
    if (player.finished) { passTurn(room); return broadcast(room); }
    if (room.gateOpen && room.lastMove && room.lastMove.path.length === 0) {
      passTurn(room); // overshoot with the gate open: no move, turn passes
      return broadcast(room);
    }
    resolveLanding(room, player);
  },
  choose_level(ws, session, msg) {
    const { room, player } = session;
    if (!room || !room.pending || room.pending.kind !== 'choose_level' || room.pending.forPlayer !== player.id) return err(ws, 'Nothing to choose right now.');
    const level = [1, 2, 3].includes(msg.level) ? msg.level : 1;
    askQuestion(room, player, level, 'medusa', !!room.pending.stuckAttempt);
  },
  answer(ws, session, msg) {
    const { room, player } = session;
    if (!room || !room.pending || room.pending.kind !== 'question') return;
    if (room.pending.forPlayer !== player.id) return err(ws, 'Not your question to answer.');
    const pend = room.pending;
    const correct = msg.choice === pend.q.answer;
    room.pending = null;
    room.lastResult = { playerId: player.id, correct, correctText: pend.q.choices[pend.q.answer], level: pend.level };
    if (correct) {
      player.coins += COINS_BY_LEVEL[pend.level];
      if (pend.spaceType === 'phoenix') { player.gems += 1; roomLog(room, `${player.name} answered correctly (+${COINS_BY_LEVEL[pend.level]} coins, +1 gem from the Phoenix!).`); }
      else roomLog(room, `${player.name} answered correctly (+${COINS_BY_LEVEL[pend.level]} coins).`);
      if (pend.stuckAttempt) {
        player.stuck = false;
        roomLog(room, `${player.name} breaks free and may roll now.`);
        return broadcast(room); // same turn continues — they still get their roll
      }
      passTurn(room);
      return broadcast(room);
    }
    // Wrong.
    if (pend.stuckAttempt) {
      roomLog(room, `${player.name} answers wrong and stays stuck.`);
    } else {
      player.stuck = true;
      roomLog(room, `${player.name} answers wrong — stuck on this space until they answer correctly.`);
    }
    passTurn(room);
    broadcast(room);
  },
  continue(ws, session) { // acknowledge a chest card
    const { room, player } = session;
    if (!room || !room.pending || room.pending.kind !== 'chest' || room.pending.forPlayer !== player.id) return;
    room.pending = null;
    passTurn(room);
    broadcast(room);
  },
  gate_pay(ws, session) {
    const { room, player } = session;
    if (!room || !room.pending || room.pending.kind !== 'gate' || room.pending.forPlayer !== player.id) return;
    if (goldenEquiv(player) < room.gatePrice) return err(ws, 'Not enough keys for the gate.');
    let remaining = room.gatePrice;
    const payGold = Math.min(player.keysGold, remaining);
    player.keysGold -= payGold; remaining -= payGold;
    player.keysBlack -= remaining * 3;
    room.gateOpen = true;
    room.pending = null;
    roomLog(room, `${player.name} pays the gate price — the keys are spent and the GATE OPENS for everyone!`);
    passTurn(room);
    broadcast(room);
  },
  gate_wait(ws, session) {
    const { room, player } = session;
    if (!room || !room.pending || room.pending.kind !== 'gate' || room.pending.forPlayer !== player.id) return;
    room.pending = null;
    roomLog(room, `${player.name} waits at the gate.`);
    passTurn(room);
    broadcast(room);
  },
  chat(ws, session, msg) {
    const { room, player } = session;
    if (!room) return;
    const text = String(msg.text || '').trim().slice(0, 300);
    if (!text) return;
    broadcastChat(room, player.name, text);
  },
  rematch(ws, session) {
    const { room, player } = session;
    if (!room || room.hostId !== player.id || room.phase !== 'finished') return;
    for (const p of room.players) {
      p.pos = 0; p.coins = 0; p.gems = 0; p.treasures = []; p.keysGold = 0; p.keysBlack = 0;
      p.stuck = false; p.missTurn = false; p.finished = false; p.finishOrder = 0;
    }
    room.phase = 'playing';
    room.gateOpen = false;
    room.decks = buildDecks();
    room.current = 0;
    room.pending = null; room.lastRoll = null; room.lastMove = null; room.lastResult = null;
    roomLog(room, 'Rematch — the hunt begins again!');
    broadcast(room);
  }
};

function attach(ws, session, room, player) {
  session.room = room;
  session.player = player;
  player.ws = ws;
  player.connected = true;
}

wss.on('connection', (ws) => {
  const session = { room: null, player: null };
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const fn = handlers[msg.type];
    if (fn) { try { fn(ws, session, msg); } catch (e) { console.error(e); err(ws, 'Something went wrong with that move.'); } }
  });
  ws.on('close', () => {
    const { room, player } = session;
    if (room && player) {
      player.connected = false;
      player.ws = null;
      roomLog(room, `${player.name} stepped away.`);
      if (room.players.every(p => !p.connected)) rooms.delete(room.code);
      else broadcast(room);
    }
  });
});

httpServer.listen(PORT, () => console.log(`Mythological Treasure Hunt server listening on port ${PORT}`));
