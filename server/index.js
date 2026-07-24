const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const { GameRoom } = require('./game/GameRoom');
const { ROLE_DEFS, BOARDS, listRolesForBoard } = require('./game/roles');
const { verifyAdmin, ADMIN_DISPLAY_NAME } = require('./admin');

/** adminToken -> expireAt */
const adminTokens = new Map();

function issueAdminToken() {
  const token = crypto.randomBytes(24).toString('hex');
  adminTokens.set(token, Date.now() + 12 * 60 * 60 * 1000);
  return token;
}

function consumeAdminToken(token) {
  if (!token || !adminTokens.has(token)) return false;
  if (Date.now() > adminTokens.get(token)) {
    adminTokens.delete(token);
    return false;
  }
  // 续期
  adminTokens.set(token, Date.now() + 12 * 60 * 60 * 1000);
  return true;
}

const app = express();
const server = http.createServer(app);

// Cloudflare Tunnel 下需同时支持 websocket + polling，并放宽心跳
const io = new Server(server, {
  cors: {
    origin: true,
    methods: ['GET', 'POST'],
    credentials: true,
  },
  transports: ['websocket', 'polling'],
  allowUpgrades: true,
  pingInterval: 20000,
  pingTimeout: 60000,
  connectTimeout: 30000,
  maxHttpBufferSize: 1e6,
});

app.use(express.static(path.join(__dirname, '../public')));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, rooms: rooms.size, siteOpen, time: Date.now() });
});

const rooms = new Map(); // code -> GameRoom
const MAX_ROOMS = 3;

/** 网站默认关闭，管理员登录后手动开放 */
let siteOpen = false;

function siteStatusPayload(socket) {
  return {
    siteOpen,
    isAdmin: !!(socket && socket.data.isAdmin),
    adminName: (socket && socket.data.adminName) || null,
  };
}

function broadcastSiteStatus() {
  for (const sock of io.sockets.sockets.values()) {
    sock.emit('site_status', siteStatusPayload(sock));
  }
  broadcastRoomList();
}

function getRoomList() {
  return [...rooms.values()]
    .map((r) => r.getSummary())
    .sort((a, b) => a.code.localeCompare(b.code));
}

function broadcastRoomList() {
  const list = getRoomList();
  for (const sock of io.sockets.sockets.values()) {
    sock.emit('room_list', {
      siteOpen,
      rooms: siteOpen || sock.data.isAdmin ? list : [],
      maxRooms: MAX_ROOMS,
    });
  }
}

function requireSiteOpen(socket, cb) {
  if (siteOpen || socket.data.isAdmin) return true;
  cb?.({ ok: false, error: '网站尚未开放，请等待管理员开启' });
  return false;
}

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  if (rooms.has(code)) return makeCode();
  return code;
}

function broadcastRoom(room) {
  for (const [pid, player] of room.players) {
    if (String(pid).startsWith('bot_')) continue;
    if (!player.connected) continue;
    const sock = io.sockets.sockets.get(pid);
    if (!sock) continue;
    const state = room.getPublicState(pid);
    state.isAdmin = !!sock.data.isAdmin;
    sock.emit('state', state);
  }
  broadcastRoomList();
}

function attachToRoom(socket, room, name) {
  socket.join(room.code);
  socket.data.roomCode = room.code;
  socket.data.playerName = name;
}

io.on('connection', (socket) => {
  console.log('[连接]', socket.id, 'via', socket.conn.transport.name);

  socket.emit('hello', {
    board: '风声谍影',
    siteOpen,
    maxRooms: MAX_ROOMS,
    boards: Object.values(BOARDS).map((b) => ({
      id: b.id,
      name: b.name,
      seats: b.seats,
      rulesNote: b.rulesNote,
      roles: listRolesForBoard(b.id).map((r) => ({
        id: r.id,
        name: r.name,
        camp: r.camp,
        count: r.count,
        description: r.description,
      })),
    })),
    roles: Object.values(ROLE_DEFS).map((r) => ({
      id: r.id,
      name: r.name,
      camp: r.camp,
      description: r.description,
    })),
  });
  socket.emit('site_status', siteStatusPayload(socket));
  socket.emit('room_list', {
    siteOpen,
    rooms: siteOpen || socket.data.isAdmin ? getRoomList() : [],
    maxRooms: MAX_ROOMS,
  });

  socket.on('admin_login', ({ username, password }, cb) => {
    if (!verifyAdmin(username, password)) {
      console.log('[管理员] 登录失败', socket.id);
      return cb?.({ ok: false, error: '账号或密码错误' });
    }
    const token = issueAdminToken();
    socket.data.isAdmin = true;
    socket.data.adminName = ADMIN_DISPLAY_NAME;
    socket.data.adminToken = token;
    console.log('[管理员] 登录成功', socket.id);
    cb?.({ ok: true, name: ADMIN_DISPLAY_NAME, token, siteOpen });
    socket.emit('site_status', siteStatusPayload(socket));
  });

  socket.on('admin_resume', ({ token }, cb) => {
    if (!consumeAdminToken(token)) {
      return cb?.({ ok: false, error: '管理员会话已失效，请重新登录' });
    }
    socket.data.isAdmin = true;
    socket.data.adminName = ADMIN_DISPLAY_NAME;
    socket.data.adminToken = token;
    cb?.({ ok: true, name: ADMIN_DISPLAY_NAME, siteOpen });
    socket.emit('site_status', siteStatusPayload(socket));
  });

  socket.on('admin_logout', (_, cb) => {
    if (socket.data.adminToken) adminTokens.delete(socket.data.adminToken);
    socket.data.isAdmin = false;
    socket.data.adminName = null;
    socket.data.adminToken = null;
    cb?.({ ok: true, siteOpen });
    socket.emit('site_status', siteStatusPayload(socket));
  });

  socket.on('admin_set_site', ({ open }, cb) => {
    try {
      if (!socket.data.isAdmin) {
        return cb?.({ ok: false, error: '需要管理员登录' });
      }
      const wantOpen = !!open;
      if (wantOpen) {
        siteOpen = true;
        // 先回包，避免广播阻塞导致前端超时
        cb?.({ ok: true, siteOpen: true });
        console.log('[网站] 已开放 by', socket.data.adminName);
        setImmediate(() => {
          try {
            broadcastSiteStatus();
          } catch (e) {
            console.error('[网站] 广播失败', e);
          }
        });
        return;
      }

      // 关闭：清空房间，踢出普通玩家
      siteOpen = false;
      cb?.({ ok: true, siteOpen: false });
      for (const room of rooms.values()) {
        try {
          room.clearTimer();
        } catch (_) {}
      }
      rooms.clear();
      for (const sock of io.sockets.sockets.values()) {
        if (!sock.data.isAdmin) {
          sock.data.roomCode = null;
          sock.data.playerName = null;
          sock.emit('site_locked', { reason: '管理员已关闭网站' });
        }
        sock.emit('site_status', siteStatusPayload(sock));
      }
      broadcastRoomList();
      console.log('[网站] 已关闭 by', socket.data.adminName);
    } catch (err) {
      console.error('[网站] admin_set_site 异常', err);
      cb?.({ ok: false, error: '服务器内部错误' });
    }
  });

  socket.on('admin_end_game', (_, cb) => {
    if (!socket.data.isAdmin) return cb?.({ ok: false, error: '需要管理员登录' });
    const room = rooms.get(socket.data.roomCode);
    if (!room) return cb?.({ ok: false, error: '请先进入房间（可观战加入）' });
    const res = room.adminForceEnd();
    cb?.(res);
    if (res.ok) broadcastRoom(room);
  });

  socket.on('create_room', ({ name, boardId }, cb) => {
    if (!requireSiteOpen(socket, cb)) return;
    if (socket.data.roomCode && rooms.has(socket.data.roomCode)) {
      return cb?.({ ok: false, error: '你已在房间内，请先退出房间' });
    }
    if (rooms.size >= MAX_ROOMS) {
      return cb?.({ ok: false, error: `最多同时存在 ${MAX_ROOMS} 个房间` });
    }
    const n = String(name || '').trim().slice(0, 12);
    if (!n) return cb?.({ ok: false, error: '请输入昵称' });
    const code = makeCode();
    const room = new GameRoom(code, socket.id);
    const boardRes = room.setBoard(boardId || 'fengsheng12');
    if (!boardRes.ok) return cb?.(boardRes);
    const res = room.addPlayer(socket.id, n);
    if (!res.ok) return cb?.(res);
    rooms.set(code, room);
    attachToRoom(socket, room, n);
    console.log('[建房]', code, n, room.boardId);
    cb?.({ ok: true, code, boardId: room.boardId });
    broadcastRoom(room);
    broadcastRoomList();
  });

  socket.on('set_board', ({ boardId }, cb) => {
    if (!requireSiteOpen(socket, cb)) return;
    const room = rooms.get(socket.data.roomCode);
    if (!room) return cb?.({ ok: false, error: '不在房间内' });
    if (room.hostId !== socket.id) return cb?.({ ok: false, error: '仅房主可切换板子' });
    const res = room.setBoard(boardId);
    cb?.(res);
    if (res.ok) {
      console.log('[换板]', room.code, res.boardId);
      broadcastRoom(room);
      broadcastRoomList();
    }
  });

  socket.on('join_room', ({ code, name, spectator, seat }, cb) => {
    if (!requireSiteOpen(socket, cb)) return;
    if (socket.data.roomCode && rooms.has(socket.data.roomCode) && socket.data.roomCode !== String(code || '').trim().toUpperCase()) {
      return cb?.({ ok: false, error: '你已在其他房间，请先退出' });
    }
    const roomCode = String(code || '')
      .trim()
      .toUpperCase();
    const n = String(name || '').trim().slice(0, 12);
    if (!n) return cb?.({ ok: false, error: '请输入昵称' });
    if (!roomCode) return cb?.({ ok: false, error: '请输入房间号' });
    const room = rooms.get(roomCode);
    if (!room) return cb?.({ ok: false, error: '房间不存在，请确认房主房间号，且双方打开同一外网链接' });
    const res = room.addPlayer(socket.id, n, {
      spectator: !!spectator,
      seat: seat != null ? Number(seat) : null,
    });
    if (!res.ok) return cb?.(res);
    attachToRoom(socket, room, n);
    console.log('[加入]', roomCode, n, res.reclaimed ? '(重连)' : res.spectator ? '(观战)' : '');
    cb?.({ ok: true, code: roomCode, reclaimed: !!res.reclaimed, spectator: !!res.spectator });
    broadcastRoom(room);
    broadcastRoomList();
  });

  socket.on('leave_room', (_, cb) => {
    const code = socket.data.roomCode;
    if (!code) return cb?.({ ok: false, error: '不在房间内' });
    const room = rooms.get(code);
    if (!room) {
      socket.data.roomCode = null;
      socket.data.playerName = null;
      return cb?.({ ok: true });
    }
    socket.leave(code);
    const res = room.leavePlayer(socket.id);
    socket.data.roomCode = null;
    socket.data.playerName = null;
    console.log('[退出房间]', code, res.name || socket.id);

    const humans = [...room.players.values()].filter((p) => !String(p.id).startsWith('bot_'));
    if (humans.length === 0) {
      room.clearTimer();
      rooms.delete(code);
      console.log('[删房]', code, '(无人)');
    } else {
      broadcastRoom(room);
    }
    broadcastRoomList();
    cb?.({ ok: true });
  });

  socket.on('list_rooms', (_, cb) => {
    cb?.({
      ok: true,
      siteOpen,
      rooms: siteOpen || socket.data.isAdmin ? getRoomList() : [],
      maxRooms: MAX_ROOMS,
    });
  });

  // 刷新/断线后用房间号+昵称自动归队
  socket.on('rejoin', ({ code, name }, cb) => {
    if (!requireSiteOpen(socket, cb)) return;
    const roomCode = String(code || '')
      .trim()
      .toUpperCase();
    const n = String(name || '').trim().slice(0, 12);
    const room = rooms.get(roomCode);
    if (!room) return cb?.({ ok: false, error: '房间已失效' });
    const res = room.addPlayer(socket.id, n);
    if (!res.ok) return cb?.(res);
    attachToRoom(socket, room, n);
    console.log('[重连]', roomCode, n);
    cb?.({ ok: true, code: roomCode, reclaimed: !!res.reclaimed });
    broadcastRoom(room);
  });

  socket.on('ready', ({ ready }, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return cb?.({ ok: false, error: '不在房间内' });
    room.setReady(socket.id, ready);
    cb?.({ ok: true });
    broadcastRoom(room);
  });

  socket.on('start_game', (_, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return cb?.({ ok: false, error: '不在房间内' });
    if (room.hostId !== socket.id) return cb?.({ ok: false, error: '仅房主可开局' });
    const res = room.startGame();
    cb?.(res);
    if (res.ok) broadcastRoom(room);
  });

  socket.on('back_to_lobby', (_, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return cb?.({ ok: false, error: '不在房间内' });
    const res = room.backToLobby(socket.id);
    cb?.(res);
    if (res.ok) broadcastRoom(room);
  });

  socket.on('change_seat', ({ seat }, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return cb?.({ ok: false, error: '不在房间内' });
    const res = room.changeSeat(socket.id, seat);
    cb?.(res);
    if (res.ok) broadcastRoom(room);
  });

  socket.on('become_spectator', (_, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return cb?.({ ok: false, error: '不在房间内' });
    const res = room.becomeSpectator(socket.id);
    cb?.(res);
    if (res.ok) broadcastRoom(room);
  });

  socket.on('self_destruct', (_, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return cb?.({ ok: false, error: '不在房间内' });
    const res = room.selfDestruct(socket.id);
    cb?.(res);
    broadcastRoom(room);
  });

  socket.on('night_action', (action, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return cb?.({ ok: false, error: '不在房间内' });
    const res = room.submitNightAction(socket.id, action);
    cb?.(res);
    broadcastRoom(room);
  });

  socket.on('vote', ({ targetSeat }, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return cb?.({ ok: false, error: '不在房间内' });
    const res = room.submitVote(socket.id, targetSeat);
    cb?.(res);
    broadcastRoom(room);
  });

  socket.on('end_speak', (_, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return cb?.({ ok: false, error: '不在房间内' });
    const res = room.endSpeakEarly(socket.id);
    cb?.(res);
    broadcastRoom(room);
  });

  socket.on('police_register', ({ want }, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return cb?.({ ok: false, error: '不在房间内' });
    const res = room.policeRegister(socket.id, !!want);
    cb?.(res);
    broadcastRoom(room);
  });

  socket.on('police_withdraw', ({ leave }, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return cb?.({ ok: false, error: '不在房间内' });
    const res = room.policeWithdraw(socket.id, !!leave);
    cb?.(res);
    broadcastRoom(room);
  });

  socket.on('police_vote', ({ targetSeat }, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return cb?.({ ok: false, error: '不在房间内' });
    const res = room.policeVote(socket.id, targetSeat == null ? null : Number(targetSeat));
    cb?.(res);
    broadcastRoom(room);
  });

  socket.on('police_choose_order', ({ mode }, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return cb?.({ ok: false, error: '不在房间内' });
    const res = room.policeChooseOrder(socket.id, mode);
    cb?.(res);
    broadcastRoom(room);
  });

  socket.on('skill_action', (action, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return cb?.({ ok: false, error: '不在房间内' });
    const res = room.submitSkill(socket.id, action);
    cb?.(res);
    broadcastRoom(room);
  });

  socket.on('chat', ({ text }, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return cb?.({ ok: false });
    const msg = room.addChat(socket.id, text);
    if (msg) {
      // 发给房间内所有在线真人
      for (const [pid, player] of room.players) {
        if (String(pid).startsWith('bot_') || !player.connected) continue;
        io.sockets.sockets.get(pid)?.emit('chat', msg);
      }
    }
    cb?.({ ok: true });
  });

  // WebRTC 语音信令转发
  socket.on('voice-peers', (_, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return cb?.({ ok: false, peers: [] });
    const peers = room.getVoicePeers(socket.id);
    cb?.({ ok: true, peers, policy: room.getVoicePolicy(socket.id) });
  });

  socket.on('voice-signal', ({ to, data }, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return cb?.({ ok: false });
    const target = io.sockets.sockets.get(to);
    if (!target) return cb?.({ ok: false, error: '对方不在线' });
    // 双方必须在同一房间
    if (target.data.roomCode !== room.code) return cb?.({ ok: false, error: '不在同一房间' });
    // 夜间石像鬼频道：禁止非石像鬼互传 / 禁止外泄
    const myPeers = new Set(room.getVoicePeers(socket.id).map((p) => p.id));
    if (!myPeers.has(to)) {
      return cb?.({ ok: false, error: '当前语音频道不可达' });
    }
    target.emit('voice-signal', {
      from: socket.id,
      data,
      seat: room.players.get(socket.id)?.seat,
      name: room.players.get(socket.id)?.name,
    });
    cb?.({ ok: true });
  });

  socket.on('voice-ready', (_, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return cb?.({ ok: false });
    socket.data.voiceReady = true;
    for (const [pid, player] of room.players) {
      if (pid === socket.id || String(pid).startsWith('bot_') || !player.connected) continue;
      io.sockets.sockets.get(pid)?.emit('voice-peer-joined', {
        id: socket.id,
        seat: room.players.get(socket.id)?.seat,
        name: room.players.get(socket.id)?.name,
      });
    }
    cb?.({ ok: true });
  });

  socket.on('voice-leave', (_, cb) => {
    socket.data.voiceReady = false;
    const room = rooms.get(socket.data.roomCode);
    if (room) {
      for (const [pid, player] of room.players) {
        if (pid === socket.id || String(pid).startsWith('bot_') || !player.connected) continue;
        io.sockets.sockets.get(pid)?.emit('voice-peer-left', { id: socket.id });
      }
    }
    cb?.({ ok: true });
  });

  socket.on('get_state', (_, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return cb?.({ ok: false });
    const state = room.getPublicState(socket.id);
    state.isAdmin = !!socket.data.isAdmin;
    cb?.({ ok: true, state });
  });

  socket.on('dev_fill_bots', (_, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return cb?.({ ok: false, error: '不在房间内' });
    if (room.hostId !== socket.id) return cb?.({ ok: false, error: '仅房主' });
    if (room.phase !== 'lobby' && room.phase !== 'ended') {
      return cb?.({ ok: false, error: '仅大厅可填充电脑' });
    }
    // 已有电脑全部设为准备（第二局回大厅后需要）
    for (const [pid, p] of room.players) {
      if (!String(pid).startsWith('bot_') || p.isSpectator) continue;
      room.setReady(pid, true);
    }
    let i = 1;
    while (room.seatedPlayers().length < room.maxPlayers) {
      const botId = `bot_${room.code}_${i}_${Date.now()}`;
      const res = room.addPlayer(botId, `电脑${i}`);
      if (!res.ok) break;
      room.setReady(botId, true);
      i += 1;
    }
    cb?.({ ok: true, count: room.seatedPlayers().length });
    broadcastRoom(room);
  });

  socket.on('dev_clear_bots', (_, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return cb?.({ ok: false, error: '不在房间内' });
    if (room.hostId !== socket.id) return cb?.({ ok: false, error: '仅房主' });
    if (room.phase !== 'lobby' && room.phase !== 'ended') {
      return cb?.({ ok: false, error: '仅大厅可清除电脑' });
    }
    let removed = 0;
    for (const pid of [...room.players.keys()]) {
      if (!String(pid).startsWith('bot_')) continue;
      room.leavePlayer(pid);
      removed += 1;
    }
    cb?.({ ok: true, removed });
    broadcastRoom(room);
  });

  socket.on('dev_remove_bot', ({ seat }, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return cb?.({ ok: false, error: '不在房间内' });
    if (room.hostId !== socket.id) return cb?.({ ok: false, error: '仅房主' });
    if (room.phase !== 'lobby' && room.phase !== 'ended') {
      return cb?.({ ok: false, error: '仅大厅可移除电脑' });
    }
    const seatNum = Number(seat);
    if (!seatNum) return cb?.({ ok: false, error: '座位无效' });
    const target = room.getBySeat(seatNum);
    if (!target) return cb?.({ ok: false, error: '该座位为空' });
    if (!String(target.id).startsWith('bot_')) {
      return cb?.({ ok: false, error: '只能移除电脑座位' });
    }
    room.leavePlayer(target.id);
    cb?.({ ok: true, seat: seatNum, name: target.name });
    broadcastRoom(room);
  });

  socket.on('disconnect', (reason) => {
    console.log('[断开]', socket.id, reason);
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    if (socket.data.voiceReady) {
      for (const [pid, player] of room.players) {
        if (pid === socket.id || String(pid).startsWith('bot_') || !player.connected) continue;
        io.sockets.sockets.get(pid)?.emit('voice-peer-left', { id: socket.id });
      }
    }
    socket.data.voiceReady = false;
    room.markDisconnected(socket.id);
    // 不再立刻删房：等人重连；空房延后清理
    broadcastRoom(room);
  });
});

// 大厅断线超时清理 + 空房清理
setInterval(() => {
  for (const [code, room] of [...rooms.entries()]) {
    const purged = room.purgeStaleLobby(120000);
    if (purged.length) {
      console.log('[清理离线]', code, purged.map((p) => p.name).join(','));
      broadcastRoom(room);
    }
    const humans = [...room.players.values()].filter((p) => !String(p.id).startsWith('bot_'));
    const anyConnected = humans.some((p) => p.connected);
    const allStale =
      humans.length === 0 ||
      humans.every((p) => !p.connected && p.disconnectedAt && Date.now() - p.disconnectedAt > 180000);
    if (allStale && !anyConnected) {
      room.clearTimer();
      rooms.delete(code);
      console.log('[删房]', code);
    }
  }
}, 15000);

// 定时广播状态（倒计时刷新）
setInterval(() => {
  for (const room of rooms.values()) {
    broadcastRoom(room);
  }
}, 3000);

// 机器人自动行动（简化 AI）
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.phase === 'night') {
      for (const [pid, p] of room.players) {
        if (!String(pid).startsWith('bot_')) continue;
        if (!p.alive || !room.needsNightAction(p)) continue;
        if (room.nightState.submitted.has(pid)) continue;
        autoNight(room, pid, p);
      }
    }
    if (room.phase === 'day_speak' || room.phase === 'last_words') {
      const seat = room.dayState?.currentSpeakerSeat;
      if (seat != null) {
        const speaker = room.getBySeat(seat);
        if (speaker && String(speaker.id).startsWith('bot_')) {
          room.endSpeakEarly(speaker.id);
          broadcastRoom(room);
        }
      }
    }
    // 上警：发言 / PK 发言
    if (room.phase === 'police_speech' || room.phase === 'police_pk_speech') {
      const seat = room.dayState?.currentSpeakerSeat;
      if (seat != null) {
        const speaker = room.getBySeat(seat);
        if (speaker && String(speaker.id).startsWith('bot_')) {
          room.endSpeakEarly(speaker.id);
          broadcastRoom(room);
        }
      }
    }
    // 上警报名
    if (room.phase === 'police_register') {
      for (const [pid, p] of room.players) {
        if (!String(pid).startsWith('bot_')) continue;
        if (!p.alive || p.flags.whiteCatPending) continue;
        if (room.police.registrations.has(pid)) continue;
        // 约 40% 上警，保证有人竞选可测
        room.policeRegister(pid, Math.random() < 0.4);
        broadcastRoom(room);
      }
    }
    // 退水
    if (room.phase === 'police_withdraw') {
      for (const [pid, p] of room.players) {
        if (!String(pid).startsWith('bot_')) continue;
        if (!room.police.candidates.includes(p.seat)) continue;
        if (room.police.withdrawn.has(pid)) continue;
        room.policeWithdraw(pid, Math.random() < 0.15);
        broadcastRoom(room);
      }
    }
    // 警长投票：首轮跳过竞选者；PK 轮仅跳过 PK 选手（其余含首轮落选者可投）
    if (room.phase === 'police_vote') {
      for (const [pid, p] of room.players) {
        if (!String(pid).startsWith('bot_')) continue;
        if (!room.police.canPoliceVote(p)) continue;
        if (room.police.voted.has(pid)) continue;
        const cands = [...room.police.candidates];
        const pick =
          cands.length && Math.random() > 0.1
            ? cands[Math.floor(Math.random() * cands.length)]
            : null;
        room.policeVote(pid, pick);
        broadcastRoom(room);
      }
    }
    // 警长选发言顺序
    if (room.phase === 'police_order') {
      const chiefId = room.policeChiefId;
      if (chiefId && String(chiefId).startsWith('bot_')) {
        const modes = ['clockwise', 'counterclockwise'];
        room.policeChooseOrder(chiefId, modes[Math.floor(Math.random() * modes.length)]);
        broadcastRoom(room);
      }
    }
    if (room.phase === 'day_vote') {
      for (const [pid, p] of room.players) {
        if (!String(pid).startsWith('bot_')) continue;
        if (!p.alive || p.flags.whiteCatPending) continue;
        if (room.dayState.voted.has(pid)) continue;
        const alive = [...room.players.values()].filter((x) => x.alive && x.id !== pid);
        const pick = alive[Math.floor(Math.random() * alive.length)];
        room.submitVote(pid, pick ? pick.seat : null);
        broadcastRoom(room);
      }
    }
    if (room.phase === 'skill') {
      for (const s of [...room.pendingSkills]) {
        if (!String(s.playerId).startsWith('bot_')) continue;
        if (s.type === 'police_transfer') {
          const alive = [...room.players.values()].filter(
            (x) => x.alive && x.id !== s.playerId && !x.flags.whiteCatPending
          );
          if (alive.length && Math.random() > 0.3) {
            const t = alive[Math.floor(Math.random() * alive.length)];
            room.submitSkill(s.playerId, { type: 'police_transfer', targetSeat: t.seat });
          } else {
            room.submitSkill(s.playerId, { type: 'police_abandon' });
          }
        } else {
          room.submitSkill(s.playerId, { type: 'skip' });
        }
        broadcastRoom(room);
      }
    }
  }
}, 1500);

function autoNight(room, pid, p) {
  const role = room.effectiveRole(p);
  const aliveOthers = [...room.players.values()].filter((x) => x.alive && x.id !== pid);
  const rand = () => aliveOthers[Math.floor(Math.random() * aliveOthers.length)];

  if (role === 'admirer' && room.night === 1) {
    const t = rand();
    if (t) room.submitNightAction(pid, { type: 'idol', targetSeat: t.seat });
    return;
  }
  if (role === 'dream_catcher') {
    const t = rand();
    if (t) room.submitNightAction(pid, { type: 'dream', targetSeat: t.seat });
    return;
  }
  if (role === 'awakened_gargoyle') {
    const killTarget = rand();
    if (killTarget) room.submitNightAction(pid, { type: 'wolf_kill', targetSeat: killTarget.seat });
    room.submitNightAction(pid, { type: 'done' });
    return;
  }
  if (role === 'witch') {
    room.submitNightAction(pid, { type: 'skip' });
    return;
  }
  if (role === 'seer' || role === 'mirror_maiden') {
    const t = rand();
    const type = role === 'seer' ? 'seer_check' : 'mirror_check';
    if (t) room.submitNightAction(pid, { type, targetSeat: t.seat });
    else room.submitNightAction(pid, { type: 'skip' });
    return;
  }
  if (role === 'awakened_hidden_wolf') {
    if (!p.flags.hiddenImitate) {
      const t = rand();
      if (t) room.submitNightAction(pid, { type: 'hidden_imitate', targetSeat: t.seat });
    }
    if (room.hiddenCanKill()) {
      const t = rand();
      if (t) room.submitNightAction(pid, { type: 'wolf_kill', targetSeat: t.seat });
    }
    if (p.flags.imitateDream) {
      const t = rand();
      if (t) room.submitNightAction(pid, { type: 'dream', targetSeat: t.seat });
    }
    if (p.flags.imitateAdmirer && p.flags.idol == null) {
      const t = rand();
      if (t) room.submitNightAction(pid, { type: 'idol', targetSeat: t.seat });
    }
    if (p.flags.imitateMirror) {
      const t = rand();
      if (t) room.submitNightAction(pid, { type: 'mirror_check', targetSeat: t.seat });
    }
    if (p.flags.imitateSeer) {
      const t = rand();
      if (t) room.submitNightAction(pid, { type: 'seer_check', targetSeat: t.seat });
    }
    room.submitNightAction(pid, { type: 'done' });
    return;
  }
  room.submitNightAction(pid, { type: 'skip' });
}

const PORT = process.env.PORT || 3080;
server.listen(PORT, () => {
  console.log(`风声谍影 狼人杀已启动: http://localhost:${PORT}`);
});
