/**
 * 语音旁白（浏览器 SpeechSynthesis，中文）
 * 风格接近官狼法官口播：天黑闭眼、天亮、发言、投票等
 */
(function (global) {
  class GameNarrator {
    constructor() {
      this.enabled = true;
      this.queue = [];
      this.speaking = false;
      this.lastKey = '';
      this.voice = null;
      this.rate = 0.92;
      this.pitch = 1;
      this.volume = 1;
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

    stop() {
      this.queue = [];
      this.speaking = false;
      if (typeof speechSynthesis !== 'undefined') {
        speechSynthesis.cancel();
      }
    }

    /** 去重后入队播报 */
    say(text, key) {
      if (!this.enabled || !text) return;
      if (typeof speechSynthesis === 'undefined') return;
      const k = key || text;
      if (k === this.lastKey) return;
      this.lastKey = k;
      // 同一短时间内相同文案不重复堆叠
      if (this.queue.includes(text) || (this.speaking && this._current === text)) return;
      this.queue.push(String(text));
      this._pump();
    }

    sayOnce(text, key) {
      this.say(text, key || text);
    }

    _pump() {
      if (this.speaking || !this.queue.length) return;
      if (typeof speechSynthesis === 'undefined') return;
      this.speaking = true;
      const text = this.queue.shift();
      this._current = text;
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN';
      u.rate = this.rate;
      u.pitch = this.pitch;
      u.volume = this.volume;
      if (this.voice) u.voice = this.voice;
      u.onend = () => {
        this.speaking = false;
        this._current = null;
        this._pump();
      };
      u.onerror = () => {
        this.speaking = false;
        this._current = null;
        this._pump();
      };
      try {
        speechSynthesis.resume();
      } catch (_) {}
      speechSynthesis.speak(u);
    }

    /**
     * 根据对局状态生成旁白
     * @param {object} state 当前公开状态
     * @param {object|null} prev 上一帧状态摘要 { phase, night, day, speaker, announceKey, winner }
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
        // 刚进对局：只播当前阶段入口，避免刷历史
        this._speakPhaseEnter(state, true);
        return next;
      }

      if (prev.phase !== next.phase || prev.night !== next.night || prev.day !== next.day) {
        this._speakPhaseEnter(state, false);
      } else if (
        next.phase === 'day_speak' &&
        prev.speaker !== next.speaker &&
        next.speaker != null
      ) {
        this.say(`请 ${next.speaker} 号玩家发言。`, `speak-${next.day}-${next.speaker}`);
      }

      if (prev.announceKey !== next.announceKey && next.announceKey) {
        // 天亮公告、自爆、终局等
        const lines = state.announcements || [];
        for (const line of lines) {
          if (!line) continue;
          // 阶段入口已覆盖部分，这里补播具体结果
          if (/熊|出局|平安|胜利|自爆|强制结束|放逐/.test(line)) {
            this.say(line, `ann-${next.announceKey}-${line}`);
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
          this.say('天黑了，请闭眼。狼人请睁眼，互相确认身份。', 'night-1');
        } else {
          this.say(`天黑了，请闭眼。第 ${night} 夜开始。`, `night-${night}`);
        }
        return;
      }
      if (phase === 'dawn') {
        this.say('天亮了。', `dawn-${day}`);
        return;
      }
      if (phase === 'day_speak') {
        if (!soft) this.say('白天发言阶段开始。', `speak-start-${day}`);
        if (state.currentSpeakerSeat != null) {
          this.say(
            `请 ${state.currentSpeakerSeat} 号玩家发言，限时一分钟。`,
            `speak-${day}-${state.currentSpeakerSeat}`
          );
        }
        return;
      }
      if (phase === 'day_vote') {
        this.say('发言结束，请投票放逐一名玩家。', `vote-${day}`);
        return;
      }
      if (phase === 'skill') {
        this.say('请发动技能。', `skill-${day}-${state.night}`);
        return;
      }
      if (phase === 'ended') {
        if (state.winner === 'wolf') this.say('游戏结束，狼人阵营胜利。', 'end-wolf');
        else if (state.winner === 'village') this.say('游戏结束，好人阵营胜利。', 'end-village');
        else if (state.winner === 'admin') this.say('管理员强制结束本局。', 'end-admin');
        else this.say('游戏结束。', 'end');
      }
    }
  }

  global.GameNarrator = GameNarrator;
})(window);
