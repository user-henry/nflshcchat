# NFLSHC Chat + Star Office UI 集成项目

## 项目状态

当前版本：备份已就绪，待下载 Star Office 后端文件

### 已完成
- ✅ 原项目备份：`nflshcchat-staroffice/` (原 nflshcchat 完整复制)
- ✅ Token 已更新为新 Token
- ⚠️ Star Office 后端文件待下载

### 待完成（需要网络正常时）

1. **下载 Star Office 后端文件**
   
   在网络正常时，手动下载以下文件到 `nflshcchat-staroffice/backend/`：
   
   - https://raw.githubusercontent.com/ringhyacinth/Star-Office-UI/master/backend/app.py
   - https://raw.githubusercontent.com/ringhyacinth/Star-Office-UI/master/backend/store_utils.py
   - https://raw.githubusercontent.com/ringhyacinth/Star-Office-UI/master/backend/memo_utils.py
   - https://raw.githubusercontent.com/ringhyacinth/Star-Office-UI/master/backend/security_utils.py
   - https://raw.githubusercontent.com/ringhyacinth/Star-Office-UI/master/backend/requirements.txt

2. **部署到 Railway（免费）**
   
   ```bash
   # 安装 Railway CLI
   npm install -g @railway/cli
   
   # 登录
   railway login
   railway link
   
   # 创建项目（按提示操作）
   railway init
   railway up
   ```

3. **推送到 GitHub**
   
   ```bash
   cd nflshcchat-staroffice
   git add .
   git commit -m "Add Star Office UI backend"
   git push origin main
   ```

### 项目结构

```
nflshcchat-staroffice/
├── index.html           # 原 nflshcchat 首页
├── config.js         # 已更新 token
├── backend/        # Star Office 后端 (待添加)
│   ├── app.py
│   ├── store_utils.py
│   ├── memo_utils.py
│   ├── security_utils.py
│   └── requirements.txt
└── ...
```

## Star Office 功能

- AI 工作状态实时可视化（idle/writing/researching/executing/syncing/error）
- 像素风格办公室动画
- 昨日小记（从 memory 读取）
- 多语言支持（CN/EN/JP）

## 访问方式

- 原 nflshcchat：https://user-henry.github.io/nflshcchat
- Star Office 后端：Railway 分配的计算资源（类似 https://xxx.up.railway.app）

---
Generated: 2026-05-04