/**
 * 房间全员语音（WebRTC 全互联）
 * - 每对连接只由 socketId 较大的一方发起 offer，避免双方同时呼叫冲突
 * - ICE candidate 排队，减少半连通
 * - 定时巡检补建缺失链路
 */
(function (global) {
  const ICE = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
      // 公共 TURN（穿透对称 NAT；不可用时仍可走 STUN）
      {
        urls: 'turn:openrelay.metered.ca:80',
        username: 'openrelayproject',
        credential: 'openrelayproject',
      },
      {
        urls: 'turn:openrelay.metered.ca:443',
        username: 'openrelayproject',
        credential: 'openrelayproject',
      },
    ],
  };

  class VoiceChat {
    constructor(socket) {
      this.socket = socket;
      this.localStream = null;
      this.peers = new Map(); // peerId -> { pc, audio, pending, makingOffer, polite }
      this.enabled = false;
      this.micOn = false;
      this.onStatus = null;
      this._syncTimer = null;
      this._makingOffer = new Set();
      this.voiceChannel = 'all';
      this.forceMute = false;
      this.canSpeak = true;
      this.policyLabel = '';

      socket.on('voice-signal', (msg) => this._onSignal(msg));
      socket.on('voice-peer-joined', (peer) => {
        if (this.enabled && peer?.id) this._linkPeer(peer.id);
      });
      socket.on('voice-peer-left', (peer) => {
        if (peer?.id) this._closePeer(peer.id);
        this._updateStatus();
      });
    }

    setStatus(text) {
      if (typeof this.onStatus === 'function') this.onStatus(text);
    }

    _updateStatus() {
      if (!this.enabled) {
        this.setStatus('语音已关闭');
        return;
      }
      let live = 0;
      for (const { pc } of this.peers.values()) {
        if (pc.connectionState === 'connected' || pc.iceConnectionState === 'connected') live += 1;
      }
      const mic = this.micOn ? '开麦' : '闭麦';
      this.setStatus(`${mic} · 已连通 ${live}/${this.peers.size} 人`);
    }

    /** 是否由本端发起 offer：id 字典序更大的一方负责呼叫，保证每对只建一条 */
    _shouldOffer(peerId) {
      return String(this.socket.id) > String(peerId);
    }

    async enable() {
      if (this.enabled) return true;
      try {
        this.localStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: false,
        });
        this.localStream.getAudioTracks().forEach((t) => {
          t.enabled = false;
        });
        this.micOn = false;
        this.enabled = true;
        this.setStatus('语音已开启（当前闭麦）');

        await new Promise((resolve) => {
          this.socket.emit('voice-ready', {}, () => resolve());
        });

        await this._syncMesh(true);
        this._syncTimer = setInterval(() => this._syncMesh(false), 4000);
        this._updateStatus();
        return true;
      } catch (err) {
        console.error(err);
        this.setStatus('无法使用麦克风：' + (err.message || '权限被拒绝'));
        this.enabled = false;
        return false;
      }
    }

    async disable() {
      if (this._syncTimer) {
        clearInterval(this._syncTimer);
        this._syncTimer = null;
      }
      this.socket.emit('voice-leave', {});
      for (const id of [...this.peers.keys()]) this._closePeer(id);
      if (this.localStream) {
        this.localStream.getTracks().forEach((t) => t.stop());
        this.localStream = null;
      }
      this.enabled = false;
      this.micOn = false;
      this.setStatus('语音已关闭');
    }

    setMic(on) {
      // 强制闭麦时不允许开麦
      if (this.forceMute && on) {
        on = false;
      }
      this.micOn = !!on;
      if (this.localStream) {
        this.localStream.getAudioTracks().forEach((t) => {
          t.enabled = this.micOn;
        });
      }
      this._updateStatus();
    }

    toggleMic() {
      if (this.forceMute) {
        this.setMic(false);
        this.setStatus(this.policyLabel || '当前阶段强制闭麦');
        return false;
      }
      this.setMic(!this.micOn);
      return this.micOn;
    }

    /**
     * 按房间语音策略同步：频道切换时重建 peers；强制闭麦
     * @param {{ channel?: string, canSpeak?: boolean, forceMute?: boolean, label?: string }} policy
     */
    async applyPolicy(policy) {
      if (!policy) return;
      const channel = policy.channel || 'all';
      const forceMute = !!policy.forceMute;
      const label = policy.label || '';
      const channelChanged = this.voiceChannel !== channel;
      this.voiceChannel = channel;
      this.forceMute = forceMute;
      this.policyLabel = label;
      this.canSpeak = !!policy.canSpeak;

      if (forceMute && this.micOn) {
        this.setMic(false);
      }

      if (!this.enabled) {
        if (label) this.setStatus(label);
        return;
      }

      if (channelChanged) {
        await this.rebind();
      } else {
        await this._syncMesh(false);
      }

      if (label) {
        const mic = this.micOn ? '开麦' : '闭麦';
        this.setStatus(`${label} · ${mic}`);
      } else {
        this._updateStatus();
      }
    }

    async _syncMesh(forceCall) {
      if (!this.enabled) return;
      const peers = await new Promise((resolve) => {
        this.socket.emit('voice-peers', {}, (res) => resolve(res?.peers || []));
      });
      const ids = new Set(peers.map((p) => p.id));
      for (const id of [...this.peers.keys()]) {
        if (!ids.has(id)) this._closePeer(id);
      }
      for (const p of peers) {
        await this._linkPeer(p.id, forceCall);
      }
      this._updateStatus();
    }

    async _linkPeer(peerId, force) {
      if (!this.enabled || !peerId || peerId === this.socket.id) return;
      const entry = this.peers.get(peerId);
      const connected =
        entry &&
        (entry.pc.connectionState === 'connected' ||
          entry.pc.iceConnectionState === 'connected' ||
          entry.pc.iceConnectionState === 'completed');
      if (connected && !force) return;

      // 仅 id 更大的一方主动 offer，避免 glare
      if (!this._shouldOffer(peerId)) {
        await this._ensurePc(peerId);
        return;
      }
      await this._call(peerId);
    }

    async _ensurePc(peerId) {
      let entry = this.peers.get(peerId);
      if (entry) return entry;

      const pc = new RTCPeerConnection(ICE);
      entry = {
        pc,
        audio: null,
        pending: [],
        polite: !this._shouldOffer(peerId), // 被叫方更“礼貌”，冲突时回退
      };
      this.peers.set(peerId, entry);

      if (this.localStream) {
        for (const track of this.localStream.getTracks()) {
          pc.addTrack(track, this.localStream);
        }
      }

      pc.onicecandidate = (ev) => {
        if (!ev.candidate) return;
        this.socket.emit('voice-signal', {
          to: peerId,
          data: { type: 'candidate', candidate: ev.candidate },
        });
      };

      pc.ontrack = (ev) => {
        let audio = entry.audio;
        if (!audio) {
          audio = document.createElement('audio');
          audio.autoplay = true;
          audio.playsInline = true;
          audio.setAttribute('playsinline', 'true');
          audio.dataset.peer = peerId;
          document.body.appendChild(audio);
          entry.audio = audio;
        }
        audio.srcObject = ev.streams[0] || new MediaStream([ev.track]);
        const play = audio.play();
        if (play && play.catch) play.catch(() => {});
        this._updateStatus();
      };

      pc.onconnectionstatechange = () => {
        this._updateStatus();
        if (pc.connectionState === 'failed') {
          this._closePeer(peerId);
          // 稍后由巡检或本端重试
          if (this.enabled && this._shouldOffer(peerId)) {
            setTimeout(() => this._call(peerId), 800);
          }
        }
      };

      pc.oniceconnectionstatechange = () => this._updateStatus();

      return entry;
    }

    async _flushCandidates(entry) {
      if (!entry?.pc?.remoteDescription) return;
      const list = entry.pending.splice(0, entry.pending.length);
      for (const c of list) {
        try {
          await entry.pc.addIceCandidate(c);
        } catch (_) {}
      }
    }

    async _call(peerId) {
      if (!this.enabled || peerId === this.socket.id) return;
      if (!this._shouldOffer(peerId)) return;
      if (this._makingOffer.has(peerId)) return;

      const entry = await this._ensurePc(peerId);
      const pc = entry.pc;
      if (pc.signalingState !== 'stable' && pc.signalingState !== 'have-local-offer') {
        return;
      }

      try {
        this._makingOffer.add(peerId);
        const offer = await pc.createOffer({ offerToReceiveAudio: true });
        if (pc.signalingState !== 'stable') return;
        await pc.setLocalDescription(offer);
        this.socket.emit('voice-signal', {
          to: peerId,
          data: { type: 'offer', sdp: pc.localDescription },
        });
      } catch (err) {
        console.warn('voice offer failed', peerId, err);
      } finally {
        this._makingOffer.delete(peerId);
      }
    }

    async _onSignal(msg) {
      if (!this.enabled || !msg?.from || !msg?.data) return;
      const { from, data } = msg;
      const entry = await this._ensurePc(from);
      const pc = entry.pc;

      try {
        if (data.type === 'offer') {
          const offerCollision =
            this._makingOffer.has(from) || pc.signalingState !== 'stable';
          if (offerCollision) {
            if (!entry.polite) {
              // 无礼貌方忽略对方 offer，坚持自己的
              return;
            }
            try {
              await pc.setLocalDescription({ type: 'rollback' });
            } catch (_) {}
          }
          await pc.setRemoteDescription(data.sdp);
          await this._flushCandidates(entry);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          this.socket.emit('voice-signal', {
            to: from,
            data: { type: 'answer', sdp: pc.localDescription },
          });
        } else if (data.type === 'answer') {
          if (pc.signalingState === 'have-local-offer') {
            await pc.setRemoteDescription(data.sdp);
            await this._flushCandidates(entry);
          }
        } else if (data.type === 'candidate' && data.candidate) {
          if (pc.remoteDescription) {
            try {
              await pc.addIceCandidate(data.candidate);
            } catch (_) {}
          } else {
            entry.pending.push(data.candidate);
          }
        }
      } catch (err) {
        console.warn('voice signal error', err);
      }
      this._updateStatus();
    }

    _closePeer(peerId) {
      const entry = this.peers.get(peerId);
      if (!entry) return;
      try {
        entry.pc.close();
      } catch (_) {}
      if (entry.audio) {
        entry.audio.srcObject = null;
        entry.audio.remove();
      }
      this.peers.delete(peerId);
      this._makingOffer.delete(peerId);
    }

    async rebind() {
      if (!this.enabled) return;
      for (const id of [...this.peers.keys()]) this._closePeer(id);
      this.socket.emit('voice-ready', {});
      await this._syncMesh(true);
    }
  }

  global.VoiceChat = VoiceChat;
})(window);
