/**
 * 狼队夜间刀人 / 转化 / 可见性规则
 * （按当前确认的风声规则）
 */

function isGargoyle(room, p) {
  return room.effectiveRole(p) === 'awakened_gargoyle';
}

function isHiddenWolf(room, p) {
  return room.effectiveRole(p) === 'awakened_hidden_wolf';
}

function isConvertor(p) {
  return !!(p?.flags?.convertor || p?.flags?.converted);
}

function aliveGargoyles(room) {
  return room.alivePlayers().filter((p) => isGargoyle(room, p));
}

function allGargoyles(room) {
  return room.seatedPlayers().filter((p) => isGargoyle(room, p));
}

function aliveConvertors(room) {
  return room.alivePlayers().filter((p) => isConvertor(p) && !isGargoyle(room, p) && !isHiddenWolf(room, p));
}

function allConvertors(room) {
  return room
    .seatedPlayers()
    .filter((p) => isConvertor(p) && !isGargoyle(room, p) && !isHiddenWolf(room, p));
}

/** 两位大哥（石像鬼）是否均已出局 */
function bothGargoylesDead(room) {
  const gs = allGargoyles(room);
  if (!gs.length) return true;
  return gs.every((p) => !p.alive);
}

/**
 * 当晚是否禁止发动狼刀：
 * 两石像鬼已死，且场上仍有 ≥2 名存活转化者
 */
function isWolfKillBlocked(room) {
  return bothGargoylesDead(room) && aliveConvertors(room).length >= 2;
}

/**
 * 是否可参与主刀投票
 * - 存活石像鬼：可以
 * - 隐狼：仅当其余狼营（石像鬼+转化者等）全灭
 * - 转化者：仅当两石像鬼已死，且全场只剩自己一名转化者
 */
function canParticipateWolfKill(room, p) {
  if (!p || !p.alive || p.isSpectator || p.flags.whiteCatPending) return false;
  if (isWolfKillBlocked(room)) return false;

  if (isGargoyle(room, p)) return true;

  if (isHiddenWolf(room, p)) {
    return room.hiddenCanKill();
  }

  if (isConvertor(p)) {
    return bothGargoylesDead(room) && aliveConvertors(room).length === 1;
  }

  return false;
}

/** 最后一个存活转化者（两石像鬼已死） */
function isSoleLivingConvertor(room, p) {
  if (!p || !p.alive || !isConvertor(p)) return false;
  if (!bothGargoylesDead(room)) return false;
  return aliveConvertors(room).length === 1 && aliveConvertors(room)[0].id === p.id;
}

/**
 * 末转化者入夜可见情报：两石像鬼座位 + 其他已死转化者座位（不知隐狼）
 */
function getSoleConvertorIntel(room, p) {
  if (!isSoleLivingConvertor(room, p)) return null;
  return {
    gargoyleSeats: allGargoyles(room).map((g) => ({
      seat: g.seat,
      name: g.name,
      alive: g.alive,
      roleName: '觉醒石像鬼',
    })),
    deadConvertorSeats: allConvertors(room)
      .filter((c) => c.id !== p.id && !c.alive)
      .map((c) => ({
        seat: c.seat,
        name: c.name,
        alive: false,
        roleName: '转化者',
      })),
    note: '可知两位石像鬼与其他转化者位置；无法得知觉醒隐狼是谁',
  };
}

module.exports = {
  isGargoyle,
  isHiddenWolf,
  isConvertor,
  aliveGargoyles,
  allGargoyles,
  aliveConvertors,
  bothGargoylesDead,
  isWolfKillBlocked,
  canParticipateWolfKill,
  isSoleLivingConvertor,
  getSoleConvertorIntel,
};
