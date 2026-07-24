/**
 * 夜间氛围 BGM（Web Audio 程序化生成）
 * 不使用网易版权曲库，风格接近「天黑闭眼」的低沉氛围垫乐。
 */
(function (global) {
  class NightBgm {
    constructor() {
      this.ctx = null;
      this.nodes = [];
      this.playing = false;
      this.master = null;
      /** 用户设定音量（滑条），不受旁白 duck 永久改写 */
      this.userVolume = 0.22;
      /** 旁白时临时压低系数 0~1 */
      this.duckFactor = 1;
      this._unlocked = false;
    }

    get volume() {
      return this.userVolume;
    }

    set volume(v) {
      this.userVolume = Math.max(0, Math.min(1, v));
    }

    async ensureCtx() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        this.ctx = new AC();
      }
      if (this.ctx.state === 'suspended') {
        try {
          await this.ctx.resume();
        } catch (_) {}
      }
      if (this.ctx.state === 'running') this._unlocked = true;
      return this.ctx;
    }

    /** 用户手势内调用，解锁自动播放策略 */
    async unlock() {
      const ctx = await this.ensureCtx();
      if (!ctx) return false;
      // 极短静音缓冲：部分浏览器仅 resume 不够，需要实际出声节点
      try {
        const buf = ctx.createBuffer(1, 1, ctx.sampleRate);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        src.start(0);
      } catch (_) {}
      this._unlocked = ctx.state === 'running';
      // 若夜间本该在播但因挂起静音，补一次 resume
      if (this.playing && this.master && ctx.state === 'running') {
        this._applyGain();
      }
      return this._unlocked;
    }

    _effectiveVolume() {
      return this.userVolume * this.duckFactor;
    }

    _applyGain() {
      if (this.master) this.master.gain.value = this._effectiveVolume();
    }

    async start() {
      const ctx = await this.ensureCtx();
      if (!ctx) return;

      // 已在播：只确保 context 未挂起，并刷新增益
      if (this.playing) {
        this._applyGain();
        return;
      }

      this.playing = true;

      const master = ctx.createGain();
      master.gain.value = this._effectiveVolume();
      master.connect(ctx.destination);
      this.master = master;

      // 低沉 pad
      this._pad(ctx, master, 55, 0.08);
      this._pad(ctx, master, 82.5, 0.05);
      this._pad(ctx, master, 110, 0.035);

      // 缓慢扫频噪声风声
      const bufferSize = 2 * ctx.sampleRate;
      const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const data = noiseBuffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
      const noise = ctx.createBufferSource();
      noise.buffer = noiseBuffer;
      noise.loop = true;
      const noiseFilter = ctx.createBiquadFilter();
      noiseFilter.type = 'lowpass';
      noiseFilter.frequency.value = 400;
      const noiseGain = ctx.createGain();
      noiseGain.gain.value = 0.03;
      noise.connect(noiseFilter);
      noiseFilter.connect(noiseGain);
      noiseGain.connect(master);
      noise.start();
      this.nodes.push(noise);

      // 心跳感低频脉冲
      const pulse = ctx.createOscillator();
      pulse.type = 'sine';
      pulse.frequency.value = 40;
      const pulseGain = ctx.createGain();
      pulseGain.gain.value = 0;
      pulse.connect(pulseGain);
      pulseGain.connect(master);
      pulse.start();
      this.nodes.push(pulse);

      const beat = () => {
        if (!this.playing || !this.ctx) return;
        const t = this.ctx.currentTime;
        pulseGain.gain.cancelScheduledValues(t);
        pulseGain.gain.setValueAtTime(0, t);
        pulseGain.gain.linearRampToValueAtTime(0.07, t + 0.05);
        pulseGain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
        this._beatTimer = setTimeout(beat, 1800);
      };
      beat();

      // 偶尔的高音点缀
      this._sparkleTimer = setInterval(() => {
        if (!this.playing || !this.ctx) return;
        this._sparkle(this.ctx, master);
      }, 5200);
    }

    _pad(ctx, dest, freq, vol) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.05 + Math.random() * 0.08;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = freq * 0.01;
      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);
      const g = ctx.createGain();
      g.gain.value = vol;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 600;
      osc.connect(filter);
      filter.connect(g);
      g.connect(dest);
      osc.start();
      lfo.start();
      this.nodes.push(osc, lfo);
    }

    _sparkle(ctx, dest) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = 220 + Math.random() * 180;
      const g = ctx.createGain();
      const t = ctx.currentTime;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.025, t + 0.4);
      g.gain.exponentialRampToValueAtTime(0.001, t + 2.8);
      osc.connect(g);
      g.connect(dest);
      osc.start(t);
      osc.stop(t + 3);
    }

    stop() {
      this.playing = false;
      this.duckFactor = 1;
      clearTimeout(this._beatTimer);
      clearInterval(this._sparkleTimer);
      for (const n of this.nodes) {
        try {
          n.stop();
        } catch (_) {}
        try {
          n.disconnect();
        } catch (_) {}
      }
      this.nodes = [];
      if (this.master) {
        try {
          this.master.disconnect();
        } catch (_) {}
        this.master = null;
      }
    }

    /** 用户滑条音量；不影响 duck */
    setVolume(v) {
      this.userVolume = Math.max(0, Math.min(1, v));
      this._applyGain();
    }

    /** 旁白时临时压低；factor 为相对用户音量的比例 */
    setDuck(factor) {
      this.duckFactor = Math.max(0, Math.min(1, factor));
      this._applyGain();
    }

    clearDuck() {
      this.duckFactor = 1;
      this._applyGain();
    }

    async sync(phase) {
      if (phase === 'night') {
        await this.start();
      } else {
        this.stop();
      }
    }
  }

  global.NightBgm = NightBgm;
})(window);
