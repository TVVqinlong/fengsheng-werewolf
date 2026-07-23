/**
 * 遗言规则服务（网易风声常见规则）
 * - 首夜：狼刀 / 女巫毒 → 有遗言
 * - 白天放逐 → 有遗言
 * - 第 2 夜及以后：夜间死亡 → 无遗言
 */

const LAST_WORDS_MS = 60000;

/** 夜间致死原因：仅首夜可遗言 */
const NIGHT_LAST_WORD_REASONS = new Set(['wolf', 'poison', 'hidden_extra']);

class LastWordsService {
  constructor(room) {
    this.room = room;
    this.reset();
  }

  reset() {
    this.active = false;
    this.order = [];
    this.index = 0;
    this.resume = null; // 'after_dawn' | 'after_exile'
  }

  /** 首夜夜间死亡是否有遗言 */
  static qualifiesNightDeath(reasons, nightNumber) {
    if (nightNumber !== 1) return false;
    const list = reasons || [];
    return list.some((r) => NIGHT_LAST_WORD_REASONS.has(r));
  }

  /** 白天放逐是否有遗言（一律有） */
  static qualifiesExile() {
    return true;
  }

  /**
   * 从天亮 nightDeaths 收集遗言座位（按座位号）
   * @param {number} nightNumber 刚结束的夜晚编号（resolveNight 后仍为该夜）
   */
  collectFromNightDeaths(nightDeaths, nightNumber) {
    const seats = [];
    for (const d of nightDeaths || []) {
      if (!LastWordsService.qualifiesNightDeath(d.reasons, nightNumber)) continue;
      seats.push(d.seat);
    }
    return [...new Set(seats)].sort((a, b) => a - b);
  }

  /** 放逐后遗言座位（含白猫翻牌） */
  collectFromExile(exileSeat) {
    if (exileSeat == null) return [];
    if (!LastWordsService.qualifiesExile()) return [];
    const p = this.room.getBySeat(exileSeat);
    if (!p) return [];
    // 已出局，或白猫翻牌（仍算被票出局）
    if (!p.alive || p.flags.whiteCatPending) {
      return [exileSeat];
    }
    return [];
  }

  /**
   * 开始遗言轮
   * @param {number[]} seats
   * @param {'after_dawn'|'after_exile'} resume
   * @returns {boolean} 是否真正进入遗言（有人可说）
   */
  begin(seats, resume) {
    const order = (seats || []).filter((seat) => {
      const p = this.room.getBySeat(seat);
      return !!p;
    });
    if (!order.length) {
      this.reset();
      return false;
    }
    this.active = true;
    this.order = order;
    this.index = 0;
    this.resume = resume;
    this.room.phase = 'last_words';
    this.room.dayState = this.room.dayState || {};
    this.room.dayState.currentSpeakerSeat = order[0];
    this.room.dayState.isLastWords = true;
    this.room.publicAnnouncements = [`请 ${order[0]} 号发表遗言。`];
    this.room.addLog('系统', `【遗言】请 ${order[0]} 号发言（1分钟，可提前结束）`);
    this.room.setPhaseTimer(LAST_WORDS_MS, () => this.advance());
    return true;
  }

  advance() {
    if (!this.active) return;
    this.room.clearTimer();
    this.index += 1;
    if (this.index >= this.order.length) {
      this._finish();
      return;
    }
    const seat = this.order[this.index];
    this.room.dayState.currentSpeakerSeat = seat;
    this.room.publicAnnouncements = [`请 ${seat} 号发表遗言。`];
    this.room.addLog('系统', `【遗言】请 ${seat} 号发言（1分钟，可提前结束）`);
    this.room.setPhaseTimer(LAST_WORDS_MS, () => this.advance());
  }

  endEarly(socketId) {
    if (!this.active || this.room.phase !== 'last_words') {
      return { ok: false, error: '非遗言阶段' };
    }
    const p = this.room.players.get(socketId);
    if (!p || p.seat !== this.room.dayState?.currentSpeakerSeat) {
      return { ok: false, error: '只有当前遗言者可结束' };
    }
    this.room.addLog('系统', `${p.seat} 号结束遗言`);
    this.advance();
    return { ok: true };
  }

  _finish() {
    const resume = this.resume;
    this.room.dayState.currentSpeakerSeat = null;
    this.room.dayState.isLastWords = false;
    this.reset();
    if (resume === 'after_dawn') {
      this.room.dayState.nightLastWordsDone = true;
      this.room.afterDawnContinue();
    } else if (resume === 'after_exile') {
      this.room.dayState.exileLastWordsDone = true;
      this.room.afterExile();
    }
  }

  getPublicSnapshot() {
    if (!this.active) {
      return { active: false, order: [], index: 0 };
    }
    return {
      active: true,
      order: [...this.order],
      index: this.index,
      resume: this.resume,
    };
  }
}

module.exports = { LastWordsService, LAST_WORDS_MS, NIGHT_LAST_WORD_REASONS };
