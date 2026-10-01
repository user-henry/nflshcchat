/**
 * NFLSHC Chat 开放平台 · JavaScript SDK（零依赖，浏览器 + Node 18+ 通用）
 * ---------------------------------------------------------------------------
 * 两种用法：
 *   1) 用户身份调用（已有登录令牌）
 *        const api = new NFLSHC({ token: '<Bearer token>' });
 *        const notes = await api.listNotes();
 *   2) 第三方应用（OAuth 2.0 授权码模式，服务端保存 client_secret）
 *        const oauth = new NFLSHCOAuth({ clientId, clientSecret, redirectUri });
 *        oauth.authorizeUrl({ scope: 'profile friends', state: 'xyz' })   // 把用户送去授权
 *        await oauth.exchangeCode(code)                                    // 用 code 换令牌
 *        const api = new NFLSHC({ token: tokens.access_token });
 *        const me = await api.userinfo();
 *
 * 接口基址：https://worker.nflshcchat.cc.cd
 * 完整接口文档见仓库 docs/API.md
 */

const DEFAULT_BASE = 'https://worker.nflshcchat.cc.cd';

class NFLSHCError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'NFLSHCError';
    this.status = status;
    this.body = body;
  }
}

class NFLSHC {
  constructor({ token = '', baseUrl = DEFAULT_BASE, fetchImpl = null } = {}) {
    this.token = token;
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this._fetch = fetchImpl || globalThis.fetch;
    if (!this._fetch) throw new Error('当前环境没有 fetch，请传入 fetchImpl');
  }

  setToken(token) { this.token = token; return this; }

  /** 底层请求：自动附加 Bearer 令牌、解析 JSON、抛出结构化错误 */
  async request(method, path, { body, headers = {}, raw = false, query } = {}) {
    let url = this.baseUrl + (path.startsWith('/') ? path : '/' + path);
    if (query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') qs.set(k, v);
      if ([...qs].length) url += (url.includes('?') ? '&' : '?') + qs.toString();
    }
    const h = { Accept: 'application/json', ...headers };
    if (this.token) h.Authorization = 'Bearer ' + this.token;
    let payload;
    if (body instanceof FormData) {
      payload = body;                       // 交给运行时自己设置 Content-Type（含 boundary）
    } else if (body !== undefined) {
      h['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await this._fetch(url, { method, headers: h, body: payload });
    if (raw) return res;
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!res.ok) {
      const msg = (data && (data.error || data.message)) || ('HTTP ' + res.status);
      throw new NFLSHCError(msg, res.status, data);
    }
    return data;
  }

  get(path, query) { return this.request('GET', path, { query }); }
  post(path, body) { return this.request('POST', path, { body }); }

  // ---------- 账号 ----------
  /** 当前令牌对应的用户（{ ok, username, isAdmin }） */
  me() { return this.get('/api/auth/me'); }
  /** 我的登录设备列表 */
  sessions() { return this.get('/api/auth/sessions'); }
  /** 下线某台设备 */
  revokeSession(sessionId) { return this.request('DELETE', '/api/auth/sessions/' + encodeURIComponent(sessionId)); }
  /** 下线除本机外的所有设备 */
  revokeOtherSessions() { return this.post('/api/auth/sessions/revoke-others', {}); }
  /** 导出我的全部数据（JSON 对象） */
  exportAccount() { return this.get('/api/account/export'); }
  /** 申请注销账号（7 天冷静期） */
  requestAccountDeletion({ confirm, reason } = {}) { return this.post('/api/account/delete', { confirm, reason }); }
  cancelAccountDeletion() { return this.post('/api/account/delete/cancel', {}); }
  accountStatus() { return this.get('/api/account/status'); }

  // ---------- 消息 ----------
  /** 拉取某聊天室的消息（自动解析 ```json 围栏） */
  async messages(roomId, limit = 100) {
    const rows = await this.get('/api/messages', { room_id: roomId, limit });
    return (Array.isArray(rows) ? rows : rows.rows || []).map(parseFenced);
  }
  /** 发送消息 */
  sendMessage({ id, roomId, sender, content, mentions = [], replyTo = null }) {
    return this.post('/api/messages', {
      id: id || ('msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)),
      room_id: roomId, sender, content, mentions, reply_to: replyTo, timestamp: new Date().toISOString(),
    });
  }

  // ---------- 好友 / 收藏 ----------
  friends() { return this.get('/api/friends'); }
  favorites() { return this.get('/api/favorites'); }

  // ---------- 会议 ----------
  createMeeting({ title, kind = 'instant', scheduledAt, durationMin, invitees = [], password, note } = {}) {
    return this.post('/api/meeting/create', { title, kind, scheduledAt, durationMin, invitees, password, note });
  }
  listMeetings() { return this.get('/api/meeting/list'); }
  joinMeeting(code, password) { return this.post('/api/meeting/join', { code, password }); }
  meetingDetail(id) { return this.get('/api/meeting/detail', { id }); }
  meetingChat(meetingId, since) { return this.get('/api/meeting/chat', { meetingId, since }); }
  sendMeetingChat(meetingId, content) { return this.post('/api/meeting/chat', { meetingId, content }); }
  endMeeting(meetingId) { return this.post('/api/meeting/end', { meetingId }); }
  /** WebRTC ICE 配置（含 TURN） */
  iceServers() { return this.get('/api/rtc/ice'); }

  // ---------- 笔记 ----------
  listNotes() { return this.get('/api/notes/list'); }
  getNote(id) { return this.get('/api/notes/get', { id }); }
  createNote({ title, content, kind, meetingId } = {}) { return this.post('/api/notes/create', { title, content, kind, meetingId }); }
  updateNote({ id, title, content }) { return this.post('/api/notes/update', { id, title, content }); }
  deleteNote(id) { return this.post('/api/notes/delete', { id }); }
  shareNote({ id, username, canEdit = false }) { return this.post('/api/notes/share', { id, username, canEdit }); }
  unshareNote({ id, username }) { return this.post('/api/notes/unshare', { id, username }); }
  meetingNote(meetingId, create = false) { return this.get('/api/notes/meeting', { meetingId, create: create ? 1 : '' }); }

  // ---------- 学习（讲题 / 错题本） ----------
  solveQuestion({ question, imageUrl, subject, save = false } = {}) { return this.post('/api/study/solve', { question, imageUrl, subject, save }); }
  listMistakes({ subject, status, q } = {}) { return this.get('/api/study/mistakes', { subject, status, q }); }
  addMistake(payload) { return this.post('/api/study/mistakes', payload); }
  updateMistake(payload) { return this.post('/api/study/mistakes/update', payload); }
  deleteMistake(id) { return this.post('/api/study/mistakes/delete', { id }); }
  practice({ id, question, count = 2 } = {}) { return this.post('/api/study/practice', { id, question, count }); }

  // ---------- 文件 ----------
  /** 上传文件到文件托管（浏览器里传 File/Blob，Node 里传 Blob） */
  uploadFile(file, { title, visibility = 'public' } = {}) {
    const fd = new FormData();
    fd.append('file', file, (file && file.name) || 'file');
    if (title) fd.append('title', title);
    fd.append('visibility', visibility);
    return this.post('/api/files/upload', fd);
  }

  // ---------- 开放平台（OAuth） ----------
  /**
   * 用 OAuth 访问令牌读取用户信息（按授权 scope 过滤）。
   * 注意：这里需要的是**第三方应用的 OAuth 访问令牌**（oauth_tokens 里的 access_token），
   *       不是用户在本站的登录令牌；用登录令牌调用会返回 401 invalid_token。
   */
  userinfo(accessToken) {
    return this.request('GET', '/api/oauth/userinfo', { query: { access_token: accessToken || this.token } });
  }
  /** 可用权限范围说明（公开接口） */
  scopes() { return this.get('/api/oauth/scopes'); }
  /** 我授权过的应用 */
  myGrants() { return this.get('/api/oauth/grants'); }

  // ---------- 机器人（需要 client_id / client_secret） ----------
  botSend({ clientId, clientSecret, roomId, content }) {
    return this.post('/api/bot/send', { client_id: clientId, client_secret: clientSecret, room_id: roomId, content });
  }
  botMessages({ clientId, clientSecret, roomId, limit = 50 }) {
    return this.get('/api/bot/messages', { client_id: clientId, client_secret: clientSecret, room_id: roomId, limit });
  }
}

/** 第三方应用的 OAuth 2.0 授权码流程 */
class NFLSHCOAuth {
  constructor({ clientId, clientSecret = '', redirectUri, baseUrl = DEFAULT_BASE, fetchImpl = null }) {
    if (!clientId) throw new Error('缺少 clientId');
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.redirectUri = redirectUri;
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this._api = new NFLSHC({ baseUrl: this.baseUrl, fetchImpl });
  }
  /** 生成把用户送去授权的地址（浏览器直接跳转即可） */
  authorizeUrl({ scope = 'profile', state = '', redirectUri } = {}) {
    const qs = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri || this.redirectUri || '',
      response_type: 'code',
      scope,
      state: state || Math.random().toString(36).slice(2, 12),
    });
    return this.baseUrl + '/api/oauth/authorize?' + qs.toString();
  }
  /** 授权页要用到的应用信息（名称、可用 scope、已有授权） */
  authorizeInfo({ scope, state, redirectUri } = {}) {
    return this._api.get('/api/oauth/authorize-info', {
      client_id: this.clientId, redirect_uri: redirectUri || this.redirectUri, scope, state,
    });
  }
  /** 授权码换令牌（服务端调用；会带上 client_secret） */
  exchangeCode(code, { redirectUri } = {}) {
    return this._api.post('/api/oauth/token', {
      grant_type: 'authorization_code',
      code,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: redirectUri || this.redirectUri,
    });
  }
  /** 刷新令牌 */
  refresh(refreshToken) {
    return this._api.post('/api/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });
  }
  /** 吊销令牌 */
  revoke(token) {
    return this._api.post('/api/oauth/revoke', { token, client_id: this.clientId, client_secret: this.clientSecret });
  }
}

/** 把 ```json 围栏的 body 解析成对象（老数据兼容层） */
function parseFenced(row) {
  if (!row) return row;
  const src = typeof row === 'string' ? row : (row.body || row.raw_json || row.content);
  if (typeof src !== 'string') return row;
  const m = /```json\s*([\s\S]*?)```/.exec(src);
  if (!m) return row;
  try { return { ...row, data: JSON.parse(m[1]) }; } catch { return row; }
}

const NFLSHC_SDK_VERSION = '1.0.0';

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { NFLSHC, NFLSHCOAuth, NFLSHCError, parseFenced, NFLSHC_SDK_VERSION };
}
if (typeof window !== 'undefined') {
  window.NFLSHC = NFLSHC;
  window.NFLSHCOAuth = NFLSHCOAuth;
  window.NFLSHCError = NFLSHCError;
}
