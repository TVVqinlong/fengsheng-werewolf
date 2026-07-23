/**
 * 风声谍影对局房间
 * 阶段流程：lobby → night → dawn → [day1: 上警流程] → day_speak → day_vote → resolve → (night...) → ended
 */

const { CAMP, createRolePool, shuffle, getRoleMeta, getBoard, BOARDS } = require('./roles');
const {
  PoliceElectionService,
  PolicePhase,
  SpeakOrderMode,
} = require('./police/PoliceElectionService');
const { LastWordsService } = require('./lastWords/LastWordsService');
const WolfKill = require('./wolf/WolfKillRules');

const PHASE = {
  LOBBY: 'lobby',
  NIGHT: 'night',
  DAWN: 'dawn',
  DAY_SPEAK: 'day_speak',
  DAY_VOTE: 'day_vote',
  SKILL: 'skill', // 猎人开枪 / 河豚引爆 / 警徽移交等
  LAST_WORDS: 'last_words', // 遗言
  ENDED: 'ended',
  // 上警（与 PolicePhase 对齐，便于前端统一）
  POLICE_REGISTER: PolicePhase.REGISTER,
  POLICE_SPEECH: PolicePhase.SPEECH,
  POLICE_WITHDRAW: PolicePhase.WITHDRAW,
  POLICE_VOTE: PolicePhase.VOTE,
  POLICE_PK_SPEECH: PolicePhase.PK_SPEECH,
  POLICE_RESULT: PolicePhase.RESULT,
  POLICE_ORDER: PolicePhase.ORDER,
};

const NIGHT_ACTION_MS = 45000;
const SPEAK_TURN_MS = 60000; // 每人发言 1 分钟
const VOTE_MS = 60000;
const SKILL_MS = 30000;

const POLICE_PHASES = new Set(Object.values(PolicePhase));

class GameRoom {
  constructor(code, hostId) {
    this.code = code;
    this.hostId = hostId;
    this.players = new Map(); // socketId -> player
    this.phase = PHASE.LOBBY;
    this.day = 0;
    this.night = 0;
    this.logs = [];
    this.publicAnnouncements = [];
    this.timer = null;
    this.timerEndsAt = null;
    this.nightState = null;
    this.dayState = null;
    this.pendingSkills = [];
    this.winner = null;
    this.createdAt = Date.now();
    this.boardId = 'fengsheng12';
    this.maxPlayers = 12;
    this.policeChiefId = null;
    this.police = new PoliceElectionService(this);
    this.lastWords = new LastWordsService(this);
    this.skillResume = null;
  }

  setBoard(boardId) {
    if (this.phase !== PHASE.LOBBY && this.phase !== PHASE.ENDED) {
      return { ok: false, error: '对局中不能改板子' };
    }
    if (!BOARDS[boardId]) return { ok: false, error: '未知板子' };
    const board = getBoard(boardId);
    if (this.seatedPlayers().length > board.seats) {
      return { ok: false, error: `当前入座人数超过 ${board.seats}，请先让多余玩家观战或退出` };
    }
    for (const p of this.seatedPlayers()) {
      if (p.seat > board.seats) {
        p.isSpectator = true;
        p.seat = null;
        p.ready = false;
      }
    }
    this.boardId = board.id;
    this.maxPlayers = board.seats;
    return { ok: true, boardId: this.boardId, maxPlayers: this.maxPlayers };
  }

  seatedPlayers() {
    return [...this.players.values()].filter((p) => !p.isSpectator && p.seat != null);
  }

  alivePlayers() {
    return this.seatedPlayers().filter((p) => p.alive);
  }

  addPlayer(socketId, name, { spectator = false, seat = null } = {}) {
    // 同名断线重连：收回座位（大厅/对局/终局均可）
    const existing = [...this.players.values()].find((p) => p.name === name);
    if (existing) {
      if (existing.connected && existing.id !== socketId) {
        return { ok: false, error: '昵称已被占用（该玩家仍在线）' };
      }
      return this.reclaimPlayer(existing.id, socketId);
    }

    // 对局中新人只能观战
    if (this.phase !== PHASE.LOBBY && this.phase !== PHASE.ENDED) {
      if (!spectator) {
        return { ok: false, error: '对局进行中，只能选择观战加入' };
      }
    }

    if (spectator) {
      const player = {
        id: socketId,
        name,
        seat: null,
        isSpectator: true,
        ready: false,
        connected: true,
        alive: true,
        roleId: null,
        camp: null,
        flags: {},
        votes: null,
        disconnectedAt: null,
      };
      this.players.set(socketId, player);
      return { ok: true, player, spectator: true };
    }

    if (this.seatedPlayers().length >= this.maxPlayers) {
      return { ok: false, error: `座位已满（${this.maxPlayers}人），可选择观战` };
    }

    let targetSeat = seat != null ? Number(seat) : this.nextSeat();
    if (targetSeat < 1 || targetSeat > this.maxPlayers) {
      return { ok: false, error: '座位号无效' };
    }
    if (this.seatedPlayers().some((p) => p.seat === targetSeat)) {
      targetSeat = this.nextSeat();
    }
    if (!targetSeat) return { ok: false, error: '没有空座位' };

    const player = {
      id: socketId,
      name,
      seat: targetSeat,
      isSpectator: false,
      ready: false,
      connected: true,
      alive: true,
      roleId: null,
      camp: null,
      flags: {},
      votes: null,
      disconnectedAt: null,
    };
    this.players.set(socketId, player);
    return { ok: true, player };
  }

  /** 大厅/终局：换到空座位 */
  changeSeat(socketId, seat) {
    if (this.phase !== PHASE.LOBBY && this.phase !== PHASE.ENDED) {
      return { ok: false, error: '对局中不能换座' };
    }
    const p = this.players.get(socketId);
    if (!p) return { ok: false, error: '不在房间内' };
    const s = Number(seat);
    if (!Number.isInteger(s) || s < 1 || s > this.maxPlayers) {
      return { ok: false, error: '座位无效' };
    }
    const occupied = this.seatedPlayers().find((x) => x.seat === s && x.id !== socketId);
    if (occupied) return { ok: false, error: '该座位已有人' };

    p.seat = s;
    p.isSpectator = false;
    p.ready = false;
    return { ok: true, seat: s };
  }

  /** 坐下的玩家改为观战 */
  becomeSpectator(socketId) {
    if (this.phase !== PHASE.LOBBY && this.phase !== PHASE.ENDED) {
      return { ok: false, error: '对局中不能改为观战' };
    }
    const p = this.players.get(socketId);
    if (!p) return { ok: false, error: '不在房间内' };
    p.isSpectator = true;
    p.seat = null;
    p.ready = false;
    p.roleId = null;
    p.camp = null;
    p.flags = {};
    return { ok: true };
  }

  reclaimPlayer(oldId, newId) {
    const p = this.players.get(oldId);
    if (!p) return { ok: false, error: '玩家不存在' };
    this.players.delete(oldId);
    p.id = newId;
    p.connected = true;
    p.disconnectedAt = null;
    this.players.set(newId, p);
    if (this.hostId === oldId) this.hostId = newId;
    this.remapRuntimeIds(oldId, newId);
    return { ok: true, player: p, reclaimed: true };
  }

  remapRuntimeIds(oldId, newId) {
    if (this.nightState?.actions?.[oldId]) {
      this.nightState.actions[newId] = this.nightState.actions[oldId];
      delete this.nightState.actions[oldId];
    }
    if (this.nightState?.submitted?.has(oldId)) {
      this.nightState.submitted.delete(oldId);
      this.nightState.submitted.add(newId);
    }
    if (this.dayState?.votes?.[oldId] !== undefined) {
      this.dayState.votes[newId] = this.dayState.votes[oldId];
      delete this.dayState.votes[oldId];
    }
    if (this.dayState?.voted?.has(oldId)) {
      this.dayState.voted.delete(oldId);
      this.dayState.voted.add(newId);
    }
    for (const s of this.pendingSkills) {
      if (s.playerId === oldId) s.playerId = newId;
    }
    if (this.policeChiefId === oldId) this.policeChiefId = newId;
    // 上警运行时 ID 迁移（断线重连）
    if (this.police) {
      if (this.police.registrations?.has(oldId)) {
        this.police.registrations.set(newId, this.police.registrations.get(oldId));
        this.police.registrations.delete(oldId);
      }
      if (this.police.votes?.[oldId] !== undefined) {
        this.police.votes[newId] = this.police.votes[oldId];
        delete this.police.votes[oldId];
      }
      if (this.police.voted?.has(oldId)) {
        this.police.voted.delete(oldId);
        this.police.voted.add(newId);
      }
      if (this.police.withdrawn?.has(oldId)) {
        this.police.withdrawn.delete(oldId);
        this.police.withdrawn.add(newId);
      }
      if (this.police.pendingTransfer?.fromId === oldId) {
        this.police.pendingTransfer.fromId = newId;
      }
    }
  }

  nextSeat() {
    const used = new Set(this.seatedPlayers().map((p) => p.seat));
    for (let i = 1; i <= this.maxPlayers; i++) {
      if (!used.has(i)) return i;
    }
    return null;
  }

  /** 断线：大厅/终局延迟踢出，对局仅标记离线 */
  markDisconnected(socketId) {
    const p = this.players.get(socketId);
    if (!p) return { removed: false };
    p.connected = false;
    p.disconnectedAt = Date.now();
    return { removed: false, player: p };
  }

  /** 清理大厅/终局里超时未重连的玩家 */
  purgeStaleLobby(ttlMs = 90000) {
    if (this.phase !== PHASE.LOBBY && this.phase !== PHASE.ENDED) return [];
    const removed = [];
    const now = Date.now();
    for (const [id, p] of [...this.players.entries()]) {
      if (String(id).startsWith('bot_')) continue;
      if (!p.connected && p.disconnectedAt && now - p.disconnectedAt > ttlMs) {
        this.players.delete(id);
        removed.push(p);
        if (this.hostId === id) {
          const first = [...this.players.keys()].find((k) => !String(k).startsWith('bot_'));
          this.hostId = first || [...this.players.keys()][0] || null;
        }
      }
    }
    return removed;
  }

  removePlayer(socketId) {
    return this.markDisconnected(socketId);
  }

  /** 主动退出房间：立即移除（非仅标记掉线） */
  leavePlayer(socketId) {
    const p = this.players.get(socketId);
    if (!p) return { ok: false, error: '不在房间内' };

    // 对局中退出：若在座位上则等同离席，清空其占位
    this.players.delete(socketId);
    if (this.hostId === socketId) {
      const first = [...this.players.keys()].find((k) => !String(k).startsWith('bot_'));
      this.hostId = first || [...this.players.keys()][0] || null;
    }

    // 清理运行时引用
    if (this.nightState?.actions?.[socketId]) delete this.nightState.actions[socketId];
    this.nightState?.submitted?.delete(socketId);
    if (this.dayState?.votes?.[socketId] !== undefined) delete this.dayState.votes[socketId];
    this.dayState?.voted?.delete(socketId);
    this.pendingSkills = this.pendingSkills.filter((s) => s.playerId !== socketId);
    if (this.police) {
      this.police.registrations?.delete(socketId);
      if (this.police.votes) delete this.police.votes[socketId];
      this.police.voted?.delete(socketId);
      this.police.withdrawn?.delete(socketId);
    }

    return { ok: true, remaining: this.players.size, name: p.name };
  }

  /** 房间列表摘要 */
  getSummary() {
    const seated = this.seatedPlayers();
    const specs = [...this.players.values()].filter((p) => p.isSpectator);
    const board = getBoard(this.boardId);
    return {
      code: this.code,
      phase: this.phase,
      seatedCount: seated.length,
      spectatorCount: specs.length,
      maxPlayers: this.maxPlayers,
      boardId: this.boardId,
      board: board.name,
      rulesNote: board.rulesNote,
      hostName: this.players.get(this.hostId)?.name || '—',
      canJoinSeat: this.phase === PHASE.LOBBY || this.phase === PHASE.ENDED
        ? seated.length < this.maxPlayers
        : false,
      canSpectate: true,
    };
  }

  reconnect(oldId, newId) {
    return this.reclaimPlayer(oldId, newId).ok;
  }

  setReady(socketId, ready) {
    const p = this.players.get(socketId);
    if (!p || p.isSpectator) return false;
    if (this.phase !== PHASE.LOBBY) return false;
    p.ready = !!ready;
    return true;
  }

  canStart() {
    if (this.phase !== PHASE.LOBBY) return false;
    const seated = this.seatedPlayers();
    return seated.length === this.maxPlayers && seated.every((p) => p.ready);
  }

  startGame() {
    if (!this.canStart()) {
      return { ok: false, error: `需要 ${this.maxPlayers} 个座位都坐满且全部准备` };
    }
    const pool = shuffle(createRolePool(this.boardId));
    const list = this.seatedPlayers().sort((a, b) => a.seat - b.seat);
    list.forEach((p, i) => {
      p.roleId = pool[i];
      p.camp = getRoleMeta(pool[i]).camp;
      p.alive = true;
      p.flags = this.initFlags(pool[i]);
    });
    // 观战者保持旁观
    for (const p of this.players.values()) {
      if (p.isSpectator) {
        p.roleId = null;
        p.camp = null;
        p.alive = true;
        p.flags = {};
        p.ready = false;
      }
    }
    this.day = 0;
    this.night = 0;
    this.logs = [];
    this.publicAnnouncements = [];
    this.winner = null;
    this.pendingSkills = [];
    this.nightState = null;
    this.dayState = null;
    this.policeChiefId = null;
    this.police.reset();
    this.lastWords.reset();
    this.addLog('系统', `${getBoard(this.boardId).name}开局，天黑请闭眼…`);
    this.publicAnnouncements = ['天黑了，请闭眼。'];
    this.beginNight();
    return { ok: true };
  }

  /** 终局后回到大厅，房间不解散，可换座再开下一把 */
  backToLobby(socketId) {
    if (this.phase !== PHASE.ENDED) {
      return { ok: false, error: '仅终局后可返回大厅' };
    }
    if (socketId && this.hostId !== socketId) {
      return { ok: false, error: '仅房主可开下一局' };
    }
    this.clearTimer();
    this.phase = PHASE.LOBBY;
    this.day = 0;
    this.night = 0;
    this.winner = null;
    this.nightState = null;
    this.dayState = null;
    this.pendingSkills = [];
    this.publicAnnouncements = ['房间保留，请换座/准备后开始下一局'];
    this.policeChiefId = null;
    this.police.reset();
    this.lastWords.reset();
    for (const p of this.players.values()) {
      p.alive = true;
      p.roleId = null;
      p.camp = null;
      p.flags = {};
      p.votes = null;
      // 电脑玩家自动准备，方便连续开下一局
      if (String(p.id).startsWith('bot_') && !p.isSpectator) {
        p.ready = true;
      } else {
        p.ready = false;
      }
    }
    this.addLog('系统', '已回到大厅，可换座后准备下一局（电脑已自动准备）');
    return { ok: true };
  }

  /** 觉醒石像鬼白天自爆 */
  selfDestruct(socketId) {
    const dayPhases = [
      PHASE.DAWN,
      PHASE.DAY_SPEAK,
      PHASE.DAY_VOTE,
      PHASE.SKILL,
      PHASE.POLICE_REGISTER,
      PHASE.POLICE_SPEECH,
      PHASE.POLICE_WITHDRAW,
      PHASE.POLICE_VOTE,
      PHASE.POLICE_PK_SPEECH,
      PHASE.POLICE_RESULT,
      PHASE.POLICE_ORDER,
      PHASE.LAST_WORDS,
    ];
    if (!dayPhases.includes(this.phase)) {
      return { ok: false, error: '仅白天可自爆' };
    }
    const p = this.players.get(socketId);
    if (!p || p.isSpectator || !p.alive) return { ok: false, error: '无法自爆' };
    if (this.effectiveRole(p) !== 'awakened_gargoyle') {
      return { ok: false, error: '仅觉醒石像鬼可自爆' };
    }
    this.addLog('系统', `${p.seat} 号【觉醒石像鬼】自爆出局！`);
    this.publicAnnouncements = [`${p.seat} 号觉醒石像鬼自爆！`];
    this.killPlayer(p, ['explode']);
    this.pendingSkills = this.pendingSkills.filter((s) => s.playerId !== socketId);
    if (this.checkWin()) return { ok: true, exploded: true };
    this.clearTimer();
    this.phase = PHASE.DAWN;
    this.setPhaseTimer(4000, () => {
      if (this.phase === PHASE.ENDED) return;
      this.beginNight();
    });
    return { ok: true, exploded: true };
  }

  initFlags(roleId) {
    const base = {
      converted: false, // 被石像鬼转化
      convertor: false, // 是否为转化者
      convertedSeat: null,
      convertedBySeat: null,
      justConverted: false,
      whiteCatPending: false,
      whiteCatFlipDay: null,
      poisoned: false,
      shotPending: false,
      idol: null,
      dreamTarget: null,
      lastDreamTarget: null,
      pufferUsed: false,
      witchSave: true,
      witchPoison: true,
      hiddenImitate: null,
      hiddenExtraKnife: false,
      hiddenAwakened: false,
      gargoyleConvertedDone: false,
      originalRoleId: roleId,
      inheritedRole: null,
      becomeWolf: false,
      imitateHunter: false,
      imitateMirror: false,
      imitateSeer: false,
      isPoliceChief: false,
    };
    return base;
  }

  clearTimer() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      this.timerEndsAt = null;
    }
  }

  setPhaseTimer(ms, onTimeout) {
    this.clearTimer();
    this.timerEndsAt = Date.now() + ms;
    this.timer = setTimeout(() => onTimeout(), ms);
  }

  beginNight() {
    this.night += 1;
    this.phase = PHASE.NIGHT;
    this.nightState = {
      actions: {}, // playerId -> action payload
      wolfKill: null,
      convertTarget: null, // seat
      convertActions: [],
      dreamTarget: null,
      dreamKill: null,
      witchSave: false,
      witchPoisonTarget: null,
      seerCheck: null,
      mirrorCheck: null,
      lonelyIdol: null,
      hiddenKill: null,
      hiddenExtraKill: null,
      hiddenImitate: null,
      submitted: new Set(),
    };
    const nightLine =
      this.night === 1
        ? '天黑了，请闭眼。各身份请按顺序行动。（石像鬼互不相认）'
        : `天黑了，请闭眼。第 ${this.night} 夜开始。`;
    this.addLog('系统', nightLine);
    this.publicAnnouncements = [nightLine];
    this.setPhaseTimer(NIGHT_ACTION_MS, () => this.resolveNight());
  }

  /** 玩家提交夜间行动（可多次更新，type=done 表示确认结束） */
  submitNightAction(socketId, action) {
    if (this.phase !== PHASE.NIGHT) return { ok: false, error: '非夜间阶段' };
    const p = this.players.get(socketId);
    if (!p || p.isSpectator || !p.alive) return { ok: false, error: '无法行动' };

    const role = this.effectiveRole(p);

    if (action.type === 'done' || action.type === 'skip') {
      if (role === 'dream_catcher') {
        const prev = this.nightState.actions[socketId];
        if (!prev || prev.type !== 'dream') {
          return { ok: false, error: '摄梦人必须指定梦游者' };
        }
      }
      if (role === 'awakened_gargoyle') {
        const prev = this.nightState.actions[socketId];
        const hasCheck =
          prev?.type === 'gargoyle_check' ||
          (prev?.type === 'gargoyle_night' && prev.check != null);
        if (!hasCheck) {
          return { ok: false, error: '石像鬼请先查验一名玩家' };
        }
      }
      this.nightState.submitted.add(socketId);
      if (!this.nightState.actions[socketId]) {
        this.nightState.actions[socketId] = { type: 'skip' };
      }
      if (this.allNightActionsDone()) this.resolveNight();
      return { ok: true };
    }

    const validated = this.validateNightAction(p, role, action);
    if (!validated.ok) return validated;

    // 石像鬼：查验 + 可选刀人/转化，需合并保存
    const prev = this.nightState.actions[socketId];
    if (role === 'awakened_gargoyle' && prev && typeof prev === 'object') {
      const mergeGargoyle = (base, act) => {
        const out =
          base?.type === 'gargoyle_night'
            ? { ...base }
            : {
                type: 'gargoyle_night',
                check:
                  base?.type === 'gargoyle_check'
                    ? base.targetSeat
                    : base?.check ?? null,
                kill: base?.type === 'wolf_kill' ? base.targetSeat : base?.kill ?? null,
                convert:
                  base?.type === 'gargoyle_convert'
                    ? base.targetSeat
                    : base?.convert ?? null,
              };
        if (act.type === 'wolf_kill') out.kill = act.targetSeat;
        if (act.type === 'gargoyle_check') out.check = act.targetSeat;
        if (act.type === 'gargoyle_convert') out.convert = act.targetSeat;
        return out;
      };
      if (
        ['wolf_kill', 'gargoyle_check', 'gargoyle_convert'].includes(action.type)
      ) {
        this.nightState.actions[socketId] = mergeGargoyle(prev, action);
      } else {
        this.nightState.actions[socketId] = action;
      }
    } else if (role === 'awakened_hidden_wolf') {
      const base =
        prev && prev.type === 'hidden_night'
          ? { ...prev }
          : {
              type: 'hidden_night',
              kill: prev?.type === 'wolf_kill' ? prev.targetSeat : null,
              imitate: prev?.type === 'hidden_imitate' ? prev.targetSeat : null,
              extra: prev?.type === 'hidden_extra_kill' ? prev.targetSeat : null,
              mirror: prev?.type === 'mirror_check' ? prev.targetSeat : null,
              seer: prev?.type === 'seer_check' ? prev.targetSeat : null,
              poison: prev?.type === 'witch_poison' ? prev.targetSeat : null,
            };
      if (action.type === 'wolf_kill') base.kill = action.targetSeat;
      else if (action.type === 'hidden_imitate') base.imitate = action.targetSeat;
      else if (action.type === 'hidden_extra_kill') base.extra = action.targetSeat;
      else if (action.type === 'mirror_check') base.mirror = action.targetSeat;
      else if (action.type === 'seer_check') base.seer = action.targetSeat;
      else if (action.type === 'witch_poison') base.poison = action.targetSeat;
      else {
        this.nightState.actions[socketId] = action;
      }
      if (
        [
          'wolf_kill',
          'hidden_imitate',
          'hidden_extra_kill',
          'mirror_check',
          'seer_check',
          'witch_poison',
        ].includes(action.type)
      ) {
        this.nightState.actions[socketId] = base;
      }
    } else {
      this.nightState.actions[socketId] = action;
    }

    // 狼队刀口提示（女巫可见）：按当前已投票求多数
    if (
      action.type === 'wolf_kill' ||
      this.nightState.actions[socketId]?.type === 'gargoyle_night' ||
      this.nightState.actions[socketId]?.type === 'hidden_night'
    ) {
      this.refreshWolfKillHint();
    }

    // 查验/女巫/摄梦等单次行动后自动确认（石像鬼需手动结束，便于附加刀人）
    const autoDone = [
      'idol',
      'dream',
      'seer_check',
      'mirror_check',
      'witch_save',
      'witch_poison',
    ];
    if (autoDone.includes(action.type)) {
      // 隐狼可能同夜还要刀人/额外刀，不自动结束
      if (role !== 'awakened_hidden_wolf') {
        this.nightState.submitted.add(socketId);
      }
    }
    // 末转化者刀人后自动确认
    if (
      action.type === 'wolf_kill' &&
      WolfKill.isConvertor(p) &&
      !WolfKill.isGargoyle(this, p) &&
      !WolfKill.isHiddenWolf(this, p)
    ) {
      this.nightState.submitted.add(socketId);
    }
    if (action.type === 'hidden_imitate' || action.type === 'hidden_extra_kill') {
      // 隐狼需点「确认结束」或超时
    }

    if (this.allNightActionsDone()) {
      this.resolveNight();
    }
    return { ok: true };
  }

  /** 汇总当前狼刀投票，更新 nightState.wolfKill 供女巫提示 */
  refreshWolfKillHint() {
    if (WolfKill.isWolfKillBlocked(this)) {
      this.nightState.wolfKill = null;
      return;
    }
    const tally = {};
    for (const [pid, action] of Object.entries(this.nightState.actions)) {
      const actor = this.players.get(pid);
      if (!actor || !WolfKill.canParticipateWolfKill(this, actor) || !action) continue;
      let seat = null;
      if (action.type === 'wolf_kill') seat = action.targetSeat;
      if (action.type === 'gargoyle_night') seat = action.kill;
      if (action.type === 'hidden_night') seat = action.kill;
      if (seat == null) continue;
      tally[seat] = (tally[seat] || 0) + 1;
    }
    let max = 0;
    let winners = [];
    for (const [seat, count] of Object.entries(tally)) {
      if (count > max) {
        max = count;
        winners = [Number(seat)];
      } else if (count === max) {
        winners.push(Number(seat));
      }
    }
    this.nightState.wolfKill = winners.length === 1 ? winners[0] : null;
  }

  /** 语音频道策略（前端强制开/闭麦 + 服务端过滤 peers） */
  getVoicePolicy(forSocketId) {
    const me = this.players.get(forSocketId);
    if (!me) {
      return { channel: 'none', canSpeak: false, forceMute: true, label: '' };
    }
    if (this.phase === PHASE.LOBBY || this.phase === PHASE.ENDED) {
      return {
        channel: 'all',
        canSpeak: true,
        forceMute: false,
        label: '大厅语音',
      };
    }
    if (this.phase === PHASE.NIGHT) {
      if (me.alive && WolfKill.isGargoyle(this, me)) {
        return {
          channel: 'gargoyle_night',
          canSpeak: true,
          forceMute: false,
          label: '石像鬼夜间频道（仅队友可听）',
        };
      }
      return {
        channel: 'none',
        canSpeak: false,
        forceMute: true,
        label: '夜晚强制闭麦',
      };
    }
    const speakPhases = new Set([
      PHASE.DAY_SPEAK,
      PHASE.LAST_WORDS,
      PHASE.POLICE_SPEECH,
      PHASE.POLICE_PK_SPEECH,
    ]);
    if (speakPhases.has(this.phase)) {
      const isSpeaker =
        !me.isSpectator && me.seat === this.dayState?.currentSpeakerSeat;
      return {
        channel: 'all',
        canSpeak: isSpeaker,
        forceMute: !isSpeaker,
        label: isSpeaker ? '轮到你发言，可开麦' : '非发言回合，强制闭麦',
      };
    }
    // 天亮 / 投票 / 上警报名等：全员闭麦可听（或不连麦）
    return {
      channel: 'all',
      canSpeak: false,
      forceMute: true,
      label: '非发言阶段，强制闭麦',
    };
  }

  /** 当前玩家可见的语音 peers */
  getVoicePeers(forSocketId) {
    const policy = this.getVoicePolicy(forSocketId);
    const all = [...this.players.values()].filter(
      (p) => p.connected && p.id !== forSocketId && !String(p.id).startsWith('bot_')
    );
    if (policy.channel === 'none') return [];
    if (policy.channel === 'gargoyle_night') {
      return all
        .filter((p) => p.alive && WolfKill.isGargoyle(this, p))
        .map((p) => ({ id: p.id, seat: p.seat, name: p.name }));
    }
    return all.map((p) => ({ id: p.id, seat: p.seat, name: p.name }));
  }

  effectiveRole(p) {
    if (p.flags.inheritedRole) return p.flags.inheritedRole;
    return p.roleId;
  }

  canConvertedKill(p) {
    if (!p) return false;
    return WolfKill.isConvertor(p) && WolfKill.canParticipateWolfKill(this, p);
  }

  isWolfCamp(p) {
    // 暗恋者屠边按民计算，永不计入狼
    if (p.roleId === 'admirer' || this.effectiveRole(p) === 'admirer') return false;
    if (p.flags.becomeWolf) return true;
    if (p.flags.converted || p.flags.convertor) return true;
    return p.camp === CAMP.WOLF;
  }

  /** 预言家视角 */
  checkAsSeer(target) {
    if (this.effectiveRole(target) === 'admirer' || target.roleId === 'admirer') {
      return CAMP.VILLAGE;
    }
    // 觉醒隐狼对预言家显示好人
    if (this.effectiveRole(target) === 'awakened_hidden_wolf') {
      return CAMP.VILLAGE;
    }
    return this.isWolfCamp(target) ? CAMP.WOLF : CAMP.VILLAGE;
  }

  validateNightAction(p, role, action) {
    if (!action || !action.type) return { ok: false, error: '无效行动' };
    const target = action.targetSeat != null ? this.getBySeat(action.targetSeat) : null;

    switch (action.type) {
      case 'skip':
        if (role === 'dream_catcher') return { ok: false, error: '摄梦人必须指定梦游者' };
        return { ok: true };
      case 'idol':
        if (role !== 'admirer' || this.night !== 1) return { ok: false, error: '无法指定暗恋对象' };
        if (!target || target.id === p.id || !target.alive) return { ok: false, error: '目标无效' };
        return { ok: true };
      case 'dream':
        if (role !== 'dream_catcher') return { ok: false, error: '非摄梦人' };
        if (!target || !target.alive || target.id === p.id) return { ok: false, error: '目标无效' };
        return { ok: true };
      case 'wolf_kill':
        if (!WolfKill.canParticipateWolfKill(this, p)) {
          if (WolfKill.isWolfKillBlocked(this)) {
            return { ok: false, error: '场上有多名转化者，本夜无法发动狼刀' };
          }
          return { ok: false, error: '无法刀人' };
        }
        if (!target || !target.alive) return { ok: false, error: '目标无效' };
        if (target.id === p.id) return { ok: false, error: '不能刀自己' };
        return { ok: true };
      case 'gargoyle_check':
        if (role !== 'awakened_gargoyle') return { ok: false, error: '非觉醒石像鬼' };
        if (!target || !target.alive || target.id === p.id) return { ok: false, error: '目标无效' };
        return { ok: true };
      case 'gargoyle_convert':
        if (role !== 'awakened_gargoyle') return { ok: false, error: '非觉醒石像鬼' };
        if (p.flags.gargoyleConvertedDone) return { ok: false, error: '本局已转化过' };
        if (!target || !target.alive || target.id === p.id) return { ok: false, error: '目标无效' };
        if (this.isWolfCamp(target) || WolfKill.isConvertor(target)) {
          return { ok: false, error: '无法转化该目标' };
        }
        return { ok: true };
      case 'witch_save':
        if (role !== 'witch' || !p.flags.witchSave) return { ok: false, error: '无法救人' };
        return { ok: true };
      case 'witch_poison':
        if (
          (role !== 'witch' && role !== 'awakened_hidden_wolf') ||
          !p.flags.witchPoison
        ) {
          return { ok: false, error: '无法毒人' };
        }
        if (!target || !target.alive) return { ok: false, error: '目标无效' };
        return { ok: true };
      case 'mirror_check':
        if (role !== 'mirror_maiden' && !p.flags.imitateMirror) {
          return { ok: false, error: '无法查验身份' };
        }
        if (!target || !target.alive || target.id === p.id) return { ok: false, error: '目标无效' };
        return { ok: true };
      case 'seer_check':
        if (role !== 'seer' && !p.flags.imitateSeer) return { ok: false, error: '非预言家' };
        if (!target || !target.alive || target.id === p.id) return { ok: false, error: '目标无效' };
        return { ok: true };
      case 'hidden_imitate':
        if (role !== 'awakened_hidden_wolf') return { ok: false, error: '非觉醒隐狼' };
        if (p.flags.hiddenImitate) return { ok: false, error: '本局已模仿过' };
        if (!target || target.id === p.id) return { ok: false, error: '目标无效' };
        return { ok: true };
      case 'hidden_extra_kill':
        if (role !== 'awakened_hidden_wolf' || !p.flags.hiddenExtraKnife) {
          return { ok: false, error: '无额外刀' };
        }
        if (!this.hiddenCanKill()) return { ok: false, error: '尚未获得刀人时机' };
        if (!target || !target.alive || target.id === p.id) return { ok: false, error: '目标无效' };
        return { ok: true };
      default:
        return { ok: false, error: '未知行动' };
    }
  }

  hiddenCanKill() {
    // 其余狼人（石像鬼 + 转化者中的“非隐狼狼队”）全部出局
    const others = [...this.players.values()].filter((x) => {
      if (!x.alive) return false;
      if (this.effectiveRole(x) === 'awakened_hidden_wolf') return false;
      return this.isWolfCamp(x);
    });
    return others.length === 0;
  }

  isAdjacentAlive(seatA, seatB) {
    const aliveSeats = this.alivePlayers()
      .map((p) => p.seat)
      .sort((a, b) => a - b);
    const n = aliveSeats.length;
    if (n < 2) return false;
    const i = aliveSeats.indexOf(seatA);
    const j = aliveSeats.indexOf(seatB);
    if (i < 0 || j < 0) return false;
    return Math.abs(i - j) === 1 || (Math.abs(i - j) === n - 1 && n > 2);
  }

  getAdjacentSeats(seat) {
    const alive = this.alivePlayers().sort((a, b) => a.seat - b.seat);
    const n = alive.length;
    if (n < 2) return [];
    const i = alive.findIndex((p) => p.seat === seat);
    if (i < 0) return [];
    const left = alive[(i - 1 + n) % n];
    const right = alive[(i + 1) % n];
    return [left.seat, right.seat];
  }

  getBySeat(seat) {
    return [...this.players.values()].find((p) => p.seat === seat) || null;
  }

  allNightActionsDone() {
    const need = this.alivePlayers().filter((p) => this.needsNightAction(p));
    return need.every((p) => this.nightState.submitted.has(p.id));
  }

  needsNightAction(p) {
    if (!p || p.isSpectator || !p.alive) return false;
    const role = this.effectiveRole(p);
    if (role === 'admirer' && this.night === 1 && !p.flags.idol) return true;
    if (role === 'dream_catcher') return true;
    if (role === 'awakened_gargoyle') return true;
    if (role === 'awakened_hidden_wolf') {
      if (!p.flags.hiddenImitate) return true;
      if (this.hiddenCanKill()) return true;
      if (p.flags.imitateMirror || p.flags.imitateSeer) return true;
      if (p.flags.witchPoison) return true;
      return false;
    }
    // 末转化者可刀人时需要夜间行动
    if (WolfKill.isConvertor(p) && WolfKill.canParticipateWolfKill(this, p)) return true;
    if (role === 'witch') return true;
    if (role === 'seer') return true;
    if (role === 'mirror_maiden') return true;
    return false;
  }

  resolveNight() {
    this.clearTimer();
    if (this.phase !== PHASE.NIGHT) return;

    const ns = this.nightState;
    const deaths = new Map(); // seat -> reasons[]

    const markDead = (seat, reason) => {
      if (!deaths.has(seat)) deaths.set(seat, []);
      deaths.get(seat).push(reason);
    };

    // 收集行动
    const killVotes = {};
    for (const [pid, action] of Object.entries(ns.actions)) {
      const p = this.players.get(pid);
      if (!p || !action) continue;
      const role = this.effectiveRole(p);

      if (action.type === 'idol') {
        p.flags.idol = action.targetSeat;
        ns.lonelyIdol = action.targetSeat;
      }
      if (action.type === 'dream') {
        ns.dreamTarget = action.targetSeat;
        if (p.flags.lastDreamTarget === action.targetSeat) {
          ns.dreamKill = action.targetSeat;
        }
        p.flags.dreamTarget = action.targetSeat;
      }
      if (action.type === 'wolf_kill') {
        if (WolfKill.canParticipateWolfKill(this, p) && action.targetSeat != null) {
          killVotes[action.targetSeat] = (killVotes[action.targetSeat] || 0) + 1;
        }
      }
      if (action.type === 'hidden_night') {
        if (action.kill != null && WolfKill.canParticipateWolfKill(this, p)) {
          killVotes[action.kill] = (killVotes[action.kill] || 0) + 1;
        }
        if (action.imitate != null) ns.hiddenImitate = action.imitate;
        if (action.extra != null) ns.hiddenExtraKill = action.extra;
        if (action.seer != null) ns.seerCheck = action.seer;
        if (action.mirror != null) ns.mirrorCheck = action.mirror;
        if (action.poison != null) ns.hiddenPoison = action.poison;
      }
      if (action.type === 'gargoyle_night') {
        if (action.kill != null && WolfKill.canParticipateWolfKill(this, p)) {
          killVotes[action.kill] = (killVotes[action.kill] || 0) + 1;
        }
        if (action.check != null) {
          p.flags._gargoyleCheckSeat = action.check;
        }
        if (action.convert != null) {
          ns.convertActions = ns.convertActions || [];
          ns.convertActions.push({ fromId: p.id, targetSeat: action.convert });
        }
      }
      if (action.type === 'gargoyle_check') {
        p.flags._gargoyleCheckSeat = action.targetSeat;
      }
      if (action.type === 'gargoyle_convert') {
        ns.convertActions = ns.convertActions || [];
        ns.convertActions.push({ fromId: p.id, targetSeat: action.targetSeat });
      }
      if (action.type === 'witch_save') {
        ns.witchSave = true;
      }
      if (action.type === 'witch_poison') {
        ns.witchPoisonTarget = action.targetSeat;
      }
      if (action.type === 'seer_check') {
        ns.seerCheck = action.targetSeat;
      }
      if (action.type === 'mirror_check') {
        ns.mirrorCheck = action.targetSeat;
      }
      if (action.type === 'hidden_imitate') {
        ns.hiddenImitate = action.targetSeat;
      }
      if (action.type === 'hidden_extra_kill') {
        ns.hiddenExtraKill = action.targetSeat;
      }
    }

    // 狼刀多数决（多名转化者在场则禁刀）
    if (WolfKill.isWolfKillBlocked(this)) {
      ns.wolfKill = null;
      this.addLog('系统', '场上有多名转化者，本夜狼刀未发动');
    } else {
      let max = 0;
      let winners = [];
      for (const [seat, count] of Object.entries(killVotes)) {
        if (count > max) {
          max = count;
          winners = [Number(seat)];
        } else if (count === max) {
          winners.push(Number(seat));
        }
      }
      ns.wolfKill = winners.length === 1 ? winners[0] : null;
    }

    // 石像鬼转化（整局限一次/人；目标加入狼营为转化者）
    for (const act of ns.convertActions || []) {
      const from = this.players.get(act.fromId);
      const t = this.getBySeat(act.targetSeat);
      if (!from || !t || !from.alive || !t.alive) continue;
      if (from.flags.gargoyleConvertedDone) continue;
      if (this.isWolfCamp(t) || WolfKill.isConvertor(t)) continue;
      from.flags.gargoyleConvertedDone = true;
      from.flags.convertedSeat = t.seat;
      t.flags.converted = true;
      t.flags.convertor = true;
      t.flags.justConverted = true;
      t.flags.convertedBySeat = from.seat;
      this.addLog('系统', `${from.seat} 号石像鬼完成转化（私密）`);
    }

    // 隐狼模仿（当夜结束后生效技能；立刻可知身份在 applyPrivate 中写回）
    if (ns.hiddenImitate != null) {
      const hw = [...this.players.values()].find(
        (x) => this.effectiveRole(x) === 'awakened_hidden_wolf' && x.alive
      );
      const t = this.getBySeat(ns.hiddenImitate);
      if (hw && t && !hw.flags.hiddenImitate) {
        const targetRole = this.effectiveRole(t);
        hw.flags.hiddenImitate = targetRole;
        hw.flags.lastCheck = {
          seat: t.seat,
          result: getRoleMeta(targetRole).name,
          night: this.night,
          kind: 'imitate',
        };
        if (targetRole === 'witch') {
          hw.flags.witchSave = false;
          hw.flags.witchPoison = true;
        }
        if (targetRole === 'hunter') {
          hw.flags.imitateHunter = true;
        }
        if (targetRole === 'mirror_maiden') {
          hw.flags.imitateMirror = true;
        }
        if (targetRole === 'seer') {
          hw.flags.imitateSeer = true;
        }
        // 模仿狼人角色：成为带刀狼人后可有一次性额外刀（女巫不可见）
        if (getRoleMeta(targetRole).camp === CAMP.WOLF) {
          hw.flags.hiddenExtraKnife = true;
        }
      }
    }

    // 摄梦保护
    const protectedSeat = ns.dreamTarget;
    const dreamCatcher = [...this.players.values()].find(
      (x) => this.effectiveRole(x) === 'dream_catcher' && x.alive
    );

    const killSeat = ns.wolfKill;

    const witch = [...this.players.values()].find(
      (x) => this.effectiveRole(x) === 'witch' && x.alive
    );

    // 连续摄杀：女巫无法解救
    if (ns.dreamKill != null) {
      markDead(ns.dreamKill, 'dream_kill');
    }

    // 女巫救人：若刀口被保护则解药消耗但落空；不能救连续摄杀
    let saved = false;
    if (witch && ns.witchSave && killSeat != null && witch.flags.witchSave) {
      witch.flags.witchSave = false;
      if (protectedSeat === killSeat) {
        // 落空：刀已被保护，解药仍消耗
        saved = false;
      } else if (ns.dreamKill === killSeat) {
        // 连续摄杀不可救
        saved = false;
      } else {
        saved = true;
      }
    }

    // 狼刀结算
    if (killSeat != null) {
      if (protectedSeat === killSeat) {
        // 梦游免疫，刀落空
      } else if (saved) {
        // 已救
      } else if (ns.dreamKill === killSeat) {
        // 已由连续摄杀标记
      } else {
        markDead(killSeat, 'wolf');
      }
    }

    // 隐狼额外刀：女巫不可见，不受解药影响；仍受摄梦保护
    if (ns.hiddenExtraKill != null) {
      const hw = [...this.players.values()].find(
        (x) => this.effectiveRole(x) === 'awakened_hidden_wolf' && x.alive && x.flags.hiddenExtraKnife
      );
      if (hw) {
        hw.flags.hiddenExtraKnife = false;
        const es = ns.hiddenExtraKill;
        if (protectedSeat === es) {
          // 落空
        } else if (ns.dreamKill === es) {
          // 已标记
        } else {
          markDead(es, 'hidden_extra');
        }
      }
    }

    // 女巫毒药（不可与解药同夜）；对梦游落空但仍消耗
    if (witch && ns.witchPoisonTarget != null && !ns.witchSave && witch.flags.witchPoison) {
      const ps = ns.witchPoisonTarget;
      witch.flags.witchPoison = false;
      if (protectedSeat === ps) {
        // 免疫落空
      } else {
        markDead(ps, 'poison');
        const victim = this.getBySeat(ps);
        if (victim) victim.flags.poisoned = true;
      }
    }

    // 隐狼模仿女巫的毒药
    if (ns.hiddenPoison != null) {
      const hw = [...this.players.values()].find(
        (x) => this.effectiveRole(x) === 'awakened_hidden_wolf' && x.alive && x.flags.witchPoison
      );
      if (hw) {
        hw.flags.witchPoison = false;
        const ps = ns.hiddenPoison;
        if (protectedSeat === ps) {
          // 落空
        } else {
          markDead(ps, 'poison');
          const victim = this.getBySeat(ps);
          if (victim) victim.flags.poisoned = true;
        }
      }
    }

    // 摄梦人夜间死亡连带梦游者（白天出局不带走）
    if (dreamCatcher && deaths.has(dreamCatcher.seat) && protectedSeat != null) {
      markDead(protectedSeat, 'dream_link');
    }

    // 更新摄梦记录
    if (dreamCatcher && ns.dreamTarget != null) {
      dreamCatcher.flags.lastDreamTarget = ns.dreamTarget;
    }

    // 应用死亡（白猫延迟）
    const nightDeaths = [];
    for (const [seat, reasons] of deaths.entries()) {
      const victim = this.getBySeat(seat);
      if (!victim || !victim.alive) continue;
      if (this.effectiveRole(victim) === 'white_cat' || victim.flags.inheritedRole === 'white_cat') {
        victim.flags.whiteCatPending = true;
        victim.flags.whiteCatFlipDay = this.day;
        victim.flags.deathReasons = reasons;
        nightDeaths.push({ seat, reasons, delayed: true, name: victim.name });
      } else {
        this.killPlayer(victim, reasons);
        nightDeaths.push({ seat, reasons, delayed: false, name: victim.name });
      }
    }

    // 私密查验结果存到 flags
    this.applyPrivateNightResults(ns);

    this.day += 1;
    this.phase = PHASE.DAWN;
    this.dayState = {
      nightDeaths,
      bearRoar: this.computeBearRoar(),
      votes: {},
      voted: new Set(),
      speakOrder: [],
      exileSeat: null,
      nightLastWordsDone: false,
      exileLastWordsDone: false,
      isLastWords: false,
    };

    this.announceDawn();
    this.setPhaseTimer(10000, () => this.afterDawnContinue());
  }

  /** 超时未处理的技能：警徽默认撕毁，其余丢弃 */
  expirePendingSkills() {
    for (const s of [...this.pendingSkills]) {
      if (s.type === 'police_transfer') {
        this.police.transfer(s.playerId, { abandon: true });
      }
    }
    this.pendingSkills = [];
  }

  /** 技能队列清空后按进入原因恢复流程 */
  resumeAfterSkills() {
    const resume = this.skillResume || 'night';
    this.skillResume = null;
    if (this.checkWin()) return;
    if (resume === 'after_dawn') this.afterDawnContinue();
    else if (resume === 'day_speak') this.beginDaySpeak();
    else this.beginNight();
  }

  /** 天亮播报结束后：遗言 →（第1天）上警 → 白天发言 */
  afterDawnContinue() {
    if (this.phase === PHASE.ENDED) return;
    if (this.pendingSkills.length) {
      this.skillResume = 'after_dawn';
      this.phase = PHASE.SKILL;
      this.setPhaseTimer(SKILL_MS, () => {
        this.expirePendingSkills();
        this.afterDawnContinue();
      });
      return;
    }
    // 首夜刀/毒遗言（第2夜起夜间死亡无遗言）
    if (this.dayState && !this.dayState.nightLastWordsDone) {
      const seats = this.lastWords.collectFromNightDeaths(
        this.dayState.nightDeaths,
        this.night
      );
      this.dayState.nightLastWordsDone = true;
      if (this.lastWords.begin(seats, 'after_dawn')) return;
    }
    if (this.police.shouldStartOnDawn()) {
      this.police.beginRegister();
      return;
    }
    this.beginDaySpeak();
  }

  /** 上警流程结束后进入白天发言（可带预置发言顺序） */
  beginDaySpeakAfterPolice() {
    this.beginDaySpeak();
  }

  applyPrivateNightResults(ns) {
    for (const p of this.players.values()) {
      const role = this.effectiveRole(p);
      if ((role === 'seer' || p.flags.imitateSeer) && ns.seerCheck != null) {
        const t = this.getBySeat(ns.seerCheck);
        if (t) {
          p.flags.lastCheck = {
            seat: t.seat,
            result: this.checkAsSeer(t) === CAMP.WOLF ? '狼人' : '好人',
            night: this.night,
          };
        }
      }
      if ((role === 'mirror_maiden' || p.flags.imitateMirror) && ns.mirrorCheck != null) {
        const t = this.getBySeat(ns.mirrorCheck);
        if (t) {
          p.flags.lastCheck = {
            seat: t.seat,
            result: getRoleMeta(this.effectiveRole(t)).name,
            night: this.night,
          };
        }
      }
      if (role === 'awakened_gargoyle') {
        const checkSeat = p.flags._gargoyleCheckSeat;
        if (checkSeat != null) {
          const t = this.getBySeat(checkSeat);
          if (t) {
            p.flags.lastCheck = {
              seat: t.seat,
              result: getRoleMeta(this.effectiveRole(t)).name,
              night: this.night,
            };
          }
          delete p.flags._gargoyleCheckSeat;
        }
      }
    }
  }

  computeBearRoar() {
    const bear = [...this.players.values()].find(
      (x) => this.effectiveRole(x) === 'bear' && x.alive && !x.flags.whiteCatPending
    );
    if (!bear) return false;
    const adj = this.getAdjacentSeats(bear.seat);
    return adj.some((s) => {
      const t = this.getBySeat(s);
      return t && this.isWolfCamp(t);
    });
  }

  announceDawn() {
    const ds = this.dayState;
    const msgs = [];
    msgs.push(`天亮了，第 ${this.day} 天。`);
    msgs.push(ds.bearRoar ? '熊咆哮了！' : '熊没有咆哮。');
    if (!ds.nightDeaths.length) {
      msgs.push('昨晚是平安夜。');
    } else {
      const parts = ds.nightDeaths.map((d) => {
        if (d.delayed) return `${d.seat} 号（白猫）翻牌，暂未出局`;
        return `${d.seat} 号出局`;
      });
      msgs.push(`昨晚出局：${parts.join('、')}`);
    }
    this.publicAnnouncements = msgs;
    msgs.forEach((m) => this.addLog('系统', m));
  }

  killPlayer(p, reasons) {
    const role = this.effectiveRole(p);
    // 白猫：任意出局先翻牌，延迟到「下一次」放逐投票后再真死
    if (
      (role === 'white_cat' || p.flags.inheritedRole === 'white_cat') &&
      !p.flags.whiteCatPending
    ) {
      p.flags.whiteCatPending = true;
      p.flags.whiteCatFlipDay = this.day;
      p.flags.deathReasons = reasons;
      this.addLog('系统', `${p.seat} 号白猫翻牌，将额外存活至下次放逐投票后`);
      return;
    }
    p.alive = false;
    p.flags.deathReasons = reasons;
    // 警长死亡：询问移交警徽
    if (p.flags.isPoliceChief || p.id === this.policeChiefId) {
      this.police.onChiefDying(p);
    }
    // 猎人开枪（非毒）
    const poisoned = reasons.includes('poison');
    if ((role === 'hunter' || p.flags.imitateHunter) && !poisoned) {
      this.pendingSkills.push({ type: 'hunter_shot', playerId: p.id, seat: p.seat });
    }
  }

  beginDaySpeak() {
    if (this.checkWin()) return;
    // 处理猎人等遗言技能队列
    if (this.pendingSkills.length) {
      this.skillResume = 'day_speak';
      this.phase = PHASE.SKILL;
      this.setPhaseTimer(SKILL_MS, () => {
        this.expirePendingSkills();
        this.beginDaySpeak();
      });
      return;
    }
    this.phase = PHASE.DAY_SPEAK;
    let speakOrder = this.dayState?.pendingSpeakOrder;
    if (!speakOrder || !speakOrder.length) {
      const alive = this.alivePlayers()
        .filter((p) => !p.flags.whiteCatPending)
        .sort((a, b) => a.seat - b.seat);
      speakOrder = alive.map((p) => p.seat);
    }
    // 过滤已出局
    speakOrder = speakOrder.filter((seat) => {
      const p = this.getBySeat(seat);
      return p && p.alive && !p.flags.whiteCatPending;
    });
    this.dayState.pendingSpeakOrder = null;
    this.dayState.speakOrder = speakOrder;
    this.dayState.speakIndex = 0;
    this.dayState.currentSpeakerSeat = this.dayState.speakOrder[0] || null;
    if (!this.dayState.currentSpeakerSeat) {
      this.beginVote();
      return;
    }
    this.addLog('系统', `白天发言开始：请 ${this.dayState.currentSpeakerSeat} 号发言（1分钟，可提前结束）`);
    this.setPhaseTimer(SPEAK_TURN_MS, () => this.advanceSpeak());
  }

  /** 当前发言者提前结束 / 超时进入下一位 */
  advanceSpeak() {
    if (this.phase !== PHASE.DAY_SPEAK) return;
    this.clearTimer();
    this.dayState.speakIndex += 1;
    if (this.dayState.speakIndex >= this.dayState.speakOrder.length) {
      this.dayState.currentSpeakerSeat = null;
      this.beginVote();
      return;
    }
    this.dayState.currentSpeakerSeat = this.dayState.speakOrder[this.dayState.speakIndex];
    this.addLog(
      '系统',
      `请 ${this.dayState.currentSpeakerSeat} 号发言（1分钟，可提前结束）`
    );
    this.setPhaseTimer(SPEAK_TURN_MS, () => this.advanceSpeak());
  }

  endSpeakEarly(socketId) {
    if (this.phase === PHASE.LAST_WORDS) {
      return this.lastWords.endEarly(socketId);
    }
    if (
      this.phase === PHASE.POLICE_SPEECH ||
      this.phase === PHASE.POLICE_PK_SPEECH
    ) {
      return this.police.endSpeechEarly(socketId);
    }
    if (this.phase !== PHASE.DAY_SPEAK) return { ok: false, error: '非发言阶段' };
    const p = this.players.get(socketId);
    if (!p) return { ok: false, error: '玩家无效' };
    if (p.seat !== this.dayState.currentSpeakerSeat) {
      return { ok: false, error: '只有当前发言者可以结束发言' };
    }
    this.addLog('系统', `${p.seat} 号提前结束发言`);
    this.advanceSpeak();
    return { ok: true };
  }

  /** 投票权重（放逐投票 / 可复用） */
  getVoteWeight(player) {
    return PoliceElectionService.getVoteWeight(player, this.policeChiefId);
  }

  beginVote() {
    if (this.phase === PHASE.ENDED) return;
    this.phase = PHASE.DAY_VOTE;
    this.dayState.votes = {};
    this.dayState.voted = new Set();
    this.dayState.currentSpeakerSeat = null;
    this.dayState.exileSeat = null;
    this.publicAnnouncements = ['请投票放逐一名玩家。'];
    this.addLog('系统', '发言结束，请投票放逐（先点选玩家，再点确认投票）');
    this.setPhaseTimer(VOTE_MS, () => this.resolveVote());
  }

  submitVote(socketId, targetSeat) {
    if (this.phase !== PHASE.DAY_VOTE) return { ok: false, error: '非投票阶段' };
    const p = this.players.get(socketId);
    if (!p || p.isSpectator || !p.alive || p.flags.whiteCatPending) {
      return { ok: false, error: '无法投票' };
    }
    if (targetSeat != null) {
      const t = this.getBySeat(targetSeat);
      if (!t || !t.alive) return { ok: false, error: '目标无效' };
      if (t.seat === p.seat) return { ok: false, error: '不能投自己' };
    }
    this.dayState.votes[socketId] = targetSeat; // null = 弃票
    this.dayState.voted.add(socketId);
    const need = this.alivePlayers().filter((x) => !x.flags.whiteCatPending);
    if (need.every((x) => this.dayState.voted.has(x.id))) {
      this.resolveVote();
    }
    return { ok: true, votedSeat: targetSeat };
  }

  resolveVote() {
    this.clearTimer();
    if (this.phase !== PHASE.DAY_VOTE) return;

    const tally = {};
    for (const [pid, seat] of Object.entries(this.dayState.votes)) {
      if (seat == null) continue;
      const voter = this.players.get(pid);
      const w = this.getVoteWeight(voter);
      tally[seat] = (tally[seat] || 0) + w;
    }
    let max = 0;
    let winners = [];
    for (const [seat, count] of Object.entries(tally)) {
      if (count > max) {
        max = count;
        winners = [Number(seat)];
      } else if (count === max) {
        winners.push(Number(seat));
      }
    }

    this.dayState.voteTally = tally;
    this.dayState.votersFor = {}; // seat -> [voter seats]
    for (const [pid, target] of Object.entries(this.dayState.votes)) {
      if (target == null) continue;
      if (!this.dayState.votersFor[target]) this.dayState.votersFor[target] = [];
      const voter = this.players.get(pid);
      if (voter) this.dayState.votersFor[target].push(voter.seat);
    }

    if (winners.length !== 1 || max === 0) {
      this.addLog('系统', '今日平票，无人出局');
      this.dayState.exileSeat = null;
      this.publicAnnouncements = ['今日平票，无人出局。'];
      this.afterExile();
      return;
    }

    const exileSeat = winners[0];
    this.dayState.exileSeat = exileSeat;
    const victim = this.getBySeat(exileSeat);
    if (victim) {
      this.addLog('系统', `${exileSeat} 号被放逐出局`);
      const pendingCat =
        this.effectiveRole(victim) === 'white_cat' || victim.flags.inheritedRole === 'white_cat';
      this.publicAnnouncements = pendingCat
        ? [`${exileSeat} 号（白猫）被放逐翻牌，将额外存活至下次投票后。`]
        : [`${exileSeat} 号被放逐出局。`];
      this.killPlayer(victim, ['exile']);
    } else {
      this.publicAnnouncements = [`${exileSeat} 号被放逐出局。`];
    }

    // 河豚：仅自己被放逐时可发动
    const puffer = [...this.players.values()].find(
      (x) => this.effectiveRole(x) === 'pufferfish' && !x.flags.pufferUsed
    );
    if (puffer && exileSeat === puffer.seat) {
      this.pendingSkills.push({ type: 'puffer', playerId: puffer.id, seat: puffer.seat });
    }

    this.afterExile();
  }

  afterExile() {
    // 先判定胜负（白猫翻牌中仍算存活：最后一狼出局则好人立即胜）
    if (this.checkWin()) return;

    // 再结算「上一轮及更早」翻牌的白猫（本轮刚翻牌的要等到下次投票后）
    for (const p of this.players.values()) {
      if (
        p.flags.whiteCatPending &&
        p.alive &&
        p.flags.whiteCatFlipDay != null &&
        p.flags.whiteCatFlipDay < this.day
      ) {
        p.alive = false;
        p.flags.whiteCatPending = false;
        this.addLog('系统', `${p.seat} 号白猫在投票后出局`);
        if (p.flags.isPoliceChief || p.id === this.policeChiefId) {
          this.police.onChiefDying(p);
        }
        const role = this.effectiveRole(p);
        if (role === 'hunter' && !(p.flags.deathReasons || []).includes('poison')) {
          this.pendingSkills.push({ type: 'hunter_shot', playerId: p.id, seat: p.seat });
        }
      }
    }

    if (this.checkWin()) return;

    // 白天被票出局：发表遗言
    if (this.dayState && !this.dayState.exileLastWordsDone) {
      const seats = this.lastWords.collectFromExile(this.dayState.exileSeat);
      this.dayState.exileLastWordsDone = true;
      if (this.lastWords.begin(seats, 'after_exile')) return;
    }

    if (this.pendingSkills.length) {
      this.skillResume = 'night';
      this.phase = PHASE.SKILL;
      this.setPhaseTimer(SKILL_MS, () => {
        this.expirePendingSkills();
        if (!this.checkWin()) this.beginNight();
      });
      return;
    }

    if (!this.checkWin()) {
      this.setPhaseTimer(5000, () => this.beginNight());
    }
  }

  submitSkill(socketId, action) {
    if (this.phase !== PHASE.SKILL) return { ok: false, error: '非技能阶段' };
    const pending = this.pendingSkills.find((s) => s.playerId === socketId);
    if (!pending) return { ok: false, error: '无待发动技能' };

    if (pending.type === 'hunter_shot') {
      const t = this.getBySeat(action.targetSeat);
      if (!t || !t.alive) return { ok: false, error: '目标无效' };
      this.killPlayer(t, ['hunter']);
      this.addLog('系统', `猎人开枪带走 ${t.seat} 号`);
      this.pendingSkills = this.pendingSkills.filter((s) => s.playerId !== socketId);
    }

    if (pending.type === 'puffer') {
      const p = this.players.get(socketId);
      if (!p || p.flags.pufferUsed) return { ok: false, error: '已使用' };
      if (action.type === 'puffer_explode') {
        const voters = this.dayState.votersFor[p.seat] || [];
        p.flags.pufferUsed = true;
        for (const seat of voters) {
          const v = this.getBySeat(seat);
          if (v && v.alive) {
            this.killPlayer(v, ['puffer']);
            this.addLog('系统', `河豚引爆，带走 ${seat} 号`);
          }
        }
        // 河豚自己也翻牌出局（若还活着）
        if (p.alive) {
          this.killPlayer(p, ['puffer_self']);
        }
        this.pendingSkills = this.pendingSkills.filter((s) => s.playerId !== socketId);
      } else if (action.type === 'skip') {
        this.pendingSkills = this.pendingSkills.filter((s) => s.playerId !== socketId);
      }
    }

    if (pending.type === 'police_transfer') {
      const res = this.police.transfer(socketId, {
        targetSeat: action.targetSeat,
        abandon: action.type === 'police_abandon' || action.abandon,
      });
      if (!res.ok) return res;
    }

    if (!this.pendingSkills.length) {
      this.clearTimer();
      this.resumeAfterSkills();
    }
    return { ok: true };
  }

  /** —— 上警 API（委托 PoliceElectionService） —— */
  policeRegister(socketId, want) {
    return this.police.register(socketId, want);
  }

  policeWithdraw(socketId, leave) {
    return this.police.withdraw(socketId, leave);
  }

  policeVote(socketId, targetSeat) {
    return this.police.vote(socketId, targetSeat);
  }

  policeChooseOrder(socketId, mode) {
    return this.police.chooseSpeakOrder(socketId, mode);
  }

  checkWin() {
    const alive = this.alivePlayers(); // whiteCatPending still counts as alive
    const wolves = alive.filter((p) => this.isWolfCamp(p));
    const goods = alive.filter((p) => !this.isWolfCamp(p));
    if (wolves.length === 0) {
      this.endGame('village');
      return true;
    }
    if (wolves.length >= goods.length) {
      this.endGame('wolf');
      return true;
    }
    return false;
  }

  endGame(winner) {
    this.clearTimer();
    this.phase = PHASE.ENDED;
    this.winner = winner;
    const msg =
      winner === 'admin'
        ? '管理员强制结束本局'
        : winner === 'wolf'
          ? '狼人阵营胜利！'
          : '好人阵营胜利！';
    this.addLog('系统', msg);
    const announcements = [msg];

    // 暗恋者个人胜负：跟随暗恋对象阵营
    if (winner === 'wolf' || winner === 'village') {
      for (const p of this.players.values()) {
        if (p.roleId !== 'admirer') continue;
        const crushSeat = p.flags.idol;
        if (crushSeat == null) {
          announcements.push(`${p.seat} 号暗恋者未指定对象（个人失败）`);
          continue;
        }
        const crush = this.getBySeat(crushSeat);
        if (!crush) {
          announcements.push(`${p.seat} 号暗恋者对象已不在（个人失败）`);
          continue;
        }
        const crushWolf = this.isWolfCamp(crush);
        const admirerWins =
          (winner === 'wolf' && crushWolf) || (winner === 'village' && !crushWolf);
        announcements.push(
          `${p.seat} 号暗恋者暗恋 ${crushSeat} 号：个人${admirerWins ? '胜利' : '失败'}`
        );
      }
    }

    this.publicAnnouncements = announcements;
  }

  /** 管理员强制结束（测试用） */
  adminForceEnd() {
    if (this.phase === PHASE.LOBBY) {
      return { ok: false, error: '尚未开局' };
    }
    if (this.phase === PHASE.ENDED) {
      return { ok: false, error: '对局已结束' };
    }
    this.pendingSkills = [];
    this.endGame('admin');
    return { ok: true };
  }

  addChat(socketId, text) {
    const p = this.players.get(socketId);
    if (!p || !text) return null;
    const msg = {
      from: p.name,
      seat: p.isSpectator ? null : p.seat,
      text: String(text).slice(0, 200),
      at: Date.now(),
      system: false,
      spectator: !!p.isSpectator,
    };
    this.logs.push(msg);
    return msg;
  }

  addLog(from, text) {
    this.logs.push({ from, seat: null, text, at: Date.now(), system: true });
    if (this.logs.length > 200) this.logs.shift();
  }

  /** 面向某玩家的视图 */
  getPublicState(forSocketId) {
    const me = this.players.get(forSocketId);
    const isSpec = !!(me && me.isSpectator);

    const players = this.seatedPlayers()
      .sort((a, b) => a.seat - b.seat)
      .map((p) => {
        const base = {
          seat: p.seat,
          name: p.name,
          alive: p.alive,
          ready: p.ready,
          connected: p.connected,
          isSpectator: false,
          isBot: String(p.id).startsWith('bot_'),
          whiteCatPending: !!p.flags?.whiteCatPending,
          isPoliceChief: !!p.flags?.isPoliceChief || p.id === this.policeChiefId,
        };
        // 终局全员可见身份；自己可见；观战者终局可见
        if (this.phase === PHASE.ENDED || (me && p.id === me.id && !isSpec)) {
          base.roleId = this.effectiveRole(p);
          base.roleName = getRoleMeta(this.effectiveRole(p)).name;
          base.camp = this.isWolfCamp(p) ? CAMP.WOLF : CAMP.VILLAGE;
        }
        if (me && !isSpec && me.id !== p.id && this.canSeeAsTeammate(me, p)) {
          if (WolfKill.isConvertor(p) && !WolfKill.isGargoyle(this, p)) {
            base.roleId = 'convertor';
            base.roleName = '转化者';
            base.camp = CAMP.WOLF;
          } else {
            base.roleId = this.effectiveRole(p);
            base.roleName = getRoleMeta(this.effectiveRole(p)).name;
            base.camp = this.isWolfCamp(p) ? CAMP.WOLF : CAMP.VILLAGE;
          }
          base.teammate = true;
          if (!p.alive) base.deadTeammate = true;
        }
        return base;
      });

    const spectators = [...this.players.values()]
      .filter((p) => p.isSpectator)
      .map((p) => ({
        name: p.name,
        connected: p.connected,
        isSpectator: true,
      }));

    const emptySeats = [];
    const used = new Set(players.map((p) => p.seat));
    for (let i = 1; i <= this.maxPlayers; i++) {
      if (!used.has(i)) emptySeats.push(i);
    }

    const board = getBoard(this.boardId);
    const state = {
      code: this.code,
      phase: this.phase,
      day: this.day,
      night: this.night,
      hostId: this.hostId,
      players,
      spectators,
      emptySeats,
      seatedCount: players.length,
      announcements: this.publicAnnouncements,
      dawnReport:
        this.phase === PHASE.DAWN && this.dayState
          ? {
              day: this.day,
              bearRoar: !!this.dayState.bearRoar,
              deaths: (this.dayState.nightDeaths || []).map((d) => ({
                seat: d.seat,
                name: d.name,
                delayed: !!d.delayed,
                reasons: d.reasons || [],
              })),
            }
          : null,
      logs: this.logs.slice(-80),
      timerEndsAt: this.timerEndsAt,
      winner: this.winner,
      maxPlayers: this.maxPlayers,
      board: board.name,
      boardId: this.boardId,
      rulesNote: board.rulesNote,
      canStart: this.canStart(),
      me: null,
      nightHint: null,
      pendingSkill: null,
      voteTally: this.dayState?.voteTally || null,
      currentSpeakerSeat: this.dayState?.currentSpeakerSeat ?? null,
      currentSpeakerName:
        this.dayState?.currentSpeakerSeat != null
          ? this.getBySeat(this.dayState.currentSpeakerSeat)?.name || null
          : null,
      speakOrder: this.dayState?.speakOrder || [],
      police: this.police.getPublicSnapshot(),
      policeChiefSeat: this.police.getPublicSnapshot().policeChiefSeat,
      lastWords: this.lastWords.getPublicSnapshot(),
      isLastWords: this.phase === PHASE.LAST_WORDS || !!this.dayState?.isLastWords,
      voicePolicy: this.getVoicePolicy(forSocketId),
    };

    if (me) {
      const policePriv = this.police.getPrivateSnapshot(me.id);
      const hasVoted =
        this.phase === PHASE.DAY_VOTE && !!this.dayState?.voted?.has(me.id);
      const roleId = me.isSpectator ? null : this.effectiveRole(me);
      state.me = {
        id: me.id,
        seat: me.seat,
        name: me.name,
        alive: me.alive,
        isSpectator: !!me.isSpectator,
        roleId,
        roleName: roleId ? getRoleMeta(roleId).name : me.isSpectator ? '观战中' : '—',
        camp: me.isSpectator ? null : this.isWolfCamp(me) ? CAMP.WOLF : CAMP.VILLAGE,
        originalRoleId: me.roleId,
        flags: me.isSpectator ? {} : this.sanitizeFlags(me),
        lastCheck: me.flags?.lastCheck || null,
        wolfIntel: me.isSpectator ? null : WolfKill.getSoleConvertorIntel(this, me),
        needsNightAction:
          !me.isSpectator &&
          this.phase === PHASE.NIGHT &&
          me.alive &&
          this.needsNightAction(me) &&
          !this.nightState?.submitted?.has(me.id),
        wolfKillHint: this.nightState?.wolfKill ?? null,
        adjacentSeats: me.seat != null ? this.getAdjacentSeats(me.seat) : [],
        isHost: me.id === this.hostId,
        isCurrentSpeaker: !me.isSpectator && me.seat === this.dayState?.currentSpeakerSeat,
        hasVoted,
        myVote: hasVoted ? this.dayState.votes[me.id] : undefined,
        whiteCatPending: !!me.flags?.whiteCatPending,
        isPoliceChief: !!me.flags?.isPoliceChief || me.id === this.policeChiefId,
        canSelfDestruct:
          !me.isSpectator &&
          me.alive &&
          this.effectiveRole(me) === 'awakened_gargoyle' &&
          [
            PHASE.DAWN,
            PHASE.DAY_SPEAK,
            PHASE.DAY_VOTE,
            PHASE.SKILL,
            PHASE.POLICE_REGISTER,
            PHASE.POLICE_SPEECH,
            PHASE.POLICE_WITHDRAW,
            PHASE.POLICE_VOTE,
            PHASE.POLICE_PK_SPEECH,
            PHASE.POLICE_RESULT,
            PHASE.POLICE_ORDER,
            PHASE.LAST_WORDS,
          ].includes(this.phase),
        ...policePriv,
      };

      if (this.phase === PHASE.NIGHT && me.alive && !me.isSpectator) {
        state.nightHint = this.getNightHint(me);
      }
      if (this.phase === PHASE.SKILL && !me.isSpectator) {
        const pending = this.pendingSkills.find((s) => s.playerId === me.id);
        if (pending) state.pendingSkill = pending;
      }
    }

    return state;
  }

  canSeeAsTeammate(me, other) {
    if (!me || !other || me.id === other.id) return false;
    // 石像鬼互相可见
    if (WolfKill.isGargoyle(this, me) && WolfKill.isGargoyle(this, other)) {
      return true;
    }
    // 石像鬼可见自己转化的对象
    if (
      WolfKill.isGargoyle(this, me) &&
      me.flags.convertedSeat != null &&
      other.seat === me.flags.convertedSeat
    ) {
      return true;
    }
    // 末转化者可见两位石像鬼（含已出局）与其他转化者
    if (WolfKill.isSoleLivingConvertor(this, me)) {
      if (WolfKill.isGargoyle(this, other)) return true;
      if (WolfKill.isConvertor(other) && other.id !== me.id) return true;
    }
    return false;
  }

  sanitizeFlags(me) {
    return {
      witchSave: me.flags.witchSave,
      witchPoison: me.flags.witchPoison,
      convertor: me.flags.convertor,
      justConverted: !!me.flags.justConverted,
      becomeWolf: me.flags.becomeWolf,
      idol: me.flags.idol,
      inheritedRole: me.flags.inheritedRole,
      pufferUsed: me.flags.pufferUsed,
      hiddenAwakened: this.effectiveRole(me) === 'awakened_hidden_wolf' && this.hiddenCanKill(),
      canConvertedKill: this.canConvertedKill(me),
      canWolfKill: WolfKill.canParticipateWolfKill(this, me),
      wolfKillBlocked: WolfKill.isWolfKillBlocked(this),
      lastDreamTarget: me.flags.lastDreamTarget,
      gargoyleConvertedDone: me.flags.gargoyleConvertedDone,
      convertedSeat: me.flags.convertedSeat ?? null,
      convertedBySeat: me.flags.convertedBySeat ?? null,
      imitateHunter: !!me.flags.imitateHunter,
      imitateMirror: !!me.flags.imitateMirror,
      imitateSeer: !!me.flags.imitateSeer,
      hiddenExtraKnife: !!me.flags.hiddenExtraKnife,
      hiddenImitate: me.flags.hiddenImitate,
      isPoliceChief: !!me.flags.isPoliceChief,
    };
  }

  getNightHint(me) {
    const role = this.effectiveRole(me);
    const hints = [];
    if (role === 'admirer' && this.night === 1) hints.push('请指定暗恋对象');
    if (role === 'dream_catcher') hints.push('请选择梦游者（每晚必须）');
    if (role === 'awakened_gargoyle') {
      hints.push('请查验一名玩家的具体身份');
      hints.push('可与另一石像鬼语音沟通战术（其他玩家强制闭麦）');
      if (WolfKill.canParticipateWolfKill(this, me)) {
        hints.push('可选：提交刀人目标（两石像鬼多数决）');
      }
      if (!me.flags.gargoyleConvertedDone) {
        hints.push('可选：转化一名好人（整局限一次，你可见该对象）');
      }
    }
    if (WolfKill.isConvertor(me) && role !== 'awakened_gargoyle') {
      if (WolfKill.isWolfKillBlocked(this)) {
        hints.push('场上有多名转化者，本夜无法发动狼刀');
      } else if (WolfKill.canParticipateWolfKill(this, me)) {
        hints.push('两位石像鬼已出局且仅剩你一名转化者：你可以刀人');
      } else {
        hints.push('转化者：等待石像鬼出局且仅剩一名转化者时可刀人');
      }
    }
    if (role === 'awakened_hidden_wolf') {
      if (!me.flags.hiddenImitate) hints.push('可模仿一名玩家（立刻知其身份，当夜结束后获技能）');
      else hints.push(`已模仿：${getRoleMeta(me.flags.hiddenImitate)?.name || me.flags.hiddenImitate}（可知其身份）`);
      if (this.hiddenCanKill()) hints.push('其余狼人已出局，你可以刀人');
      if (me.flags.hiddenExtraKnife) hints.push('你有一次额外刀（女巫不可见）');
      if (me.flags.imitateMirror) hints.push('可查验一名玩家身份');
      if (me.flags.imitateSeer) hints.push('可查验一名玩家阵营');
      hints.push('完成后请点「确认结束夜间行动」');
    }
    if (role === 'witch') {
      const kill = this.nightState?.wolfKill;
      hints.push(kill != null ? `今晚刀口：${kill} 号，可救人/毒人` : '等待刀口信息…（提交行动时可见）');
    }
    if (role === 'seer') hints.push('请查验一名玩家阵营');
    if (role === 'mirror_maiden' || me.flags.imitateMirror) hints.push('请查验一名玩家身份');
    return hints;
  }
}

module.exports = { GameRoom, PHASE, PolicePhase, SpeakOrderMode };
