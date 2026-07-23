/**
 * 上警竞选服务（模块化）
 * 由 GameRoom 持有并委托调用，不直接操作 Socket。
 */

const { PoliceEvents, PoliceEventBus } = require('./PoliceEvents');
const {
  PolicePhase,
  SpeakOrderMode,
  POLICE_REGISTER_MS,
  POLICE_WITHDRAW_MS,
  POLICE_VOTE_MS,
  POLICE_ORDER_MS,
  POLICE_RESULT_MS,
} = require('./PolicePhases');

class PoliceElectionService {
  /**
   * @param {object} room GameRoom 实例（需提供 players/getBySeat/alivePlayers/addLog/setPhaseTimer/clearTimer 等）
   */
  constructor(room) {
    this.room = room;
    this.bus = new PoliceEventBus();
    this.reset();
  }

  reset() {
    this.active = false;
    this.doneForDay1 = false;
    this.subPhase = null;
    this.registrations = new Map(); // playerId -> true(上警) | false(不上)
    this.candidates = []; // seat[] 仍在竞选
    this.withdrawn = new Set(); // playerId
    this.speechOrder = [];
    this.speechIndex = 0;
    this.votes = {}; // voterId -> targetSeat | null
    this.voted = new Set();
    this.tieRound = 0; // 0 首次投票，1 平票后再投
    this.pkSeats = []; // 平票座位
    this.electedSeat = null;
    this.pendingTransfer = null; // { fromId, fromSeat }
  }

  /** 投票权重：普通 1，警长 1.5（放逐票用，预留扩展） */
  static getVoteWeight(player, policeChiefId) {
    if (!player) return 1;
    if (player.flags?.isPoliceChief || player.id === policeChiefId) return 1.5;
    return 1;
  }

  getVoteWeight(player) {
    return PoliceElectionService.getVoteWeight(player, this.room.policeChiefId);
  }

  /** 第一天天亮后是否应启动上警 */
  shouldStartOnDawn() {
    return this.room.day === 1 && !this.doneForDay1;
  }

  /** 进入报名 */
  beginRegister() {
    this.reset();
    this.active = true;
    this.subPhase = PolicePhase.REGISTER;
    this.room.phase = PolicePhase.REGISTER;
    this.room.publicAnnouncements = ['天亮了。请决定是否上警竞选警长。'];
    this.room.addLog('系统', '【上警】报名开始：请选择「上警」或「不上警」');
    this.bus.emit(PoliceEvents.PlayerRegisterPolice, { stage: 'start' });
    this.room.setPhaseTimer(POLICE_REGISTER_MS, () => this.finishRegister());
  }

  register(socketId, want) {
    if (this.subPhase !== PolicePhase.REGISTER) {
      return { ok: false, error: '非上警报名阶段' };
    }
    const p = this.room.players.get(socketId);
    if (!p || p.isSpectator || !p.alive || p.flags.whiteCatPending) {
      return { ok: false, error: '无法报名' };
    }
    if (this.registrations.has(socketId)) {
      return { ok: false, error: '已选择过，不可更改' };
    }
    this.registrations.set(socketId, !!want);
    this.bus.emit(PoliceEvents.PlayerRegisterPolice, {
      playerId: socketId,
      seat: p.seat,
      want: !!want,
    });
    this.room.addLog('系统', `${p.seat} 号选择了${want ? '上警' : '不上警'}`);

    const need = this._aliveVoters();
    if (need.every((x) => this.registrations.has(x.id))) {
      this.finishRegister();
    }
    return { ok: true };
  }

  finishRegister() {
    if (this.subPhase !== PolicePhase.REGISTER) return;
    this.room.clearTimer();

    // 未选择的视为不上警
    for (const p of this._aliveVoters()) {
      if (!this.registrations.has(p.id)) this.registrations.set(p.id, false);
    }

    this.candidates = [...this.registrations.entries()]
      .filter(([, want]) => want)
      .map(([id]) => this.room.players.get(id))
      .filter((p) => p && p.alive)
      .sort((a, b) => a.seat - b.seat)
      .map((p) => p.seat);

    if (this.candidates.length === 0) {
      this.room.addLog('系统', '【上警】无人上警，本局暂无警长');
      this.room.publicAnnouncements = ['无人上警，跳过警长竞选。'];
      this.bus.emit(PoliceEvents.PoliceSkipped, { reason: 'no_candidate' });
      this._finishWithoutChief();
      return;
    }

    if (this.candidates.length === 1) {
      this._elect(this.candidates[0], 'sole');
      return;
    }

    this.beginSpeech(this.candidates);
  }

  beginSpeech(seats, isPk = false) {
    this.subPhase = isPk ? PolicePhase.PK_SPEECH : PolicePhase.SPEECH;
    this.room.phase = this.subPhase;
    this.speechOrder = [...seats];
    this.speechIndex = 0;
    this.room.dayState = this.room.dayState || {};
    this.room.dayState.currentSpeakerSeat = this.speechOrder[0];
    this.room.publicAnnouncements = [
      isPk
        ? `平票 PK 发言：${seats.join('、')} 号依次发言。`
        : `上警发言：共 ${seats.length} 人竞选，按座位号依次发言。`,
    ];
    this.room.addLog(
      '系统',
      `【上警】${isPk ? 'PK ' : ''}发言开始，请 ${this.speechOrder[0]} 号发言`
    );
    this.bus.emit(PoliceEvents.PoliceSpeechStart, {
      seats: this.speechOrder,
      isPk: !!isPk,
    });
    this.room.setPhaseTimer(60000, () => this.advanceSpeech());
  }

  advanceSpeech() {
    if (this.subPhase !== PolicePhase.SPEECH && this.subPhase !== PolicePhase.PK_SPEECH) {
      return;
    }
    this.room.clearTimer();
    this.speechIndex += 1;
    if (this.speechIndex >= this.speechOrder.length) {
      this.room.dayState.currentSpeakerSeat = null;
      this.bus.emit(PoliceEvents.PoliceSpeechEnd, {});
      if (this.subPhase === PolicePhase.PK_SPEECH) {
        this.beginVote(true);
      } else {
        this.beginWithdraw();
      }
      return;
    }
    this.room.dayState.currentSpeakerSeat = this.speechOrder[this.speechIndex];
    this.room.addLog(
      '系统',
      `【上警】请 ${this.room.dayState.currentSpeakerSeat} 号发言`
    );
    this.room.setPhaseTimer(60000, () => this.advanceSpeech());
  }

  endSpeechEarly(socketId) {
    if (this.subPhase !== PolicePhase.SPEECH && this.subPhase !== PolicePhase.PK_SPEECH) {
      return { ok: false, error: '非上警发言阶段' };
    }
    const p = this.room.players.get(socketId);
    if (!p || p.seat !== this.room.dayState?.currentSpeakerSeat) {
      return { ok: false, error: '只有当前发言者可结束' };
    }
    this.room.addLog('系统', `${p.seat} 号结束上警发言`);
    this.advanceSpeech();
    return { ok: true };
  }

  beginWithdraw() {
    this.subPhase = PolicePhase.WITHDRAW;
    this.room.phase = PolicePhase.WITHDRAW;
    this.room.dayState.currentSpeakerSeat = null;
    this.room.publicAnnouncements = ['退水阶段：上警玩家可选择继续竞选或退水。'];
    this.room.addLog('系统', '【上警】退水阶段开始');
    this.room.setPhaseTimer(POLICE_WITHDRAW_MS, () => this.finishWithdraw());
  }

  withdraw(socketId, leave) {
    if (this.subPhase !== PolicePhase.WITHDRAW) {
      return { ok: false, error: '非退水阶段' };
    }
    const p = this.room.players.get(socketId);
    if (!p || !p.alive) return { ok: false, error: '无法操作' };
    if (!this.candidates.includes(p.seat)) {
      return { ok: false, error: '你不在竞选名单' };
    }
    if (this.withdrawn.has(socketId)) {
      return { ok: false, error: '已操作过' };
    }
    // leave=true 退水；false=继续
    this.withdrawn.add(socketId);
    if (leave) {
      this.candidates = this.candidates.filter((s) => s !== p.seat);
      this.bus.emit(PoliceEvents.PlayerWithdrawPolice, { seat: p.seat, playerId: socketId });
      this.room.addLog('系统', `${p.seat} 号退水`);
    } else {
      this.room.addLog('系统', `${p.seat} 号继续竞选`);
    }

    if (this.candidates.length <= 1) {
      this.finishWithdraw();
      return { ok: true };
    }

    // 全部候选人都已表态
    const candPlayers = this.candidates
      .map((s) => this.room.getBySeat(s))
      .filter(Boolean);
    if (candPlayers.every((c) => this.withdrawn.has(c.id))) {
      this.finishWithdraw();
    }
    return { ok: true };
  }

  finishWithdraw() {
    if (this.subPhase !== PolicePhase.WITHDRAW) return;
    this.room.clearTimer();

    if (this.candidates.length === 0) {
      this.room.addLog('系统', '【上警】全部退水，本局无警长');
      this.room.publicAnnouncements = ['竞选者全部退水，本局无警长。'];
      this.bus.emit(PoliceEvents.PoliceSkipped, { reason: 'all_withdrawn' });
      this._finishWithoutChief();
      return;
    }
    if (this.candidates.length === 1) {
      this._elect(this.candidates[0], 'after_withdraw');
      return;
    }
    this.beginVote(false);
  }

  beginVote(isPk) {
    this.subPhase = PolicePhase.VOTE;
    this.room.phase = PolicePhase.VOTE;
    this.votes = {};
    this.voted = new Set();
    this.room.dayState.currentSpeakerSeat = null;
    const tip = isPk
      ? '平票 PK 投票：请在平票玩家中投票（候选人不可投自己）。'
      : '警长投票：请投票给竞选者（候选人不可投自己，可弃票）。';
    this.room.publicAnnouncements = [tip];
    this.room.addLog('系统', `【上警】${isPk ? 'PK ' : ''}投票开始`);
    this.bus.emit(PoliceEvents.PoliceVoteStart, {
      candidates: [...this.candidates],
      isPk: !!isPk,
    });
    this.room.setPhaseTimer(POLICE_VOTE_MS, () => this.resolveVote());
  }

  vote(socketId, targetSeat) {
    if (this.subPhase !== PolicePhase.VOTE) {
      return { ok: false, error: '非警长投票阶段' };
    }
    const p = this.room.players.get(socketId);
    if (!p || p.isSpectator || !p.alive || p.flags.whiteCatPending) {
      return { ok: false, error: '无法投票' };
    }
    if (this.voted.has(socketId)) {
      return { ok: false, error: '已投票' };
    }
    if (targetSeat != null) {
      if (!this.candidates.includes(targetSeat)) {
        return { ok: false, error: '只能投给竞选者' };
      }
      if (p.seat === targetSeat) {
        return { ok: false, error: '候选人不能投自己' };
      }
    }
    this.votes[socketId] = targetSeat;
    this.voted.add(socketId);
    this.bus.emit(PoliceEvents.PlayerVotePolice, {
      voterSeat: p.seat,
      targetSeat,
    });

    const need = this._aliveVoters();
    if (need.every((x) => this.voted.has(x.id))) {
      this.resolveVote();
    }
    return { ok: true };
  }

  resolveVote() {
    if (this.subPhase !== PolicePhase.VOTE) return;
    this.room.clearTimer();

    const tally = {};
    for (const [pid, seat] of Object.entries(this.votes)) {
      if (seat == null) continue;
      const voter = this.room.players.get(pid);
      const w = this.getVoteWeight(voter);
      tally[seat] = (tally[seat] || 0) + w;
    }

    let max = 0;
    let winners = [];
    for (const [seat, count] of Object.entries(tally)) {
      const s = Number(seat);
      if (count > max) {
        max = count;
        winners = [s];
      } else if (count === max) {
        winners.push(s);
      }
    }

    // 全弃票 / 无人得票 → 视为平票无警长（或全候选平）
    if (max === 0) {
      winners = [...this.candidates];
    }

    if (winners.length === 1) {
      this._elect(winners[0], this.tieRound > 0 ? 'pk_vote' : 'vote');
      return;
    }

    // 平票
    if (this.tieRound >= 1) {
      this.room.addLog('系统', '【上警】再次平票，本局无警长');
      this.room.publicAnnouncements = ['警长竞选再次平票，本局无警长。'];
      this.bus.emit(PoliceEvents.PoliceSkipped, { reason: 'double_tie' });
      this._finishWithoutChief();
      return;
    }

    this.tieRound = 1;
    this.pkSeats = winners.filter((s) => this.candidates.includes(s));
    this.candidates = [...this.pkSeats];
    this.room.addLog(
      '系统',
      `【上警】平票：${this.pkSeats.join('、')} 号进入 PK 发言`
    );
    this.beginSpeech(this.pkSeats, true);
  }

  _elect(seat, reason) {
    const p = this.room.getBySeat(seat);
    if (!p) {
      this._finishWithoutChief();
      return;
    }
    this.electedSeat = seat;
    this.room.policeChiefId = p.id;
    p.flags.isPoliceChief = true;
    this.subPhase = PolicePhase.RESULT;
    this.room.phase = PolicePhase.RESULT;
    this.room.dayState.currentSpeakerSeat = null;
    this.room.publicAnnouncements = [`${seat} 号当选警长！`];
    this.room.addLog('系统', `【上警】${seat} 号当选警长（${reason}）`);
    this.bus.emit(PoliceEvents.PoliceElected, { seat, playerId: p.id, reason });
    this.room.setPhaseTimer(POLICE_RESULT_MS, () => this.beginOrderSelect());
  }

  beginOrderSelect() {
    if (!this.room.policeChiefId) {
      this._goDaySpeak();
      return;
    }
    this.subPhase = PolicePhase.ORDER;
    this.room.phase = PolicePhase.ORDER;
    this.room.publicAnnouncements = ['请警长选择白天发言顺序。'];
    this.room.addLog('系统', '【上警】请警长选择发言顺序');
    this.room.setPhaseTimer(POLICE_ORDER_MS, () => {
      // 超时默认顺时针
      this.chooseSpeakOrder(this.room.policeChiefId, SpeakOrderMode.CLOCKWISE);
    });
  }

  chooseSpeakOrder(socketId, mode) {
    if (this.subPhase !== PolicePhase.ORDER) {
      return { ok: false, error: '非选序阶段' };
    }
    if (socketId !== this.room.policeChiefId) {
      return { ok: false, error: '仅警长可选择发言顺序' };
    }
    const allowed = Object.values(SpeakOrderMode);
    if (!allowed.includes(mode)) {
      return { ok: false, error: '无效顺序' };
    }
    this.room.clearTimer();
    const order = this.buildSpeakOrder(mode);
    this.room.dayState.policeSpeakOrderMode = mode;
    this.room.dayState.pendingSpeakOrder = order;
    this.bus.emit(PoliceEvents.PoliceOrderChosen, { mode, order });
    this.room.addLog('系统', `警长选择发言顺序：${mode}`);
    this._goDaySpeak();
    return { ok: true, order };
  }

  /**
   * 根据警长选择构建发言座位序列（存活且非白猫延迟）
   */
  buildSpeakOrder(mode) {
    const alive = this.room
      .alivePlayers()
      .filter((p) => !p.flags.whiteCatPending)
      .sort((a, b) => a.seat - b.seat);
    const seats = alive.map((p) => p.seat);
    if (!seats.length) return [];

    const chief = this.room.players.get(this.room.policeChiefId);
    const chiefSeat = chief?.seat;
    const n = seats.length;

    const rotateFrom = (startSeat, reverse) => {
      let idx = seats.indexOf(startSeat);
      if (idx < 0) idx = 0;
      const out = [];
      for (let i = 0; i < n; i++) {
        const j = reverse ? (idx - i + n) % n : (idx + i) % n;
        out.push(seats[j]);
      }
      return out;
    };

    if (mode === SpeakOrderMode.COUNTERCLOCKWISE && chiefSeat != null) {
      // 从警长右边开始逆时针（座位号递减）
      const idx = seats.indexOf(chiefSeat);
      const start = seats[(idx - 1 + n) % n];
      return rotateFrom(start, true);
    }
    // CLOCKWISE：从警长左边开始顺时针（座位号递增）
    if (chiefSeat != null) {
      const idx = seats.indexOf(chiefSeat);
      const start = seats[(idx + 1) % n];
      return rotateFrom(start, false);
    }
    return seats;
  }

  _finishWithoutChief() {
    this.room.policeChiefId = null;
    this.doneForDay1 = true;
    this.active = false;
    this.subPhase = null;
    this._goDaySpeak();
  }

  _goDaySpeak() {
    this.doneForDay1 = true;
    this.active = false;
    this.subPhase = null;
    // 将预计算发言顺序交给 beginDaySpeak
    this.room.beginDaySpeakAfterPolice();
  }

  /** 警长死亡：进入移交 */
  onChiefDying(player) {
    if (!player?.flags?.isPoliceChief) return false;
    if (player.id !== this.room.policeChiefId) return false;
    this.pendingTransfer = { fromId: player.id, fromSeat: player.seat };
    this.room.pendingSkills.push({
      type: 'police_transfer',
      playerId: player.id,
      seat: player.seat,
    });
    this.bus.emit(PoliceEvents.PoliceTransfer, { stage: 'ask', seat: player.seat });
    return true;
  }

  transfer(socketId, { targetSeat, abandon }) {
    const pending = this.room.pendingSkills.find(
      (s) => s.type === 'police_transfer' && s.playerId === socketId
    );
    if (!pending) return { ok: false, error: '无待移交警徽' };

    const from = this.room.players.get(socketId);
    if (from) {
      from.flags.isPoliceChief = false;
    }

    if (abandon || targetSeat == null) {
      this.room.policeChiefId = null;
      this.room.addLog('系统', '警徽撕毁，本局无警长');
      this.bus.emit(PoliceEvents.PoliceRemoved, { reason: 'abandon' });
    } else {
      const t = this.room.getBySeat(targetSeat);
      if (!t || !t.alive || t.flags.whiteCatPending) {
        return { ok: false, error: '移交目标无效' };
      }
      if (t.id === socketId) {
        return { ok: false, error: '不能移交给自己' };
      }
      this.room.policeChiefId = t.id;
      t.flags.isPoliceChief = true;
      this.room.addLog('系统', `警徽移交给 ${t.seat} 号`);
      this.bus.emit(PoliceEvents.PoliceTransfer, {
        stage: 'done',
        toSeat: t.seat,
        toId: t.id,
      });
    }

    this.pendingTransfer = null;
    this.room.pendingSkills = this.room.pendingSkills.filter(
      (s) => !(s.type === 'police_transfer' && s.playerId === socketId)
    );
    return { ok: true };
  }

  _aliveVoters() {
    return this.room.alivePlayers().filter((p) => !p.flags.whiteCatPending);
  }

  /** 公开快照（断线重连） */
  getPublicSnapshot() {
    if (!this.subPhase && !this.room.policeChiefId) {
      return {
        active: false,
        policeChiefSeat: null,
        candidates: [],
      };
    }
    const chief = this.room.policeChiefId
      ? this.room.players.get(this.room.policeChiefId)
      : null;
    return {
      active: this.active || !!this.subPhase,
      subPhase: this.subPhase,
      candidates: [...this.candidates],
      speechOrder: [...this.speechOrder],
      speechIndex: this.speechIndex,
      tieRound: this.tieRound,
      pkSeats: [...this.pkSeats],
      electedSeat: this.electedSeat,
      policeChiefSeat: chief?.seat ?? null,
      policeChiefId: this.room.policeChiefId,
      speakOrderModes: SpeakOrderMode,
      pendingTransfer: this.pendingTransfer,
    };
  }

  getPrivateSnapshot(socketId) {
    const p = this.room.players.get(socketId);
    if (!p) return {};
    const snap = {
      hasRegistered: this.registrations.has(socketId),
      registerChoice: this.registrations.has(socketId)
        ? this.registrations.get(socketId)
        : undefined,
      hasWithdrawnAction: this.withdrawn.has(socketId),
      hasPoliceVoted: this.voted.has(socketId),
      myPoliceVote: this.voted.has(socketId) ? this.votes[socketId] : undefined,
      isCandidate: this.candidates.includes(p.seat),
      isPoliceChief: !!p.flags.isPoliceChief,
      canTransfer: !!this.room.pendingSkills.find(
        (s) => s.type === 'police_transfer' && s.playerId === socketId
      ),
    };
    return snap;
  }
}

module.exports = {
  PoliceElectionService,
  PolicePhase,
  SpeakOrderMode,
  PoliceEvents,
};
