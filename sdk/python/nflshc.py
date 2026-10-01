"""NFLSHC Chat 开放平台 · Python SDK（仅用标准库，Python 3.8+）
---------------------------------------------------------------------------
两种用法：

1) 用户身份调用（已有登录令牌）

    from nflshc import NFLSHC
    api = NFLSHC(token="<Bearer token>")
    print(api.me())
    api.send_message(room_id="room_x", sender="alice", content="你好")

2) 第三方应用（OAuth 2.0 授权码模式，client_secret 只放在服务端）

    from nflshc import NFLSHCOAuth, NFLSHC
    oauth = NFLSHCOAuth(client_id="...", client_secret="...", redirect_uri="https://your.app/cb")
    print(oauth.authorize_url(scope="profile friends", state="xyz"))   # 让用户跳转
    tokens = oauth.exchange_code(code)                                 # 回调里用 code 换令牌
    api = NFLSHC(token=tokens["access_token"])
    print(api.userinfo())

接口基址：https://worker.nflshcchat.cc.cd
完整接口文档见仓库 docs/API.md
"""

from __future__ import annotations

import json
import random
import string
import urllib.error
import urllib.parse
import urllib.request

__version__ = "1.0.0"
DEFAULT_BASE = "https://worker.nflshcchat.cc.cd"


class NFLSHCError(Exception):
    """接口返回非 2xx 时抛出，保留状态码与响应体。"""

    def __init__(self, message: str, status: int = 0, body=None):
        super().__init__(message)
        self.status = status
        self.body = body


class NFLSHC:
    def __init__(self, token: str = "", base_url: str = DEFAULT_BASE, timeout: int = 60):
        self.token = token
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    # ---------------- 底层 ----------------
    def request(self, method: str, path: str, body=None, query=None, form: dict | None = None):
        url = self.base_url + (path if path.startswith("/") else "/" + path)
        if query:
            clean = {k: v for k, v in query.items() if v not in (None, "")}
            if clean:
                url += ("&" if "?" in url else "?") + urllib.parse.urlencode(clean)

        data = None
        headers = {"Accept": "application/json", "User-Agent": "nflshc-python-sdk/" + __version__}
        if self.token:
            headers["Authorization"] = "Bearer " + self.token
        if form is not None:
            data = urllib.parse.urlencode(form).encode("utf-8")
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        elif body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"

        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", "replace")
            parsed = _safe_json(raw)
            msg = (parsed or {}).get("error") or (parsed or {}).get("message") or ("HTTP %s" % e.code)
            raise NFLSHCError(msg, e.code, parsed) from None
        except urllib.error.URLError as e:
            raise NFLSHCError("网络错误：%s" % e.reason) from None

        return _safe_json(raw) if raw else None

    def get(self, path: str, **query):
        return self.request("GET", path, query=query or None)

    def post(self, path: str, body=None, form=None):
        return self.request("POST", path, body=body, form=form)

    # ---------------- 账号 ----------------
    def me(self):
        """当前令牌对应的用户（{"ok": True, "username": ..., "isAdmin": ...}）"""
        return self.get("/api/auth/me")

    def sessions(self):
        """我的登录设备列表"""
        return self.get("/api/auth/sessions")

    def revoke_session(self, session_id: str):
        return self.request("DELETE", "/api/auth/sessions/" + urllib.parse.quote(session_id))

    def revoke_other_sessions(self):
        return self.post("/api/auth/sessions/revoke-others", {})

    def export_account(self):
        """导出我的全部数据（dict）"""
        return self.get("/api/account/export")

    def request_account_deletion(self, confirm: str, reason: str = ""):
        return self.post("/api/account/delete", {"confirm": confirm, "reason": reason})

    def cancel_account_deletion(self):
        return self.post("/api/account/delete/cancel", {})

    def account_status(self):
        return self.get("/api/account/status")

    # ---------------- 消息 ----------------
    def messages(self, room_id: str, limit: int = 100):
        """拉取聊天室消息，并自动解析 ```json 围栏"""
        rows = self.get("/api/messages", room_id=room_id, limit=limit)
        if isinstance(rows, dict):
            rows = rows.get("rows") or []
        return [_parse_fenced(r) for r in (rows or [])]

    def send_message(self, room_id: str, sender: str, content: str, mentions=None, reply_to=None, msg_id=None):
        if msg_id is None:
            msg_id = "msg_%d_%s" % (_now_ms(), "".join(random.choices(string.ascii_lowercase + string.digits, k=8)))
        return self.post("/api/messages", {
            "id": msg_id,
            "room_id": room_id,
            "sender": sender,
            "content": content,
            "mentions": mentions or [],
            "reply_to": reply_to,
            "timestamp": _now_iso(),
        })

    # ---------------- 好友 / 收藏 ----------------
    def friends(self):
        return self.get("/api/friends")

    def favorites(self):
        return self.get("/api/favorites")

    # ---------------- 会议 ----------------
    def create_meeting(self, title: str, kind: str = "instant", scheduled_at: str = None,
                       duration_min: int = 60, invitees=None, password: str = None, note: str = None):
        return self.post("/api/meeting/create", {
            "title": title, "kind": kind, "scheduledAt": scheduled_at,
            "durationMin": duration_min, "invitees": invitees or [],
            "password": password, "note": note,
        })

    def list_meetings(self):
        return self.get("/api/meeting/list")

    def join_meeting(self, code: str, password: str = None):
        return self.post("/api/meeting/join", {"code": code, "password": password})

    def meeting_detail(self, meeting_id: str):
        return self.get("/api/meeting/detail", id=meeting_id)

    def meeting_chat(self, meeting_id: str, since: str = None):
        return self.get("/api/meeting/chat", meetingId=meeting_id, since=since)

    def send_meeting_chat(self, meeting_id: str, content: str):
        return self.post("/api/meeting/chat", {"meetingId": meeting_id, "content": content})

    def end_meeting(self, meeting_id: str):
        return self.post("/api/meeting/end", {"meetingId": meeting_id})

    def ice_servers(self):
        """WebRTC ICE 配置（只含公共 STUN，不含 TURN）"""
        return self.get("/api/rtc/ice")

    # ---------------- 笔记 ----------------
    def list_notes(self):
        return self.get("/api/notes/list")

    def get_note(self, note_id: str):
        return self.get("/api/notes/get", id=note_id)

    def create_note(self, title: str = None, content: str = None, kind: str = "note", meeting_id: str = None):
        return self.post("/api/notes/create", {"title": title, "content": content, "kind": kind, "meetingId": meeting_id})

    def update_note(self, note_id: str, title: str = None, content: str = None):
        payload = {"id": note_id}
        if title is not None:
            payload["title"] = title
        if content is not None:
            payload["content"] = content
        return self.post("/api/notes/update", payload)

    def delete_note(self, note_id: str):
        return self.post("/api/notes/delete", {"id": note_id})

    def share_note(self, note_id: str, username: str, can_edit: bool = False):
        return self.post("/api/notes/share", {"id": note_id, "username": username, "canEdit": can_edit})

    def unshare_note(self, note_id: str, username: str):
        return self.post("/api/notes/unshare", {"id": note_id, "username": username})

    def meeting_note(self, meeting_id: str, create: bool = False):
        return self.get("/api/notes/meeting", meetingId=meeting_id, create=1 if create else None)

    # ---------------- 学习（讲题 / 错题本） ----------------
    def solve_question(self, question: str = None, image_url: str = None, subject: str = None, save: bool = False):
        return self.post("/api/study/solve", {"question": question, "imageUrl": image_url, "subject": subject, "save": save})

    def list_mistakes(self, subject: str = None, status: str = None, q: str = None):
        return self.get("/api/study/mistakes", subject=subject, status=status, q=q)

    def add_mistake(self, question: str, **kw):
        payload = {"question": question}
        payload.update(kw)
        return self.post("/api/study/mistakes", payload)

    def update_mistake(self, mistake_id: str, **kw):
        payload = {"id": mistake_id}
        payload.update(kw)
        return self.post("/api/study/mistakes/update", payload)

    def delete_mistake(self, mistake_id: str):
        return self.post("/api/study/mistakes/delete", {"id": mistake_id})

    def practice(self, mistake_id: str = None, question: str = None, count: int = 2):
        return self.post("/api/study/practice", {"id": mistake_id, "question": question, "count": count})

    # ---------------- 开放平台 ----------------
    def userinfo(self, access_token: str = None):
        """用访问令牌读取用户信息（按授权 scope 过滤）"""
        return self.get("/api/oauth/userinfo", access_token=access_token or self.token)

    def oauth_scopes(self):
        return self.get("/api/oauth/scopes")

    def my_grants(self):
        return self.get("/api/oauth/grants")

    # ---------------- 机器人 ----------------
    def bot_send(self, client_id: str, client_secret: str, room_id: str, content: str):
        return self.post("/api/bot/send", {"client_id": client_id, "client_secret": client_secret,
                                           "room_id": room_id, "content": content})

    def bot_messages(self, client_id: str, client_secret: str, room_id: str, limit: int = 50):
        return self.get("/api/bot/messages", client_id=client_id, client_secret=client_secret,
                        room_id=room_id, limit=limit)


class NFLSHCOAuth:
    """第三方应用的 OAuth 2.0 授权码流程"""

    def __init__(self, client_id: str, client_secret: str = "", redirect_uri: str = "", base_url: str = DEFAULT_BASE):
        if not client_id:
            raise ValueError("缺少 client_id")
        self.client_id = client_id
        self.client_secret = client_secret
        self.redirect_uri = redirect_uri
        self.base_url = base_url.rstrip("/")
        self._api = NFLSHC(base_url=self.base_url)

    def authorize_url(self, scope: str = "profile", state: str = "", redirect_uri: str = "") -> str:
        """生成把用户送去授权的地址（浏览器直接跳转即可）"""
        qs = urllib.parse.urlencode({
            "client_id": self.client_id,
            "redirect_uri": redirect_uri or self.redirect_uri,
            "response_type": "code",
            "scope": scope,
            "state": state or "".join(random.choices(string.ascii_lowercase + string.digits, k=12)),
        })
        return self.base_url + "/api/oauth/authorize?" + qs

    def authorize_info(self, scope: str = "", state: str = "", redirect_uri: str = ""):
        return self._api.get("/api/oauth/authorize-info", client_id=self.client_id,
                             redirect_uri=redirect_uri or self.redirect_uri, scope=scope, state=state)

    def exchange_code(self, code: str, redirect_uri: str = ""):
        """授权码换令牌（服务端调用，带 client_secret）"""
        return self._api.post("/api/oauth/token", {
            "grant_type": "authorization_code",
            "code": code,
            "client_id": self.client_id,
            "client_secret": self.client_secret,
            "redirect_uri": redirect_uri or self.redirect_uri,
        })

    def refresh(self, refresh_token: str):
        return self._api.post("/api/oauth/token", {
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": self.client_id,
            "client_secret": self.client_secret,
        })

    def revoke(self, token: str):
        return self._api.post("/api/oauth/revoke", {
            "token": token, "client_id": self.client_id, "client_secret": self.client_secret,
        })


# ---------------- 内部工具 ----------------
def _safe_json(raw: str):
    try:
        return json.loads(raw)
    except Exception:
        return {"raw": raw}


def _parse_fenced(row):
    """把 ```json 围栏的 body 解析成对象（老数据兼容层）"""
    if not isinstance(row, dict):
        return row
    src = row.get("body") or row.get("raw_json") or row.get("content")
    if not isinstance(src, str):
        return row
    start = src.find("```json")
    end = src.rfind("```")
    if start == -1 or end <= start:
        return row
    payload = src[start + 7:end].strip()
    try:
        out = dict(row)
        out["data"] = json.loads(payload)
        return out
    except Exception:
        return row


def _now_ms() -> int:
    import time
    return int(time.time() * 1000)


def _now_iso() -> str:
    import datetime
    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
