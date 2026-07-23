/** 管理员账号（仅服务端校验，勿下发到前端） */
const ADMIN = {
  username: 'TVV擒龙',
  password: 'hyron0828',
};

function verifyAdmin(username, password) {
  return (
    String(username || '') === ADMIN.username &&
    String(password || '') === ADMIN.password
  );
}

module.exports = { verifyAdmin, ADMIN_DISPLAY_NAME: ADMIN.username };
