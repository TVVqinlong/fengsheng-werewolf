/**
 * 语音旁白（浏览器 SpeechSynthesis，中文）
 * 风格接近官狼法官口播：天黑闭眼、天亮、发言、投票等
 *
 * 发言席位提示为「实时」类：新麦序到达时会打断/清掉过期的「请 X 号发言」，
 * 避免多人快速过麦时旁白还在挨个念旧席位。
 */
(function (global) {
  const SPEAK_PHASES = new Set([
    'day_speak',
    'last_words',
    'police_speech',
    'police_pk_speech',
  ]);

  class GameNarrator {
    constructor() {
      this.enabled = true;
      /** @type {{text:string,key:string,group:string}[]} */
      this.queue = [];
      this.speaking = false;
      this.lastKey = '';
      this.voice = null;
      this.rate = 0.92;
      this.pitch = 1;
      this.volume = 1;
      this._unlocked = false;
      this._watchdog = null;
      this._current = null;
      this._currentGroup = null;
      /** 取消/打断后忽略过期 onend/onerror */
      this._generation = 0;
      /** 打断后由调用方 _pumpSoon，避免 say 立刻 speak 与 cancel 竞态 */
      this._deferPump = false;
      /** @type {null|((speaking:boolean)=>void)} */
      this.onSpeakingChange = null;
      this._loadVoices();
      if (typeof speechSynthesis !== 'undefined') {
        speechSynthesis.onvoiceschanged = () => this._loadVoices();
      }
    }

    _loadVoices() {
      if (typeof speechSynthesis === 'undefined') return;
      const voices = speechSynthesis.getVoices() || [];
      this.voice =
        voices.find((v) => /zh-CN|zh_CN|Chinese\s*\(China\)|华文|普通话|Xiaoxiao|Yaoyao|Huihui/i.test(v.name + v.lang)) ||
        voices.find((v) => /^zh/i.test(v.lang)) ||
        null;
    }

    setEnabled(on) {
      this.enabled = !!on;
      if (!this.enabled) this.stop();
    }

    /** 用户手势内解锁 TTS（Chrome 等需交互后才能出声） */
    unlock() {
      if (typeof speechSynthesis === 'undefined') return false;
      try {
        speechSynthesis.resume();
      } catch (_) {}
      try {
        const u = new SpeechSynthesisUtterance('\u200b');
        u.volume = 0;
        u.rate = 2;
        u.lang = 'zh-CN';
        speechSynthesis.speak(u);
        speechSynthesis.cancel();
      } catch (_) {}
      this._unlocked = true;
      return true;
    }

    stop() {
      this.queue = [];
      this._clearWatchdog();
      this._generation += 1;
      const was = this.speaking;
      this.speaking = false;
      this._current = null;
      this._currentGroup = null;
      if (typeof speechSynthesis !== 'undefined') {
        try {
          speechSynthesis.cancel();
        } catch (_) {}
      }
      if (was) this._emitSpeaking(false);
    }

    _emitSpeaking(on) {
      if (typeof this.onSpeakingChange === 'function') {
        try {
          this.onSpeakingChange(!!on);
        } catch (_) {}
      }
    }

    _clearWatchdog() {
      if (this._watchdog) {
        clearTimeout(this._watchdog);
        this._watchdog = null;
      }
    }

    _armWatchdog(text, gen) {
      this._clearWatchdog();
      const ms = Math.min(45000, 4000 + String(text || '').length * 280);
      this._watchdog = setTimeout(() => {
        if (gen !== this._generation || !this.speaking) return;
        this.speaking = false;
        this._current = null;
        this._currentGroup = null;
        this._emitSpeaking(false);
        try {
          speechSynthesis.cancel();
        } catch (_) {}
        this._pump();
      }, ms);
    }

    /** 清掉某组排队；若正在播该组则可选择打断 */
    clearGroup(group, { interrupt = false } = {}) {
      this.queue = this.queue.filter((item) => item.group !== group);
      if (interrupt && this.speaking && this._currentGroup === group) {
        this._interruptCurrent();
        return true;
      }
      return false;
    }

    _interruptCurrent() {
      this._clearWatchdog();
      this._generation += 1;
      const was = this.speaking;
      this.speaking = false;
      this._current = null;
      this._currentGroup = null;
      if (typeof speechSynthesis !== 'undefined') {
        try {
          speechSynthesis.cancel();
        } catch (_) {}
      }
      if (was) this._emitSpeaking(false);
    }

    /** cancel 后微延迟再泵，避开 Chrome 竞态 */
    _pumpSoon(ms = 40) {
      const gen = this._generation;
      setTimeout(() => {
        if (gen !== this._generation) return;
        this._pump();
      }, ms);
    }

    /**
     * 普通入队（阶段入口、公告等）
     * @param {string} text
     * @param {string} [key]
     * @param {string} [group]
     */
    say(text, key, group = 'info') {
      if (!this.enabled || !text) return;
      if (typeof speechSynthesis === 'undefined') return;
      const k = key || text;
      if (k === this.lastKey) return;
      this.lastKey = k;
      if (
        this.queue.some((q) => q.text === text || q.key === k) ||
        (this.speaking && this._current === text)
      ) {
        return;
      }
      this.queue.push({ text: String(text), key: k, group });
      if (!this.speaking && !this._deferPump) this._pump();
    }

    /**
     * 实时口播：同组只保留最新一条；若正在播同组则打断后立刻播新的。
     * 用于麦序切换，避免「请 1/2/3 号发言」堆成 backlog。
     */
    sayLive(text, key, group = 'speaker') {
      if (!this.enabled || !text) return;
      if (typeof speechSynthesis === 'undefined') return;
      const k = key || text;
      this.lastKey = k;

      this.queue = this.queue.filter((item) => item.group !== group);

      const sameNow = this.speaking && this._currentGroup === group && this._current === text;
      if (sameNow) return;

      let interrupted = false;
      if (this.speaking && this._currentGroup === group) {
        this._interruptCurrent();
        interrupted = true;
      }

      this.queue.unshift({ text: String(text), key: k, group });

      // 若还在播别的组（阶段入口等），等它播完；队首已是最新麦序
      if (this.speaking) return;

      if (interrupted) this._pumpSoon();
      else this._pump();
    }

    sayOnce(text, key) {
      this.say(text, key || text);
    }

    _finishUtterance(gen) {
      if (gen !== this._generation) return;
      this._clearWatchdog();
      this.speaking = false;
      this._current = null;
      this._currentGroup = null;
      this._emitSpeaking(false);
      this._pump();
    }

    _pump() {
      if (this.speaking || !this.queue.length) return;
      if (typeof speechSynthesis === 'undefined') return;

      const item = this.queue.shift();
      this.speaking = true;
      this._current = item.text;
      this._currentGroup = item.group;
      const gen = this._generation;
      this._emitSpeaking(true);

      const u = new SpeechSynthesisUtterance(item.text);
      u.lang = 'zh-CN';
      u.rate = this.rate;
      u.pitch = this.pitch;
      u.volume = this.volume;
      if (this.voice) u.voice = this.voice;
      u.onend = () => this._finishUtterance(gen);
      u.onerror = () => this._finishUtterance(gen);

      try {
        speechSynthesis.resume();
      } catch (_) {}

      try {
        speechSynthesis.speak(u);
        this._armWatchdog(item.text, gen);
      } catch (_) {
        this._finishUtterance(gen);
      }
    }

    /**
     * 根据对局状态生成旁白
     * @param {object} state 当前公开状态
     * @param {object|null} prev 上一帧状态摘要
     */
    sync(state, prev) {
      if (!this.enabled || !state) return prev;
      const next = {
        phase: state.phase,
        night: state.night,
        day: state.day,
        speaker: state.currentSpeakerSeat,
        announceKey: (state.announcements || []).join('|'),
        winner: state.winner,
      };

      if (!prev) {
        this._speakPhaseEnter(state, true);
        return next;
      }

      const phaseChanged =
        prev.phase !== next.phase || prev.night !== next.night || prev.day !== next.day;

      if (phaseChanged) {
        // 阶段切换：丢掉过期麦序口播，立刻跟新阶段
        const interrupted = this.clearGroup('speaker', { interrupt: true });
        this._deferPump = interrupted;
        this._speakPhaseEnter(state, false);
        this._deferPump = false;
        if (interrupted) this._pumpSoon();
        else if (!this.speaking && this.queue.length) this._pump();
      } else if (
        SPEAK_PHASES.has(next.phase) &&
        prev.speaker !== next.speaker &&
        next.speaker != null
      ) {
        this.sayLive(
          `请 ${next.speaker} 号发言。`,
          `speak-${next.phase}-${next.day}-${next.speaker}`,
          'speaker'
        );
      } else if (SPEAK_PHASES.has(next.phase) && prev.speaker != null && next.speaker == null) {
        // 发言轮空档：清掉「请 X 号」避免念到投票后
        this.clearGroup('speaker', { interrupt: true });
      }

      if (prev.announceKey !== next.announceKey && next.announceKey) {
        const lines = state.announcements || [];
        for (const line of lines) {
          if (!line) continue;
          if (/熊|出局|平安|胜利|自爆|强制结束|放逐|上警玩家|无人上警|当选警长/.test(line)) {
            this.say(line, `ann-${next.announceKey}-${line}`, 'announce');
          }
        }
      }

      return next;
    }

    _speakPhaseEnter(state, soft) {
      const phase = state.phase;
      const night = state.night;
      const day = state.day;

      if (phase === 'night') {
        if (night === 1) {
          this.say('天黑了，请闭眼。狼人请睁眼，互相确认身份。', 'night-1', 'phase');
        } else {
          this.say(`天黑了，请闭眼。第 ${night} 夜开始。`, `night-${night}`, 'phase');
        }
        return;
      }
      if (phase === 'dawn') {
        this.say('天亮了。', `dawn-${day}`, 'phase');
        return;
      }
      if (phase === 'police_register') {
        this.say('请想当警长的玩家上警。', `police-reg-${day}`, 'phase');
        return;
      }
      if (phase === 'police_speech' || phase === 'police_pk_speech') {
        if (!soft) this.say('警上发言开始。', `police-speak-${phase}-${day}`, 'phase');
        if (state.currentSpeakerSeat != null) {
          this.sayLive(
            `请 ${state.currentSpeakerSeat} 号发言。`,
            `speak-${phase}-${day}-${state.currentSpeakerSeat}`,
            'speaker'
          );
        }
        return;
      }
      if (phase === 'police_vote' || phase === 'police_pk_vote') {
        this.say('请投票选举警长。', `police-vote-${phase}-${day}`, 'phase');
        return;
      }
      if (phase === 'day_speak') {
        if (!soft) this.say('白天发言阶段开始。', `speak-start-${day}`, 'phase');
        if (state.currentSpeakerSeat != null) {
          this.sayLive(
            `请 ${state.currentSpeakerSeat} 号发言。`,
            `speak-${day}-${state.currentSpeakerSeat}`,
            'speaker'
          );
        }
        return;
      }
      if (phase === 'last_words') {
        if (state.currentSpeakerSeat != null) {
          this.sayLive(
            `请 ${state.currentSpeakerSeat} 号发表遗言。`,
            `last-${day}-${state.currentSpeakerSeat}`,
            'speaker'
          );
        } else {
          this.say('请发表遗言。', `last-${day}`, 'phase');
        }
        return;
      }
      if (phase === 'day_vote') {
        this.say('发言结束，请投票放逐一名玩家。', `vote-${day}`, 'phase');
        return;
      }
      if (phase === 'skill') {
        this.say('请发动技能。', `skill-${day}-${state.night}`, 'phase');
        return;
      }
      if (phase === 'ended') {
        if (state.winner === 'wolf') this.say('游戏结束，狼人阵营胜利。', 'end-wolf', 'phase');
        else if (state.winner === 'village') this.say('游戏结束，好人阵营胜利。', 'end-village', 'phase');
        else if (state.winner === 'admin') this.say('管理员强制结束本局。', 'end-admin', 'phase');
        else this.say('游戏结束。', 'end', 'phase');
      }
    }
  }

  global.GameNarrator = GameNarrator;
})(window);
