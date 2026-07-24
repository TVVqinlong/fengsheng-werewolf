/**
 * 上警阶段常量（可接入房间 phase）
 */

const PolicePhase = {
  REGISTER: 'police_register',
  SPEECH: 'police_speech',
  WITHDRAW: 'police_withdraw',
  VOTE: 'police_vote',
  PK_SPEECH: 'police_pk_speech', // 平票再发言（预留/本局启用）
  RESULT: 'police_result',
  ORDER: 'police_order', // 警长选发言顺序
};

const SpeakOrderMode = {
  /** 左侧逆序：从警长左边（座位号+1）开始，座位号递减 */
  CLOCKWISE: 'clockwise',
  /** 右侧顺序：从警长右边（座位号-1）开始，座位号递增 */
  COUNTERCLOCKWISE: 'counterclockwise',
};

const POLICE_REGISTER_MS = 30000;
const POLICE_WITHDRAW_MS = 20000;
const POLICE_VOTE_MS = 45000;
const POLICE_ORDER_MS = 30000;
const POLICE_RESULT_MS = 4000;

module.exports = {
  PolicePhase,
  SpeakOrderMode,
  POLICE_REGISTER_MS,
  POLICE_WITHDRAW_MS,
  POLICE_VOTE_MS,
  POLICE_ORDER_MS,
  POLICE_RESULT_MS,
};
