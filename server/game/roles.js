/** 板子与角色定义 */

const CAMP = {
  WOLF: 'wolf',
  VILLAGE: 'village',
};

/** 角色元数据（count 由板子配置覆盖） */
const ROLE_DEFS = {
  awakened_gargoyle: {
    id: 'awakened_gargoyle',
    name: '觉醒石像鬼',
    camp: CAMP.WOLF,
    description:
      '狼人阵营。两名石像鬼互相认识并互标身份，夜间可语音沟通；不知另一石像鬼转化了谁。无查验技能；可参与刀人多数决；整局限一次转化一名好人（仅你可见该转化者）。白天可自爆。',
  },
  awakened_hidden_wolf: {
    id: 'awakened_hidden_wolf',
    name: '觉醒隐狼',
    camp: CAMP.WOLF,
    description:
      '狼人阵营。不与狼队见面，不可自爆；预言家查验为好人。模仿后立刻可知对象身份，当夜结束后获得对方技能：预/镜可持续查验；女巫一瓶毒药；猎人可开枪；白猫翻牌延迟出局；熊邻座查验重合；摄梦人可摄梦；河豚可放逐翻牌带走；暗恋者可选偶像并结算心愿；石像鬼为双刀狼。所有觉醒石像鬼与转化者出局后才带刀。',
  },
  seer: {
    id: 'seer',
    name: '预言家',
    camp: CAMP.VILLAGE,
    description: '每晚可查验一名玩家的阵营（好人/狼人）。暗恋者恒为好人。',
  },
  mirror_maiden: {
    id: 'mirror_maiden',
    name: '魔镜少女',
    camp: CAMP.VILLAGE,
    description: '每晚可查验一名玩家的具体身份。',
  },
  bear: {
    id: 'bear',
    name: '熊',
    camp: CAMP.VILLAGE,
    description:
      '无主动技能。入夜前记录左右邻座；天亮时若邻座中有狼人则公开「熊咆哮了」，否则「熊没有咆哮」。隐狼学熊时查验重合。',
  },
  witch: {
    id: 'witch',
    name: '女巫',
    camp: CAMP.VILLAGE,
    description: '一瓶解药、一瓶毒药。同一夜不可双开。连续摄梦致死无法用解药救活。',
  },
  hunter: {
    id: 'hunter',
    name: '猎人',
    camp: CAMP.VILLAGE,
    description: '非毒药/非连续摄梦致死出局时可开枪带走一名玩家；被毒或被摄梦连续致死则无法开枪。',
  },
  pufferfish: {
    id: 'pufferfish',
    name: '河豚',
    camp: CAMP.VILLAGE,
    description:
      '仅在自己被投票放逐时，可翻牌带走本轮所有投给自己的玩家（整局限一次）；被毒杀或连续摄梦致死则无法翻牌。',
  },
  dream_catcher: {
    id: 'dream_catcher',
    name: '摄梦人',
    camp: CAMP.VILLAGE,
    description:
      '每晚必须选择一名梦游者。梦游者免疫当晚一切夜间技能（刀/药等视为已使用但落空）。连续两晚同一人则该人死亡且女巫救不活；若因此致死猎人/河豚，对方无法开枪或翻牌。摄梦人夜间死亡则梦游者一并死亡；白天出局不带走梦游者。',
  },
  white_cat: {
    id: 'white_cat',
    name: '白猫',
    camp: CAMP.VILLAGE,
    description:
      '任何原因出局时翻牌自证，额外存活至下一次放逐投票结束后、入夜前才真正死亡；翻牌期间有投票权。若翻牌后本轮最后一只狼出局，则立即判定好人胜利。',
  },
  admirer: {
    id: 'admirer',
    name: '暗恋者',
    camp: CAMP.VILLAGE,
    description:
      '首夜暗中选择一名暗恋对象，双方互不知情；胜负跟随对方。若被转化进狼队但偶像为好人，则崇拜优先于转化，须与好人一起赢。预言家查验恒为好人。场上按「民」计算（崇拜优先时），狼人屠边须使其出局。',
  },
};

const BOARDS = {
  basic10: {
    id: 'basic10',
    name: '10人基础版',
    seats: 10,
    roles: {
      awakened_gargoyle: 2,
      seer: 1,
      mirror_maiden: 1,
      bear: 1,
      witch: 1,
      hunter: 1,
      dream_catcher: 1,
      pufferfish: 1,
      white_cat: 1,
    },
    rulesNote:
      '10人基础：觉醒石像鬼×2 互认并互标身份（不知对方转化者）；夜间可语音；可转化好人；刀人多数决（无查验）。',
  },
  fengsheng12: {
    id: 'fengsheng12',
    name: '12人风声谍影',
    seats: 12,
    roles: {
      awakened_gargoyle: 2,
      awakened_hidden_wolf: 1,
      seer: 1,
      mirror_maiden: 1,
      bear: 1,
      witch: 1,
      hunter: 1,
      dream_catcher: 1,
      pufferfish: 1,
      white_cat: 1,
      admirer: 1,
    },
    rulesNote:
      '12人风声谍影：石像鬼互认并互标身份（不知对方转化者）；夜间可语音；转化者在两石像鬼出局且仅剩一人时可刀；隐狼模仿后可知身份；不知隐狼。',
  },
};

function getBoard(boardId) {
  return BOARDS[boardId] || BOARDS.fengsheng12;
}

function createRolePool(boardId) {
  const board = getBoard(boardId);
  const pool = [];
  for (const [roleId, count] of Object.entries(board.roles)) {
    for (let i = 0; i < count; i++) pool.push(roleId);
  }
  return pool;
}

/** 兼容旧代码：默认展示全部角色说明 */
const ROLES = Object.fromEntries(
  Object.entries(ROLE_DEFS).map(([id, def]) => [
    id,
    { ...def, count: BOARDS.fengsheng12.roles[id] || 0 },
  ])
);

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function getRoleMeta(roleId) {
  return ROLE_DEFS[roleId] || { id: roleId, name: roleId, camp: CAMP.VILLAGE, description: '' };
}

function listRolesForBoard(boardId) {
  const board = getBoard(boardId);
  return Object.entries(board.roles).map(([id, count]) => ({
    ...getRoleMeta(id),
    count,
  }));
}

module.exports = {
  CAMP,
  ROLES,
  ROLE_DEFS,
  BOARDS,
  getBoard,
  createRolePool,
  shuffle,
  getRoleMeta,
  listRolesForBoard,
};
