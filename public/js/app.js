(() => {
  const socket = io({
    path: '/socket.io/',
    transports: ['websocket', 'polling'],
    upgrade: true,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 800,
    reconnectionDelayMax: 5000,
    timeout: 20000,
  });

  const voice = new VoiceChat(socket);
  const nightBgm = new NightBgm();
  const narrator = new GameNarrator();
  let narratorPrev = null;
  const narratorPref = localStorage.getItem('fs_narrator');
  if (narratorPref === '0') narrator.setEnabled(false);

  const els = {
    lobby: document.getElementById('view-lobby'),
    game: document.getElementById('view-game'),
    ended: document.getElementById('view-ended'),
    name: document.getElementById('input-name'),
    code: document.getElementById('input-code'),
    board: document.getElementById('input-board'),
    lobbyError: document.getElementById('lobby-error'),
    roleList: document.getElementById('role-list'),
    roomCode: document.getElementById('room-code-text'),
    roomCount: document.getElementById('room-count'),
    roomBoardLabel: document.getElementById('room-board-label'),
    boardSwitch: document.getElementById('board-switch'),
    roomBoardSelect: document.getElementById('room-board-select'),
    roomBoardNote: document.getElementById('room-board-note'),
    spectatorList: document.getElementById('spectator-list'),
    sideLobby: document.getElementById('side-lobby'),
    sideGame: document.getElementById('side-game'),
    lobbyControls: document.getElementById('lobby-controls'),
    btnReady: document.getElementById('btn-ready'),
    btnSpectate: document.getElementById('btn-spectate'),
    btnStart: document.getElementById('btn-start'),
    btnBots: document.getElementById('btn-bots'),
    btnClearBots: document.getElementById('btn-clear-bots'),
    btnCopy: document.getElementById('btn-copy'),
    phaseLabel: document.getElementById('phase-label'),
    dayLabel: document.getElementById('day-label'),
    timerText: document.getElementById('timer-text'),
    myRole: document.getElementById('my-role'),
    privateInfo: document.getElementById('private-info'),
    announce: document.getElementById('announce'),
    circle: document.getElementById('player-circle'),
    actionBar: document.getElementById('action-bar'),
    chatLog: document.getElementById('chat-log'),
    chatForm: document.getElementById('chat-form'),
    chatInput: document.getElementById('chat-input'),
    endTitle: document.getElementById('end-title'),
    endSub: document.getElementById('end-sub'),
    endRoles: document.getElementById('end-roles'),
    conn: document.getElementById('conn-status'),
    btnVoice: document.getElementById('btn-voice'),
    btnMic: document.getElementById('btn-mic'),
    voiceStatus: document.getElementById('voice-status'),
    bgmVolume: document.getElementById('bgm-volume'),
    bgmWrap: document.getElementById('bgm-wrap'),
    btnNextGame: document.getElementById('btn-next-game'),
    adminBadge: document.getElementById('admin-badge'),
    adminUser: document.getElementById('admin-user'),
    adminPass: document.getElementById('admin-pass'),
    adminLoginMsg: document.getElementById('admin-login-msg'),
    btnAdminLogin: document.getElementById('btn-admin-login'),
    btnAdminEndGame: document.getElementById('btn-admin-end-game'),
    siteLocked: document.getElementById('site-locked'),
    playerGate: document.getElementById('player-gate'),
    roleSheet: document.getElementById('role-sheet'),
    adminSiteControls: document.getElementById('admin-site-controls'),
    btnSiteOpen: document.getElementById('btn-site-open'),
    btnSiteClose: document.getElementById('btn-site-close'),
    roomList: document.getElementById('room-list'),
    roomListMeta: document.getElementById('room-list-meta'),
    btnLeaveGame: document.getElementById('btn-leave-game'),
    btnLeaveEnded: document.getElementById('btn-leave-ended'),
    btnHome: document.getElementById('btn-home'),
    btnNarrator: document.getElementById('btn-narrator'),
    moonIcon: document.getElementById('moon-icon'),
    moonPhase: document.getElementById('moon-phase'),
    moonRound: document.getElementById('moon-round'),
    tableMoon: document.getElementById('table-moon'),
    tablePopup: document.getElementById('table-popup'),
    popupEyebrow: document.getElementById('popup-eyebrow'),
    popupTitle: document.getElementById('popup-title'),
    popupBody: document.getElementById('popup-body'),
    btnDismissPopup: document.getElementById('btn-dismiss-popup'),
    speakerHud: document.getElementById('speaker-hud'),
    speakerSeatLabel: document.getElementById('speaker-seat-label'),
    speakerNameLabel: document.getElementById('speaker-name-label'),
  };

  let rolesMeta = {};
  let boardsMeta = [];
  let state = null;
  let selectedSeat = null;
  let lastLogLen = 0;
  let timerTick = null;
  let rejoining = false;
  let lastActionKey = '';
  let lastCircleKey = '';
  let voteSubmitting = false;
  let lastPopupKey = '';
  let popupDismissedKey = '';
  let isAdmin = sessionStorage.getItem('fs_admin') === '1';
  let siteOpen = false;
  let roomListData = [];
  let maxRooms = 3;

  const PHASE_LABEL = {
    lobby: '等待中',
    night: '夜晚',
    dawn: '天亮',
    day_speak: '发言',
    day_vote: '投票',
    skill: '技能',
    last_words: '遗言',
    ended: '已结束',
    police_register: '上警报名',
    police_speech: '上警发言',
    police_withdraw: '退水',
    police_vote: '警长投票',
    police_pk_speech: 'PK发言',
    police_result: '宣布警长',
    police_order: '警长选序',
  };

  const savedName = localStorage.getItem('fs_name') || '';
  if (savedName) els.name.value = savedName;

  const PHASE_TEXT = {
    lobby: '等待',
    night: '夜晚',
    dawn: '天亮',
    day_speak: '轮流发言',
    day_vote: '放逐投票',
    skill: '技能发动',
    last_words: '遗言',
    ended: '结束',
    police_register: '上警报名',
    police_speech: '上警发言',
    police_withdraw: '退水',
    police_vote: '警长投票',
    police_pk_speech: '平票PK发言',
    police_result: '宣布警长',
    police_order: '警长选序',
  };

  const POLICE_SPEECH_PHASES = new Set(['police_speech', 'police_pk_speech']);
  const SPEAK_PHASES = new Set(['day_speak', 'last_words', 'police_speech', 'police_pk_speech']);
  const POLICE_PHASES = new Set([
    'police_register',
    'police_speech',
    'police_withdraw',
    'police_vote',
    'police_pk_speech',
    'police_result',
    'police_order',
  ]);

  voice.onStatus = (text) => {
    if (els.voiceStatus) els.voiceStatus.textContent = text;
  };

  function syncVoiceButtons() {
    const on = voice.enabled;
    const mic = voice.micOn;
    const locked = !!state?.voicePolicy?.forceMute;
    if (els.btnVoice) els.btnVoice.textContent = on ? '关闭语音' : '开启语音';
    if (els.btnMic) {
      els.btnMic.disabled = !on || locked;
      els.btnMic.textContent = locked ? '麦克风：强制关' : mic ? '麦克风：开' : '麦克风：关';
      els.btnMic.classList.toggle('btn-secondary', mic && !locked);
      els.btnMic.classList.toggle('btn-ghost', !mic || locked);
    }
  }

  async function toggleVoice() {
    if (!voice.enabled) {
      const ok = await voice.enable();
      if (!ok) return;
    } else {
      await voice.disable();
    }
    syncVoiceButtons();
  }

  function toggleMicBtn() {
    if (!voice.enabled) return;
    voice.toggleMic();
    syncVoiceButtons();
  }

  if (els.btnVoice) els.btnVoice.addEventListener('click', toggleVoice);
  if (els.btnMic) els.btnMic.addEventListener('click', toggleMicBtn);

  function setConn(text, ok) {
    if (!els.conn) return;
    els.conn.textContent = text;
    els.conn.classList.toggle('ok', !!ok);
    els.conn.classList.remove('hidden-ok');
    if (ok) {
      clearTimeout(setConn._t);
      setConn._t = setTimeout(() => els.conn.classList.add('hidden-ok'), 1800);
    }
  }

  function show(view) {
    els.lobby.hidden = view !== 'lobby';
    els.game.hidden = view !== 'game';
    els.ended.hidden = view !== 'ended';
    syncSceneBg(view);
  }

  function syncSceneBg(view) {
    const body = document.body;
    body.classList.remove(
      'scene-lobby',
      'scene-room',
      'scene-night',
      'scene-dawn',
      'scene-day',
      'scene-ended'
    );
    if (view === 'lobby') body.classList.add('scene-lobby');
    else if (view === 'ended') body.classList.add('scene-ended');
    else if (view === 'game' && state) {
      if (state.phase === 'lobby') body.classList.add('scene-room');
      else if (state.phase === 'night') body.classList.add('scene-night');
      else if (state.phase === 'dawn') body.classList.add('scene-dawn');
      else body.classList.add('scene-day');
    } else {
      body.classList.add('scene-lobby');
    }
  }

  function setError(msg) {
    els.lobbyError.hidden = !msg;
    els.lobbyError.textContent = msg || '';
  }

  function saveSession(code, name) {
    sessionStorage.setItem('fs_room', code);
    sessionStorage.setItem('fs_name', name);
    localStorage.setItem('fs_name', name);
  }

  function clearSession() {
    sessionStorage.removeItem('fs_room');
  }

  function emit(event, data = {}) {
    return new Promise((resolve) => {
      if (!socket.connected) {
        resolve({ ok: false, error: '尚未连上服务器，请稍候再试' });
        return;
      }
      const timer = setTimeout(() => resolve({ ok: false, error: '服务器无响应，请刷新重试' }), 12000);
      socket.emit(event, data, (res) => {
        clearTimeout(timer);
        resolve(res || { ok: false });
      });
    });
  }

  function setAdminUI(on) {
    isAdmin = !!on;
    if (els.adminBadge) {
      els.adminBadge.hidden = !isAdmin;
      els.adminBadge.textContent = isAdmin
        ? siteOpen
          ? '管理员 · 网站已开放'
          : '管理员 · 网站未开放'
        : '管理员已登录';
    }
    if (els.btnAdminEndGame) {
      els.btnAdminEndGame.hidden = !isAdmin || !!(state && state.phase === 'lobby');
    }
    if (els.adminSiteControls) els.adminSiteControls.hidden = !isAdmin;
    applySiteGate();
  }

  function applySiteGate() {
    if (els.siteLocked) els.siteLocked.hidden = siteOpen;
    if (els.playerGate) els.playerGate.hidden = !siteOpen;
    if (els.roleSheet) els.roleSheet.hidden = !siteOpen;
    if (els.btnSiteOpen) els.btnSiteOpen.disabled = siteOpen;
    if (els.btnSiteClose) els.btnSiteClose.disabled = !siteOpen;
    // 未开放且非管理员：强制回大厅锁页
    if (!siteOpen && !isAdmin) {
      state = null;
      clearSession();
      show('lobby');
    }
  }

  async function tryAdminResume() {
    const token = sessionStorage.getItem('fs_admin_token');
    if (!token) {
      setAdminUI(false);
      return;
    }
    const res = await emit('admin_resume', { token });
    if (res.ok) {
      sessionStorage.setItem('fs_admin', '1');
      setAdminUI(true);
    } else {
      sessionStorage.removeItem('fs_admin');
      sessionStorage.removeItem('fs_admin_token');
      setAdminUI(false);
    }
  }

  async function tryRejoin() {
    if (!siteOpen && !isAdmin) return;
    const code = sessionStorage.getItem('fs_room');
    const name = sessionStorage.getItem('fs_name') || localStorage.getItem('fs_name');
    if (!code || !name || rejoining) return;
    rejoining = true;
    setConn('正在重连房间…', false);
    const res = await emit('rejoin', { code, name });
    rejoining = false;
    if (res.ok) {
      setConn('已回到房间', true);
      if (els.code) els.code.value = code;
      if (els.name) els.name.value = name;
      if (voice.enabled) voice.rebind();
    } else {
      clearSession();
      setConn('已连接（请重新进房）', true);
    }
  }

  socket.on('connect', async () => {
    setConn('已连接', true);
    await tryAdminResume();
    tryRejoin();
  });

  socket.on('disconnect', (reason) => {
    setConn('连接断开，重连中… (' + reason + ')', false);
  });

  socket.on('connect_error', (err) => {
    setConn('连接失败：' + (err.message || '网络异常'), false);
  });

  socket.on('hello', (data) => {
    if (typeof data.siteOpen === 'boolean') siteOpen = data.siteOpen;
    if (data.maxRooms) maxRooms = data.maxRooms;
    boardsMeta = data.boards || [];
    (data.roles || []).forEach((r) => {
      rolesMeta[r.id] = r;
    });
    renderRoleSheet(els.board?.value || 'fengsheng12');
    applySiteGate();
  });

  function renderRoleSheet(boardId) {
    if (!els.roleList) return;
    const board = boardsMeta.find((b) => b.id === boardId) || boardsMeta[0];
    if (!board) {
      els.roleList.innerHTML = (Object.values(rolesMeta) || [])
        .map(
          (r) => `<li>
          <strong>${r.name}</strong>
          <span class="camp-${r.camp}"> · ${r.camp === 'wolf' ? '狼人' : '好人'}</span>
          <p>${r.description}</p>
        </li>`
        )
        .join('');
      return;
    }
    els.roleList.innerHTML =
      `<li class="role-board-head"><strong>${escapeHtml(board.name)}</strong><p>${escapeHtml(board.rulesNote || '')}</p></li>` +
      (board.roles || [])
        .map(
          (r) => `<li>
          <strong>${r.name}</strong>
          <span class="camp-${r.camp}"> · ${r.camp === 'wolf' ? '狼人' : '好人'} ×${r.count}</span>
          <p>${r.description}</p>
        </li>`
        )
        .join('');
  }

  socket.on('room_list', (data) => {
    if (data.maxRooms) maxRooms = data.maxRooms;
    roomListData = data.rooms || [];
    renderRoomList();
  });

  socket.on('site_status', (data) => {
    siteOpen = !!data.siteOpen;
    if (data.isAdmin != null) isAdmin = !!data.isAdmin;
    setAdminUI(isAdmin);
  });

  socket.on('site_locked', (data) => {
    siteOpen = false;
    state = null;
    clearSession();
    nightBgm.stop();
    lastLogLen = 0;
    if (els.chatLog) els.chatLog.innerHTML = '';
    show('lobby');
    applySiteGate();
    alert(data?.reason || '网站已关闭');
  });

  socket.on('state', (s) => {
    if (!siteOpen && !isAdmin) return;
    state = s;
    if (s?.isAdmin != null) setAdminUI(s.isAdmin);
    if (s?.code && s?.me?.name) saveSession(s.code, s.me.name);
    nightBgm.sync(s.phase).catch(() => {});
    if (s.phase === 'lobby') {
      narrator.stop();
      narratorPrev = null;
    } else if (s.phase === 'ended') {
      narratorPrev = narrator.sync(s, narratorPrev);
    } else {
      // 旁白播报时略降 BGM，避免盖过口播
      if (narrator.enabled && narrator.speaking) nightBgm.setVolume(Math.min(nightBgm.volume, 0.08));
      narratorPrev = narrator.sync(s, narratorPrev);
    }
    render();
  });

  socket.on('chat', (msg) => {
    appendChat(msg);
  });

  // —— 圆桌点击：等待入座/移除电脑；对局选人 ——
  els.circle.addEventListener('click', async (e) => {
    const btn = e.target.closest('.player-token');
    if (!btn) return;
    const seat = Number(btn.dataset.seat);
    if (!seat) return;

    if (state?.phase === 'lobby') {
      if (btn.classList.contains('empty-seat')) {
        const res = await emit('change_seat', { seat });
        if (!res.ok) alert(res.error || '换座失败');
        return;
      }
      if (btn.classList.contains('bot-seat')) {
        if (!state?.me?.isHost) {
          alert('仅房主可移除电脑');
          return;
        }
        const name = btn.dataset.name || '电脑';
        if (!confirm(`移除 ${seat} 号「${name}」？`)) return;
        const res = await emit('dev_remove_bot', { seat });
        if (!res.ok) alert(res.error || '移除失败');
        return;
      }
      return;
    }

    if (btn.disabled || btn.classList.contains('dead')) return;
    selectedSeat = seat;
    els.circle.querySelectorAll('.player-token').forEach((el) => {
      el.classList.toggle('selected', Number(el.dataset.seat) === selectedSeat);
    });
    lastActionKey = '';
    renderActions(true);
  });

  els.actionBar.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn || btn.disabled) return;
    e.preventDefault();
    const action = btn.dataset.action;

    if (action === 'vote-confirm') {
      if (voteSubmitting) return;
      if (selectedSeat == null) {
        alert('请先点击上方头像选择要投的玩家');
        return;
      }
      voteSubmitting = true;
      btn.disabled = true;
      btn.textContent = '提交中…';
      const event = state?.phase === 'police_vote' ? 'police_vote' : 'vote';
      const res = await emit(event, { targetSeat: selectedSeat });
      voteSubmitting = false;
      if (!res.ok) {
        alert(res.error || '投票失败');
        lastActionKey = '';
        renderActions(true);
      }
      return;
    }
    if (action === 'vote-abstain') {
      if (voteSubmitting) return;
      voteSubmitting = true;
      const event = state?.phase === 'police_vote' ? 'police_vote' : 'vote';
      const res = await emit(event, { targetSeat: null });
      voteSubmitting = false;
      if (!res.ok) alert(res.error || '弃票失败');
      return;
    }
    if (action === 'end-speak') {
      const res = await emit('end_speak');
      if (!res.ok) alert(res.error || '无法结束发言');
      return;
    }
    if (action === 'police-register') {
      const want = btn.dataset.want === '1';
      const res = await emit('police_register', { want });
      if (!res.ok) alert(res.error || '报名失败');
      return;
    }
    if (action === 'police-withdraw') {
      const leave = btn.dataset.leave === '1';
      const res = await emit('police_withdraw', { leave });
      if (!res.ok) alert(res.error || '操作失败');
      return;
    }
    if (action === 'police-vote-confirm') {
      if (voteSubmitting) return;
      if (selectedSeat == null) {
        alert('请先点击上方头像选择要投的竞选者');
        return;
      }
      voteSubmitting = true;
      btn.disabled = true;
      const res = await emit('police_vote', { targetSeat: selectedSeat });
      voteSubmitting = false;
      if (!res.ok) {
        alert(res.error || '投票失败');
        lastActionKey = '';
        renderActions(true);
      }
      return;
    }
    if (action === 'police-order') {
      const mode = btn.dataset.mode;
      const res = await emit('police_choose_order', { mode });
      if (!res.ok) alert(res.error || '选序失败');
      return;
    }
    if (action === 'self-destruct') {
      if (!confirm('确认自爆？将亮出觉醒石像鬼身份并出局，随后进入夜晚。')) return;
      const res = await emit('self_destruct');
      if (!res.ok) alert(res.error || '自爆失败');
      return;
    }
    if (action === 'night') {
      const type = btn.dataset.type;
      const needTarget = btn.dataset.needTarget === '1';
      const payload = { type };
      if (needTarget) {
        if (selectedSeat == null) {
          alert('请先点击选择一名玩家');
          return;
        }
        payload.targetSeat = selectedSeat;
      }
      const res = await emit('night_action', payload);
      if (!res.ok) alert(res.error || '行动失败');
      else if (needTarget) selectedSeat = null;
      return;
    }
    if (action === 'skill') {
      const type = btn.dataset.type;
      const payload = { type };
      if (btn.dataset.needTarget === '1') {
        if (selectedSeat == null) {
          alert('请先选择目标');
          return;
        }
        payload.targetSeat = selectedSeat;
      }
      const res = await emit('skill_action', payload);
      if (!res.ok) alert(res.error || '技能失败');
    }
  });

  async function joinRoomByCode(code, spectator) {
    const name = els.name.value.trim();
    if (!name) return setError('请输入昵称');
    if (!code) return setError('请输入房间号');
    setError('');
    const res = await emit('join_room', { name, code, spectator: !!spectator });
    if (!res.ok) return setError(res.error || '加入失败');
    saveSession(res.code, name);
  }

  document.getElementById('btn-create').addEventListener('click', async () => {
    const name = els.name.value.trim();
    if (!name) return setError('请输入昵称');
    setError('');
    const boardId = els.board?.value || 'fengsheng12';
    const res = await emit('create_room', { name, boardId });
    if (!res.ok) return setError(res.error || '创建失败');
    saveSession(res.code, name);
  });

  if (els.board) {
    els.board.addEventListener('change', () => {
      renderRoleSheet(els.board.value);
    });
  }

  if (els.roomBoardSelect) {
    els.roomBoardSelect.addEventListener('change', async () => {
      const boardId = els.roomBoardSelect.value;
      const res = await emit('set_board', { boardId });
      if (!res.ok) {
        alert(res.error || '切换板子失败');
        if (state?.boardId) els.roomBoardSelect.value = state.boardId;
      }
    });
  }

  document.getElementById('btn-join').addEventListener('click', async () => {
    await joinRoomByCode(els.code.value.trim(), false);
  });

  document.getElementById('btn-join-spectate').addEventListener('click', async () => {
    await joinRoomByCode(els.code.value.trim(), true);
  });

  els.roomList.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-join-code]');
    if (!btn) return;
    const code = btn.dataset.joinCode;
    const spectator = btn.dataset.spectate === '1';
    els.code.value = code;
    await joinRoomByCode(code, spectator);
  });

  async function leaveRoom() {
    if (!confirm('确认退出当前房间？')) return;
    const res = await emit('leave_room');
    if (!res.ok) return alert(res.error || '退出失败');
    if (voice.enabled) await voice.disable();
    syncVoiceButtons();
    state = null;
    clearSession();
    nightBgm.stop();
    narrator.stop();
    narratorPrev = null;
    lastLogLen = 0;
    if (els.chatLog) els.chatLog.innerHTML = '';
    show('lobby');
    applySiteGate();
  }

  if (els.btnLeaveGame) els.btnLeaveGame.addEventListener('click', leaveRoom);
  if (els.btnLeaveEnded) els.btnLeaveEnded.addEventListener('click', leaveRoom);

  /** 顶部固定「首页」：退出房间后强制跳转/刷新到 index */
  async function goHomeHard() {
    els.btnHome.disabled = true;
    els.btnHome.textContent = '返回中…';
    try {
      if (socket.connected) {
        await Promise.race([
          emit('leave_room'),
          new Promise((r) => setTimeout(r, 1200)),
        ]);
      }
    } catch (_) {}
    try {
      if (voice.enabled) await voice.disable();
    } catch (_) {}
    try {
      nightBgm.stop();
    } catch (_) {}
    try {
      narrator.stop();
    } catch (_) {}
    clearSession();
    // 强制整页回到首页（最可靠）
    location.replace(location.origin + '/');
  }

  if (els.btnHome) {
    els.btnHome.addEventListener('click', () => {
      goHomeHard();
    });
  }

  if (els.btnCopy) {
    els.btnCopy.addEventListener('click', async () => {
      if (!state?.code) return;
      const text = state.code;
      try {
        await navigator.clipboard.writeText(text);
        alert('已复制房间号：' + text + '\n请让队友打开同一个外网链接加入。');
      } catch {
        prompt('复制房间号发给队友', text);
      }
    });
  }

  els.btnReady.addEventListener('click', async () => {
    if (state?.me?.isSpectator) {
      alert('观战中不能准备，请先点击空位入座');
      return;
    }
    const me = state?.players?.find((p) => p.seat === state?.me?.seat);
    await emit('ready', { ready: !me?.ready });
  });

  els.btnSpectate.addEventListener('click', async () => {
    const res = await emit('become_spectator');
    if (!res.ok) alert(res.error || '无法观战');
  });

  els.btnStart.addEventListener('click', async () => {
    const res = await emit('start_game');
    if (!res.ok) alert(res.error || '无法开局');
  });

  els.btnBots.addEventListener('click', async () => {
    const res = await emit('dev_fill_bots');
    if (!res.ok) alert(res.error || '填充失败');
  });

  if (els.btnClearBots) {
    els.btnClearBots.addEventListener('click', async () => {
      const res = await emit('dev_clear_bots');
      if (!res.ok) alert(res.error || '清除失败');
    });
  }

  if (els.btnDismissPopup) {
    els.btnDismissPopup.addEventListener('click', () => {
      popupDismissedKey = lastPopupKey || popupDismissedKey;
      if (els.tablePopup) els.tablePopup.hidden = true;
      if (state) renderTableCenter(els.dayLabel?.textContent || '');
    });
  }

  els.btnNextGame.addEventListener('click', async () => {
    const res = await emit('back_to_lobby');
    if (!res.ok) alert(res.error || '无法返回大厅');
  });

  document.getElementById('btn-reload').addEventListener('click', () => {
    clearSession();
    nightBgm.stop();
    location.reload();
  });

  if (els.bgmVolume) {
    els.bgmVolume.addEventListener('input', () => {
      nightBgm.setVolume(Number(els.bgmVolume.value) / 100);
    });
  }

  function refreshNarratorBtn() {
    if (!els.btnNarrator) return;
    els.btnNarrator.textContent = narrator.enabled ? '旁白：开' : '旁白：关';
    els.btnNarrator.classList.toggle('btn-secondary', narrator.enabled);
    els.btnNarrator.classList.toggle('btn-ghost', !narrator.enabled);
  }
  refreshNarratorBtn();

  if (els.btnNarrator) {
    els.btnNarrator.addEventListener('click', async () => {
      // 浏览器要求用户手势后才能出声：先解锁语音引擎
      narrator.setEnabled(!narrator.enabled);
      localStorage.setItem('fs_narrator', narrator.enabled ? '1' : '0');
      refreshNarratorBtn();
      if (narrator.enabled) {
        narrator.lastKey = '';
        narrator.say('旁白已开启。', 'narrator-on');
      }
    });
  }

  els.btnAdminLogin.addEventListener('click', async () => {
    const username = els.adminUser.value.trim();
    const password = els.adminPass.value;
    const res = await emit('admin_login', { username, password });
    const msg = els.adminLoginMsg;
    msg.hidden = false;
    if (!res.ok) {
      msg.textContent = res.error || '登录失败';
      msg.classList.add('err');
      setAdminUI(false);
      return;
    }
    msg.textContent = '管理员登录成功：' + res.name + (siteOpen ? '（网站已开放）' : '，请点击「开放网站」');
    msg.classList.remove('err');
    sessionStorage.setItem('fs_admin', '1');
    if (res.token) sessionStorage.setItem('fs_admin_token', res.token);
    els.adminPass.value = '';
    if (typeof res.siteOpen === 'boolean') siteOpen = res.siteOpen;
    setAdminUI(true);
  });

  function markSiteOpenUI() {
    siteOpen = true;
    setAdminUI(true);
    els.adminLoginMsg.hidden = false;
    els.adminLoginMsg.classList.remove('err');
    els.adminLoginMsg.textContent = '网站已开放，玩家可以进入了';
  }

  function markSiteCloseUI() {
    siteOpen = false;
    state = null;
    setAdminUI(true);
    show('lobby');
    els.adminLoginMsg.hidden = false;
    els.adminLoginMsg.classList.remove('err');
    els.adminLoginMsg.textContent = '网站已关闭';
  }

  els.btnSiteOpen.addEventListener('click', async () => {
    els.btnSiteOpen.disabled = true;
    const res = await emit('admin_set_site', { open: true });
    els.btnSiteOpen.disabled = false;
    // 即使 ack 超时，只要随后收到 site_status 也会更新；这里优先用回包
    if (res.ok) {
      markSiteOpenUI();
      return;
    }
    // 短等一下看广播是否已把站点打开
    await new Promise((r) => setTimeout(r, 400));
    if (siteOpen) {
      markSiteOpenUI();
      return;
    }
    alert(res.error || '开放失败，请确认已管理员登录并已重启服务器');
  });

  els.btnSiteClose.addEventListener('click', async () => {
    if (!confirm('关闭网站将清空所有房间并踢出玩家，确认？')) return;
    els.btnSiteClose.disabled = true;
    const res = await emit('admin_set_site', { open: false });
    els.btnSiteClose.disabled = false;
    if (res.ok || !siteOpen) {
      markSiteCloseUI();
      return;
    }
    alert(res.error || '关闭失败');
  });

  async function adminEndGame() {
    if (!isAdmin) return alert('请先管理员登录');
    if (!confirm('确认强制结束当前对局？')) return;
    const res = await emit('admin_end_game');
    if (!res.ok) alert(res.error || '结束失败');
  }

  els.btnAdminEndGame.addEventListener('click', adminEndGame);

  // 初始锁站
  applySiteGate();

  els.chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = els.chatInput.value.trim();
    if (!text) return;
    els.chatInput.value = '';
    await emit('chat', { text });
  });

  function renderRoomList() {
    if (!els.roomList) return;
    if (els.roomListMeta) {
      els.roomListMeta.textContent = `${roomListData.length}/${maxRooms}`;
    }
    if (!roomListData.length) {
      els.roomList.innerHTML = '<p class="room-list-empty">暂无房间，创建一个吧</p>';
      return;
    }
    els.roomList.innerHTML = roomListData
      .map((r) => {
        const phase = PHASE_LABEL[r.phase] || r.phase;
        const seatBtn = r.canJoinSeat
          ? `<button type="button" class="btn btn-secondary btn-sm" data-join-code="${r.code}" data-spectate="0">入座</button>`
          : '';
        return `<div class="room-list-item">
          <div>
            <div class="code">${escapeHtml(r.code)}</div>
            <div class="meta">${escapeHtml(r.board || '板子')} · ${phase} · 座位 ${r.seatedCount}/${r.maxPlayers} · 观战 ${r.spectatorCount} · 房主 ${escapeHtml(r.hostName)}</div>
          </div>
          <div class="actions">
            ${seatBtn}
            <button type="button" class="btn btn-ghost btn-sm" data-join-code="${r.code}" data-spectate="1">观战</button>
          </div>
        </div>`;
      })
      .join('');
  }

  function render() {
    if (!state) return;
    // 语音频道 / 强制闭麦
    if (voice.enabled || state.voicePolicy) {
      voice.applyPolicy(state.voicePolicy || { channel: 'all', canSpeak: true, forceMute: false });
    }
    if (els.btnMic) {
      const locked = !!state.voicePolicy?.forceMute;
      els.btnMic.disabled = !voice.enabled || locked;
      if (locked) {
        els.btnMic.textContent = '麦克风：强制关';
        els.btnMic.classList.add('btn-ghost');
        els.btnMic.classList.remove('btn-secondary');
      }
    }

    if (state.phase === 'ended') {
      show('ended');
      renderEnded();
      return;
    }

    // 等待与对局共用圆桌视图，开局不切换布局
    show('game');
    renderTable();
  }

  function renderTable() {
    const isLobby = state.phase === 'lobby';
    syncVoiceButtons();
    syncSceneBg('game');

    if (els.sideLobby) els.sideLobby.hidden = !isLobby;
    if (els.sideGame) els.sideGame.hidden = isLobby;
    if (els.lobbyControls) els.lobbyControls.hidden = !isLobby;
    if (els.actionBar) els.actionBar.hidden = isLobby;
    if (els.btnCopy) els.btnCopy.hidden = !isLobby;
    if (els.btnNarrator) els.btnNarrator.hidden = isLobby;
    if (els.bgmWrap) els.bgmWrap.hidden = isLobby;
    if (els.btnAdminEndGame) els.btnAdminEndGame.hidden = !isAdmin || isLobby;

    if (isLobby) {
      renderLobbyChrome();
      lastCircleKey = '';
      renderCircle();
      renderTableCenter('点击空位入座');
      if (els.announce) {
        els.announce.textContent = '等待开局：入座并准备。房主可填充电脑测试。';
      }
      return;
    }

    renderGameChrome();
  }

  function renderLobbyChrome() {
    const me = state.me;
    const seated = state.seatedCount ?? state.players.length;
    const maxP = state.maxPlayers || 12;

    els.phaseLabel.textContent = '等待中';
    els.dayLabel.textContent = `房间 ${state.code || '-----'} · ${seated}/${maxP}`;
    if (els.timerText) els.timerText.textContent = state.canStart ? '可开局' : '筹备中';

    if (els.roomCode) els.roomCode.textContent = state.code || '-----';
    if (els.roomCount) els.roomCount.textContent = `${seated}/${maxP}`;
    if (els.roomBoardLabel) els.roomBoardLabel.textContent = `板子：${state.board || '—'}`;

    const canSwitchBoard = !!me?.isHost;
    if (els.boardSwitch) els.boardSwitch.hidden = !canSwitchBoard;
    if (els.roomBoardSelect && state.boardId) els.roomBoardSelect.value = state.boardId;
    if (els.roomBoardNote) els.roomBoardNote.textContent = state.rulesNote || '';
    renderRoleSheet(state.boardId || 'fengsheng12');

    const specs = state.spectators || [];
    if (els.spectatorList) {
      els.spectatorList.textContent = specs.length
        ? '观战：' + specs.map((s) => s.name + (s.connected === false ? '(掉线)' : '')).join('、')
        : '暂无观战者';
    }

    if (me?.isSpectator) {
      els.btnReady.textContent = '请先入座';
      els.btnReady.disabled = true;
      els.btnSpectate.disabled = true;
    } else {
      els.btnReady.disabled = false;
      els.btnSpectate.disabled = false;
      els.btnReady.textContent = state.players.find((p) => p.seat === me?.seat)?.ready
        ? '取消准备'
        : '准备';
    }
    els.btnStart.hidden = !me?.isHost;
    els.btnBots.hidden = !me?.isHost;
    if (els.btnClearBots) els.btnClearBots.hidden = !me?.isHost;
    els.btnStart.disabled = !state.canStart;
  }

  function renderGameChrome() {
    els.phaseLabel.textContent = PHASE_TEXT[state.phase] || state.phase;
    let dayText = `第 ${state.day} 天`;
    if (state.phase === 'night') {
      dayText = `第 ${state.night} 夜`;
      els.dayLabel.textContent = dayText;
    } else if (state.phase === 'day_speak' && state.currentSpeakerSeat) {
      dayText = `第 ${state.day} 天 · ${state.currentSpeakerSeat}号发言`;
      els.dayLabel.textContent = dayText;
    } else if (state.phase === 'last_words' && state.currentSpeakerSeat) {
      dayText = `遗言 · ${state.currentSpeakerSeat}号`;
      els.dayLabel.textContent = dayText;
    } else if (POLICE_SPEECH_PHASES.has(state.phase) && state.currentSpeakerSeat) {
      dayText = `上警 · ${state.currentSpeakerSeat}号发言`;
      els.dayLabel.textContent = dayText;
    } else if (POLICE_PHASES.has(state.phase)) {
      dayText = `第 ${state.day} 天 · ${PHASE_TEXT[state.phase]}`;
      els.dayLabel.textContent = dayText;
    } else {
      els.dayLabel.textContent = dayText;
    }
    updateTimer();

    const me = state.me;
    if (me?.isSpectator) {
      els.myRole.innerHTML = `
        <div class="role-name">观战中</div>
        <div class="role-camp">旁观席</div>
        <p class="role-desc">你正在观战本局，终局后可看到全部身份。</p>
      `;
    } else {
      const meta = rolesMeta[me?.roleId] || {};
      els.myRole.innerHTML = `
        <div class="role-name">${me?.roleName || '—'}</div>
        <div class="role-camp ${me?.camp || ''}">${me?.camp === 'wolf' ? '狼人阵营' : '好人阵营'}</div>
        <p class="role-desc">${meta.description || ''}</p>
      `;
    }

    renderPrivateInfo();
    els.announce.textContent = buildAnnounce();
    renderCircle();
    renderTableCenter(dayText);
    renderActions();
    syncChatFromState();
  }

  function buildAnnounce() {
    if (state.phase === 'dawn') return '天亮了，请查看圆桌中央播报';
    if (state.phase === 'last_words' && state.currentSpeakerSeat) {
      return `遗言：请 ${state.currentSpeakerSeat} 号发言（限时 1 分钟，可提前结束）`;
    }
    if (state.phase === 'day_speak' && state.currentSpeakerSeat) {
      return `请 ${state.currentSpeakerSeat} 号发言（限时 1 分钟，可提前结束）`;
    }
    if (state.phase === 'police_register') {
      return '上警报名：请选择「我要上警」或「不上警」（每人仅一次）';
    }
    if (POLICE_SPEECH_PHASES.has(state.phase) && state.currentSpeakerSeat) {
      return `上警发言：请 ${state.currentSpeakerSeat} 号发言`;
    }
    if (state.phase === 'police_withdraw') {
      return '退水阶段：竞选者可选择继续竞选或退水';
    }
    if (state.phase === 'police_vote') {
      return '警长投票：点选竞选者头像后确认（候选人不可投自己，可弃票）';
    }
    if (state.phase === 'police_result') {
      return (state.announcements || []).join(' ') || '宣布警长';
    }
    if (state.phase === 'police_order') {
      return '请警长选择白天发言顺序';
    }
    if (state.phase === 'day_vote') {
      const anns = state.announcements || [];
      if (anns.some((a) => /放逐|平票/.test(a))) return anns.join(' ');
      return '投票阶段：先点选一名玩家头像，再点「确认投票」';
    }
    return (state.announcements || []).join(' ') || '';
  }

  function renderPrivateInfo() {
    const me = state.me;
    if (!me) {
      els.privateInfo.innerHTML = '';
      return;
    }
    const bits = [];
    if (me.flags?.justConverted) bits.push('<div class="hint">你已被石像鬼转化，加入狼人阵营（转化者）</div>');
    if (me.flags?.becomeWolf) bits.push('<div class="hint">偶像被放逐，你已变为狼人</div>');
    if (me.flags?.idol) bits.push(`<div>你的偶像：${me.flags.idol} 号</div>`);
    if (me.flags?.inheritedRole) {
      bits.push(`<div class="hint">你继承了身份：${rolesMeta[me.flags.inheritedRole]?.name || me.flags.inheritedRole}</div>`);
    }
    if (me.flags?.convertor) bits.push('<div>状态：转化者</div>');
    if (me.flags?.canConvertedKill) bits.push('<div class="hint">两位石像鬼已出局且仅剩你一名转化者：可刀人</div>');
    if (me.flags?.wolfKillBlocked) bits.push('<div class="hint">场上有多名转化者，本夜无法发动狼刀</div>');
    if (me.flags?.convertedSeat) bits.push(`<div class="hint">你转化了 ${me.flags.convertedSeat} 号</div>`);
    if (me.flags?.hiddenAwakened) bits.push('<div class="hint">隐狼觉醒：可刀人/模仿</div>');
    if (me.wolfIntel) {
      const g = (me.wolfIntel.gargoyleSeats || [])
        .map((x) => `${x.seat}号石像鬼${x.alive ? '' : '(已出局)'}`)
        .join('、');
      const c = (me.wolfIntel.deadConvertorSeats || [])
        .map((x) => `${x.seat}号转化者(已出局)`)
        .join('、');
      bits.push(`<div class="hint">狼队情报：${g || '—'}${c ? `；${c}` : ''}</div>`);
      bits.push(`<div class="hint">${me.wolfIntel.note || ''}</div>`);
    }
    if (me.flags?.hiddenImitate) {
      bits.push(`<div>已模仿：${rolesMeta[me.flags.hiddenImitate]?.name || me.flags.hiddenImitate}</div>`);
    }
    if (me.roleId === 'witch' || me.flags?.inheritedRole === 'witch') {
      bits.push(`<div>解药：${me.flags.witchSave ? '有' : '无'} · 毒药：${me.flags.witchPoison ? '有' : '无'}</div>`);
    }
    if (me.lastCheck) {
      bits.push(`<div class="hint">第${me.lastCheck.night}夜查验 ${me.lastCheck.seat} 号 → ${me.lastCheck.result}</div>`);
    }
    if (state.nightHint?.length) {
      state.nightHint.forEach((h) => bits.push(`<div class="hint">${h}</div>`));
    }
    if (me.isCurrentSpeaker) {
      bits.push(
        state.phase === 'last_words'
          ? '<div class="hint">轮到你发表遗言：打开麦克风，说完点「结束遗言」</div>'
          : '<div class="hint">轮到你发言：打开麦克风，说完点「结束发言」</div>'
      );
    }
    if (me.isPoliceChief) {
      bits.push('<div class="hint">你是警长 👑（放逐投票权重 1.5）</div>');
    }
    if (me.isCandidate && POLICE_PHASES.has(state.phase)) {
      bits.push('<div class="hint">你正在竞选警长</div>');
    }
    els.privateInfo.innerHTML = bits.join('') || '<div style="color:var(--ink-soft)">暂无额外信息</div>';
  }

  function updateMoonCenter(dayText) {
    const phase = PHASE_TEXT[state.phase] || state.phase;
    const isNight = state.phase === 'night' || state.phase === 'dawn';
    if (els.moonIcon) els.moonIcon.textContent = isNight ? '☾' : '☀';
    if (els.moonPhase) els.moonPhase.textContent = phase;
    if (els.moonRound) els.moonRound.textContent = dayText || '';
  }

  function reasonLabel(reasons) {
    const rs = reasons || [];
    if (rs.includes('wolf') || rs.includes('hidden_extra')) return '刀口';
    if (rs.includes('poison')) return '毒杀';
    if (rs.includes('dream_kill')) return '摄梦反噬';
    if (rs.includes('dream_link')) return '摄梦连带';
    if (rs.includes('exile')) return '放逐';
    if (rs.includes('hunter')) return '枪杀';
    if (rs.includes('puffer') || rs.includes('puffer_self')) return '河豚';
    if (rs.includes('explode')) return '自爆';
    return '出局';
  }

  function buildPopupContent() {
    if (state.phase === 'dawn' && state.dawnReport) {
      const r = state.dawnReport;
      const deaths = r.deaths || [];
      let body = `<div class="bear-line">${r.bearRoar ? '熊咆哮了！' : '熊没有咆哮。'}</div>`;
      if (!deaths.length) {
        body += `<div class="safe-line">昨晚是平安夜</div>`;
      } else {
        body += deaths
          .map((d) => {
            const tip = d.delayed
              ? `${d.seat} 号 ${escapeHtml(d.name || '')} 白猫翻牌，暂未出局`
              : `${d.seat} 号 ${escapeHtml(d.name || '')} · ${reasonLabel(d.reasons)}`;
            return `<div class="death-line">${tip}</div>`;
          })
          .join('');
      }
      return {
        key: `dawn-${r.day}-${deaths.map((d) => d.seat).join(',')}`,
        eyebrow: '天亮播报',
        title: `第 ${r.day} 天`,
        body,
      };
    }

    const anns = state.announcements || [];
    const exileLike = anns.find((a) => /被放逐|平票|自爆/.test(a));
    if (exileLike && ['skill', 'night', 'dawn', 'day_vote'].includes(state.phase)) {
      return {
        key: `exile-${state.day}-${exileLike}`,
        eyebrow: /自爆/.test(exileLike) ? '白天事件' : '放逐结果',
        title: exileLike,
        body: anns
          .filter((a) => a !== exileLike)
          .map((a) => `<div>${escapeHtml(a)}</div>`)
          .join(''),
      };
    }

    if (anns.length && state.phase === 'night' && /天黑|闭眼/.test(anns[0] || '')) {
      return {
        key: `night-${state.night}-${anns[0]}`,
        eyebrow: '入夜',
        title: anns[0],
        body: anns.slice(1).map((a) => `<div>${escapeHtml(a)}</div>`).join(''),
      };
    }

    return null;
  }

  function renderTableCenter(dayText) {
    if (state.phase === 'lobby') {
      if (els.moonIcon) els.moonIcon.textContent = '☾';
      if (els.moonPhase) els.moonPhase.textContent = '等待开局';
      const seated = state.seatedCount ?? (state.players || []).length;
      const maxP = state.maxPlayers || 12;
      if (els.moonRound) {
        els.moonRound.textContent = state.canStart
          ? '人数已满，可开始'
          : `${seated}/${maxP} 人入座`;
      }
      if (els.tablePopup) els.tablePopup.hidden = true;
      if (els.speakerHud) els.speakerHud.hidden = true;
      if (els.tableMoon) els.tableMoon.classList.remove('is-hidden');
      return;
    }

    updateMoonCenter(dayText);

    const popup = buildPopupContent();
    const speaking =
      (SPEAK_PHASES.has(state.phase) && state.currentSpeakerSeat != null && !popup);

    if (popup && popup.key !== popupDismissedKey) {
      lastPopupKey = popup.key;
      if (els.tablePopup) {
        els.tablePopup.hidden = false;
        if (els.popupEyebrow) els.popupEyebrow.textContent = popup.eyebrow;
        if (els.popupTitle) els.popupTitle.textContent = popup.title;
        if (els.popupBody) els.popupBody.innerHTML = popup.body || '';
      }
      if (els.tableMoon) els.tableMoon.classList.add('is-hidden');
      if (els.speakerHud) els.speakerHud.hidden = true;
      return;
    }

    if (els.tablePopup) els.tablePopup.hidden = true;
    if (els.tableMoon) els.tableMoon.classList.toggle('is-hidden', !!speaking);

    if (els.speakerHud) {
      if (speaking) {
        els.speakerHud.hidden = false;
        if (els.speakerSeatLabel) {
          els.speakerSeatLabel.textContent = `${state.currentSpeakerSeat} 号`;
        }
        if (els.speakerNameLabel) {
          els.speakerNameLabel.textContent =
            state.currentSpeakerName ||
            (state.phase === 'last_words' ? '遗言中' : '发言中');
          if (els.speakerHud) {
            const eyebrow = els.speakerHud.querySelector('.speaker-eyebrow');
            if (eyebrow) {
              eyebrow.textContent = state.phase === 'last_words' ? '正在发表遗言' : '正在发言';
            }
          }
        }
      } else {
        els.speakerHud.hidden = true;
      }
    }
  }

  function renderCircle() {
    const isLobby = state.phase === 'lobby';
    const maxP = state.maxPlayers || 12;
    const players = state.players || [];
    const me = state.me;
    const bySeat = new Map(players.map((p) => [p.seat, p]));

    const seats = isLobby
      ? Array.from({ length: maxP }, (_, i) => i + 1)
      : players.map((p) => p.seat).sort((a, b) => a - b);

    const key = JSON.stringify({
      seats: seats.map((s) => {
        const p = bySeat.get(s);
        return p
          ? [s, p.name, p.alive, p.ready, p.connected, p.whiteCatPending, p.teammate, p.roleName, p.isBot]
          : [s, null];
      }),
      speaker: state.currentSpeakerSeat,
      sel: selectedSeat,
      phase: state.phase,
      host: !!me?.isHost,
    });
    if (key === lastCircleKey) return;
    lastCircleKey = key;

    const n = Math.max(seats.length, 1);
    const micSvg =
      '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/></svg>';

    els.circle.innerHTML = seats
      .map((seat, i) => {
        const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
        const radius = 42;
        const left = 50 + radius * Math.cos(angle);
        const top = 50 + radius * Math.sin(angle);
        const p = bySeat.get(seat);

        if (!p) {
          return `<button type="button" class="player-token empty-seat" data-seat="${seat}" style="left:${left.toFixed(2)}%;top:${top.toFixed(2)}%">
            <div class="avatar">
              <span class="t-seat">${seat}</span>
              +
            </div>
            <div class="t-name">空位</div>
            <div class="t-tag">点击入座</div>
          </button>`;
        }

        const isMe = p.seat === me?.seat && !me?.isSpectator;
        const isBot = !!p.isBot || /^电脑\d*$/.test(p.name || '');
        const isSpeaking =
          !isLobby && SPEAK_PHASES.has(state.phase) && state.currentSpeakerSeat === p.seat;
        const isChief = !!p.isPoliceChief;
        const cls = [
          'player-token',
          isLobby ? '' : p.alive ? '' : 'dead',
          isMe ? 'me' : '',
          selectedSeat === p.seat && !isLobby ? 'selected' : '',
          isSpeaking ? 'speaking' : '',
          isChief ? 'police-chief' : '',
          isLobby && p.ready ? 'ready-seat' : '',
          isLobby && isBot && me?.isHost ? 'bot-seat' : '',
        ]
          .filter(Boolean)
          .join(' ');

        let tag = '';
        if (isLobby) {
          if (isBot && me?.isHost) tag = '点击移除';
          else if (p.ready) tag = '已准备';
          else tag = '未准备';
          if (isMe) tag += ' · 我';
        } else if (isSpeaking) tag = state.phase === 'last_words' ? '遗言中' : '发言中';
        else if (isChief) tag = '👑 警长';
        else if (p.teammate) tag = p.roleName;
        else if (p.whiteCatPending) tag = '白猫翻牌';
        else if (!p.alive) tag = '出局';
        else if (p.connected === false) tag = '掉线';

        const disabled = !isLobby && !p.alive ? 'disabled' : '';
        return `<button type="button" class="${cls}" data-seat="${seat}" data-name="${escapeHtml(p.name)}" style="left:${left.toFixed(2)}%;top:${top.toFixed(2)}%" ${disabled}>
          <div class="avatar">
            <span class="t-seat">${seat}</span>
            ${seat}
            ${isChief ? '<span class="police-badge" title="警长">👑</span>' : ''}
            ${isSpeaking ? `<span class="mic-badge">${micSvg}</span>` : ''}
          </div>
          <div class="t-name">${escapeHtml(p.name)}</div>
          ${tag ? `<div class="t-tag">${tag}</div>` : ''}
        </button>`;
      })
      .join('');
  }

  function renderActions(force) {
    const me = state.me;
    if (!me) {
      els.actionBar.innerHTML = '';
      return;
    }

    const key = [
      state.phase,
      selectedSeat,
      me.needsNightAction,
      me.isCurrentSpeaker,
      me.hasVoted,
      me.myVote,
      me.canSelfDestruct,
      me.isSpectator,
      me.hasRegistered,
      me.hasWithdrawnAction,
      me.hasPoliceVoted,
      me.isCandidate,
      me.isPoliceChief,
      me.canTransfer,
      state.pendingSkill?.type,
      state.currentSpeakerSeat,
      state.night,
      (state.police?.candidates || []).join(','),
    ].join('|');
    if (!force && key === lastActionKey) return;
    lastActionKey = key;

    const parts = [];

    if (me.isSpectator) {
      parts.push(`<div class="hint-text">观战模式：可听发言、看进程，不能行动/投票。</div>`);
      els.actionBar.innerHTML = parts.join('');
      return;
    }

    if (me.canSelfDestruct) {
      parts.push(
        `<button type="button" class="btn btn-danger" data-action="self-destruct">觉醒石像鬼 · 自爆</button>`
      );
    }

    if (state.phase === 'police_register' && me.alive && !me.whiteCatPending) {
      if (me.hasRegistered) {
        parts.push(
          `<div class="hint-text">你已选择${me.registerChoice ? '上警' : '不上警'}，等待其他人…</div>`
        );
      } else {
        parts.push(`<div class="hint-text">是否参加警长竞选？（每人只能选一次）</div>`);
        parts.push(
          `<button type="button" class="btn btn-primary" data-action="police-register" data-want="1">我要上警</button>`
        );
        parts.push(
          `<button type="button" class="btn btn-ghost" data-action="police-register" data-want="0">不上警</button>`
        );
      }
    } else if (POLICE_SPEECH_PHASES.has(state.phase)) {
      if (me.isCurrentSpeaker) {
        parts.push(`<div class="hint-text">轮到你上警发言。说完可提前结束。</div>`);
        parts.push(`<button type="button" class="btn btn-primary" data-action="end-speak">结束发言</button>`);
      } else if (state.currentSpeakerSeat) {
        parts.push(`<div class="hint-text">请听 ${state.currentSpeakerSeat} 号上警发言…</div>`);
      }
    } else if (state.phase === 'police_withdraw' && me.alive && me.isCandidate) {
      if (me.hasWithdrawnAction) {
        parts.push(`<div class="hint-text">你已表态，等待其他竞选者…</div>`);
      } else {
        parts.push(`<div class="hint-text">是否继续竞选警长？退水后不可重新报名。</div>`);
        parts.push(
          `<button type="button" class="btn btn-primary" data-action="police-withdraw" data-leave="0">继续竞选</button>`
        );
        parts.push(
          `<button type="button" class="btn btn-ghost" data-action="police-withdraw" data-leave="1">退水</button>`
        );
      }
    } else if (state.phase === 'police_vote' && me.alive && !me.whiteCatPending) {
      if (me.hasPoliceVoted) {
        const tip =
          me.myPoliceVote == null
            ? '你已弃票，等待其他人…'
            : `你已投票给 ${me.myPoliceVote} 号，等待其他人…`;
        parts.push(`<div class="hint-text">${tip}</div>`);
      } else {
        const cands = (state.police?.candidates || []).join('、');
        parts.push(
          `<div class="hint-text">竞选者：${cands || '—'} 号。点选头像后确认（不可投自己）${
            selectedSeat ? ` · 当前选中 ${selectedSeat} 号` : ''
          }</div>`
        );
        parts.push(
          `<button type="button" class="btn btn-primary" data-action="police-vote-confirm"${
            selectedSeat == null ? ' disabled' : ''
          }>确认投票${selectedSeat != null ? `：${selectedSeat}号` : ''}</button>`
        );
        parts.push(`<button type="button" class="btn btn-ghost" data-action="vote-abstain">弃票</button>`);
      }
    } else if (state.phase === 'police_result') {
      parts.push(`<div class="hint-text">${(state.announcements || []).join(' ') || '宣布警长…'}</div>`);
    } else if (state.phase === 'police_order') {
      if (me.isPoliceChief) {
        parts.push(`<div class="hint-text">请选择白天发言顺序（从你邻座开始）</div>`);
        parts.push(
          `<button type="button" class="btn btn-primary" data-action="police-order" data-mode="clockwise">从左边顺时针</button>`
        );
        parts.push(
          `<button type="button" class="btn btn-secondary" data-action="police-order" data-mode="counterclockwise">从右边逆时针</button>`
        );
      } else {
        parts.push(`<div class="hint-text">等待警长选择发言顺序…</div>`);
      }
    } else if (state.phase === 'last_words') {
      if (me.isCurrentSpeaker) {
        parts.push(`<div class="hint-text">轮到你发表遗言（1分钟）。建议开麦，说完可提前结束。</div>`);
        parts.push(`<button type="button" class="btn btn-primary" data-action="end-speak">结束遗言</button>`);
      } else if (state.currentSpeakerSeat) {
        parts.push(`<div class="hint-text">请听 ${state.currentSpeakerSeat} 号遗言…</div>`);
      }
    } else if (state.phase === 'day_speak') {
      if (me.isCurrentSpeaker) {
        parts.push(`<div class="hint-text">轮到你发言（1分钟）。建议开麦，说完可提前结束。</div>`);
        parts.push(`<button type="button" class="btn btn-primary" data-action="end-speak">结束发言</button>`);
      } else if (state.currentSpeakerSeat) {
        parts.push(`<div class="hint-text">请听 ${state.currentSpeakerSeat} 号发言…</div>`);
      }
    } else if (state.phase === 'day_vote' && me.alive && !me.whiteCatPending) {
      if (me.hasVoted) {
        const tip =
          me.myVote == null ? '你已弃票，等待其他人…' : `你已投票给 ${me.myVote} 号，等待其他人…`;
        parts.push(`<div class="hint-text">${tip}</div>`);
      } else {
        parts.push(`<div class="hint-text">① 点击上方玩家头像选人 ② 再点确认投票${selectedSeat ? `（当前选中 ${selectedSeat} 号）` : ''}</div>`);
        parts.push(
          `<button type="button" class="btn btn-primary btn-confirm-vote" data-action="vote-confirm"${selectedSeat == null ? ' disabled' : ''}>确认投票${selectedSeat != null ? `：${selectedSeat}号` : ''}</button>`
        );
        parts.push(`<button type="button" class="btn btn-ghost" data-action="vote-abstain">弃票</button>`);
      }
    } else if (state.phase === 'night' && me.alive && me.needsNightAction) {
      parts.push(`<div class="hint-text">请选择目标并提交夜间行动${selectedSeat ? `（选中 ${selectedSeat} 号）` : ''}</div>`);
      const role = me.roleId;
      if (role === 'admirer' && state.night === 1) {
        parts.push(nightBtn('指定暗恋对象', 'idol', true));
      }
      if (role === 'dream_catcher') parts.push(nightBtn('摄梦', 'dream', true));
      if (role === 'awakened_gargoyle') {
        parts.push(nightBtn('查验身份', 'gargoyle_check', true));
        if (me.flags?.canWolfKill) parts.push(nightBtn('刀人', 'wolf_kill', true));
        if (!me.flags?.gargoyleConvertedDone) {
          parts.push(nightBtn('转化好人', 'gargoyle_convert', true));
        }
        parts.push(nightBtn('确认结束夜间行动', 'done', false, 'primary'));
      }
      if (me.flags?.canConvertedKill) parts.push(nightBtn('刀人', 'wolf_kill', true));
      if (me.flags?.canConvertedKill && me.roleId !== 'awakened_gargoyle' && me.roleId !== 'awakened_hidden_wolf') {
        parts.push(nightBtn('确认结束夜间行动', 'done', false, 'primary'));
      }
      if (role === 'awakened_hidden_wolf') {
        if (!me.flags?.hiddenImitate) {
          parts.push(nightBtn('模仿', 'hidden_imitate', true));
        }
        if (me.flags?.hiddenAwakened || me.flags?.canWolfKill) {
          parts.push(nightBtn('刀人', 'wolf_kill', true));
        }
        if (me.flags?.hiddenExtraKnife && me.flags?.hiddenAwakened) {
          parts.push(nightBtn('额外刀（女巫不可见）', 'hidden_extra_kill', true));
        }
        if (me.flags?.imitateMirror) {
          parts.push(nightBtn('查验身份', 'mirror_check', true));
        }
        if (me.flags?.imitateSeer) {
          parts.push(nightBtn('查验阵营', 'seer_check', true));
        }
        if (me.flags?.witchPoison) {
          parts.push(nightBtn('使用毒药', 'witch_poison', true));
        }
        parts.push(nightBtn('确认结束夜间行动', 'done', false, 'primary'));
      }
      if (role === 'witch' || me.flags?.inheritedRole === 'witch') {
        if (me.flags.witchSave) parts.push(nightBtn('使用解药', 'witch_save', false));
        if (me.flags.witchPoison) parts.push(nightBtn('使用毒药', 'witch_poison', true));
      }
      if (role === 'seer') parts.push(nightBtn('查验阵营', 'seer_check', true));
      if (role === 'mirror_maiden') {
        parts.push(nightBtn('查验身份', 'mirror_check', true));
      }
      if (role !== 'dream_catcher' && role !== 'awakened_hidden_wolf' && role !== 'awakened_gargoyle') {
        parts.push(nightBtn('跳过/结束行动', 'skip', false, 'ghost'));
      }
    } else if (state.phase === 'skill' && state.pendingSkill) {
      if (state.pendingSkill.type === 'hunter_shot') {
        parts.push(`<div class="hint-text">猎人开枪：选择带走的玩家</div>`);
        parts.push(
          `<button type="button" class="btn btn-secondary" data-action="skill" data-type="hunter_shot" data-need-target="1">开枪</button>`
        );
      }
      if (state.pendingSkill.type === 'puffer') {
        parts.push(`<div class="hint-text">河豚可引爆，带走所有投给你的人</div>`);
        parts.push(`<button type="button" class="btn btn-secondary" data-action="skill" data-type="puffer_explode">引爆</button>`);
        parts.push(`<button type="button" class="btn btn-ghost" data-action="skill" data-type="skip">不使用</button>`);
      }
      if (state.pendingSkill.type === 'police_transfer') {
        parts.push(
          `<div class="hint-text">你是警长且已出局：是否移交警徽？${
            selectedSeat ? `（选中 ${selectedSeat} 号）` : '点选一名存活玩家'
          }</div>`
        );
        parts.push(
          `<button type="button" class="btn btn-primary" data-action="skill" data-type="police_transfer" data-need-target="1">移交警徽</button>`
        );
        parts.push(
          `<button type="button" class="btn btn-ghost" data-action="skill" data-type="police_abandon">撕毁警徽</button>`
        );
      }
    } else if (state.phase === 'dawn') {
      parts.push(`<div class="hint-text">公布昨夜信息…</div>`);
    } else if (state.phase === 'night' && me.alive) {
      parts.push(`<div class="hint-text">本夜你无需行动，请等待其他玩家</div>`);
    } else if (!me.alive) {
      parts.push(`<div class="hint-text">你已出局，可旁观</div>`);
    }

    els.actionBar.innerHTML = parts.join('');
  }

  function nightBtn(label, type, needTarget, style = 'secondary') {
    const cls =
      style === 'primary' ? 'btn btn-primary' : style === 'ghost' ? 'btn btn-ghost' : 'btn btn-secondary';
    return `<button type="button" class="${cls}" data-action="night" data-type="${type}" data-need-target="${needTarget ? '1' : '0'}">${label}</button>`;
  }

  function renderEnded() {
    nightBgm.stop();
    if (state) narratorPrev = narrator.sync(state, narratorPrev);
    const win =
      state.winner === 'admin'
        ? '管理员强制结束'
        : state.winner === 'wolf'
          ? '狼人阵营胜利'
          : '好人阵营胜利';
    els.endTitle.textContent = win;
    els.endSub.textContent = '本局身份公示 · 房间不解散，房主可开下一局';
    els.endRoles.innerHTML = (state.players || [])
      .map(
        (p) => `<div><span>${p.seat} 号 ${escapeHtml(p.name)}</span><span>${p.roleName || ''}</span></div>`
      )
      .join('');
    els.btnNextGame.hidden = !state.me?.isHost;
    if (els.btnAdminEndGame) els.btnAdminEndGame.hidden = true;
  }

  function appendChat(msg) {
    const div = document.createElement('div');
    div.className = 'chat-item' + (msg.system ? ' system' : '');
    if (msg.system) {
      div.textContent = msg.text;
    } else {
      const who = msg.spectator
        ? `[观战] ${escapeHtml(msg.from)}`
        : `${msg.seat != null ? msg.seat + '号' : ''} ${escapeHtml(msg.from)}`;
      div.innerHTML = `<span class="who">${who}</span>${escapeHtml(msg.text)}`;
    }
    els.chatLog.appendChild(div);
    els.chatLog.scrollTop = els.chatLog.scrollHeight;
  }

  function syncChatFromState() {
    const logs = state.logs || [];
    if (logs.length === lastLogLen) return;
    if (logs.length < lastLogLen) {
      els.chatLog.innerHTML = '';
      lastLogLen = 0;
    }
    logs.slice(lastLogLen).forEach(appendChat);
    lastLogLen = logs.length;
  }

  function updateTimer() {
    clearInterval(timerTick);
    const tick = () => {
      if (!state?.timerEndsAt) {
        els.timerText.textContent = '--';
        return;
      }
      const left = Math.max(0, Math.ceil((state.timerEndsAt - Date.now()) / 1000));
      const m = String(Math.floor(left / 60)).padStart(2, '0');
      const s = String(left % 60).padStart(2, '0');
      els.timerText.textContent = `${m}:${s}`;
    };
    tick();
    timerTick = setInterval(tick, 250);
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
})();
