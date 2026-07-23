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
      this.volume = 0.22;
    }

    async ensureCtx() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AC();
      }
      if (this.ctx.state === 'suspended') {
        await this.ctx.resume();
      }
      return this.ctx;
    }

    async start() {
      if (this.playing) return;
      const ctx = await this.ensureCtx();
      this.playing = true;

      const master = ctx.createGain();
      master.gain.value = this.volume;
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

    setVolume(v) {
      this.volume = Math.max(0, Math.min(1, v));
      if (this.master) this.master.gain.value = this.volume;
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
