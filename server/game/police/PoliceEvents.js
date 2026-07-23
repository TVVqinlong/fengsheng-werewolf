/**
 * 上警 / 警长系统 — 事件常量
 * 统一事件名，便于日后扩展警徽流、PK、连任等
 */

const PoliceEvents = {
  PlayerRegisterPolice: 'PlayerRegisterPolice',
  PlayerWithdrawPolice: 'PlayerWithdrawPolice',
  PoliceSpeechStart: 'PoliceSpeechStart',
  PoliceSpeechEnd: 'PoliceSpeechEnd',
  PoliceVoteStart: 'PoliceVoteStart',
  PlayerVotePolice: 'PlayerVotePolice',
  PoliceElected: 'PoliceElected',
  PoliceTransfer: 'PoliceTransfer',
  PoliceRemoved: 'PoliceRemoved',
  PoliceOrderChosen: 'PoliceOrderChosen',
  PoliceSkipped: 'PoliceSkipped', // 无人上警等跳过
};

/** 极简 EventBus（房间级） */
class PoliceEventBus {
  constructor() {
    this._handlers = new Map();
  }

  on(event, fn) {
    if (!this._handlers.has(event)) this._handlers.set(event, []);
    this._handlers.get(event).push(fn);
    return () => this.off(event, fn);
  }

  off(event, fn) {
    const list = this._handlers.get(event);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  emit(event, payload) {
    const list = this._handlers.get(event) || [];
    for (const fn of list) {
      try {
        fn(payload);
      } catch (e) {
        console.error('[PoliceEventBus]', event, e);
      }
    }
  }
}

module.exports = { PoliceEvents, PoliceEventBus };
