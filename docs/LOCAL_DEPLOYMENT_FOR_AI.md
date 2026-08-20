# Tomota Studio 本地部署说明（供 AI/自动化代理读取）

## 目标

把本仓库部署为 Windows 本机单用户 Web 工具。服务只监听 `127.0.0.1`，不得改成公网监听。仓库不包含作者作品、数据库、浏览器登录资料、Cookie、Token 或 Antigravity 凭据。

## 系统依赖

- Windows 10/11 x64。
- Python 3.11 或更高版本，命令名为 `python`。
- Node.js 20 或更高版本，包含 `npm`。
- Google Chrome 或 Microsoft Edge，用于番茄的可见浏览器会话。
- Google Antigravity/AGY CLI，用于生产生成；安装与登录必须走其官方流程。
- 仓库已内置 `skills\webnovel-writing` 写作 Skill 核心，无需额外下载。
- 可选：把内置 Skill 安装到 Codex，或用环境变量指定用户自己的完整版 Skill。

## 禁止事项

- 不要复制另一台机器的 `tomota.db`、`studio.db`、`.tomota-studio`、`books`、浏览器 profile 或 `.env`。
- 不要读取、迁移、导出或提交 Cookie、Token、密码、验证码、二维码或浏览器存储。
- 不要把服务绑定到 `0.0.0.0`，不要自动开放防火墙端口。
- 不要在安装阶段登录番茄、执行发布、修改云端作品或处理实名/合同/收益区域。

## 标准部署

在 PowerShell 中进入克隆后的仓库根目录：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup_windows.ps1
```

脚本执行以下动作：

1. 验证 Python、Node.js 和 npm 版本。
2. 创建仓库内的 `.venv`。
3. 以 editable 模式安装 `tomota-writer`、`PyYAML` 与 Windows 时区数据 `tzdata`。
4. 使用锁文件执行 `npm ci`。
5. 构建 React 前端和 Node TypeScript 服务。
6. 默认运行 Python、Studio 和浏览器桥接测试。
7. Tomota 直接使用仓库内置 Skill；增加 `-InstallCodexSkill` 时才会把它安装到当前用户的 Codex 目录。

如只需要快速安装，可使用 `-SkipTests`；正式交付不建议跳过。

## Skill 使用与安装

Tomota Studio 开箱即用，不需要复制 Skill：

```text
<仓库>\skills\webnovel-writing
```

如需让 Codex 也识别同一套 Skill：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install_codex_skill.ps1
```

也可在总安装命令中添加 `-InstallCodexSkill`。如果目标目录已经存在，安装会安全停止；只有用户明确运行下列命令时才替换，并先保存时间戳备份：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install_codex_skill.ps1 -Replace
```

内置版包含主说明、十个专项模块、模板、正反例和审查规则。下载的小说原文、PDF、抓取工具和生成的语料索引不随项目分发。需要用户自有完整版 Skill 时，设置 `TOMOTA_WEBNOVEL_SKILL_ROOT` 指向其目录即可。

## 启动

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start_windows.ps1
```

默认地址：`http://127.0.0.1:43127/`。

端口被占用时：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start_windows.ps1 -Port 44127 -ApiPort 44128
```

## 可选环境变量

- `TOMOTA_AGY_EXECUTABLE`：AGY CLI 的完整路径。
- `TOMOTA_CHROME_PATH`：Chrome/Edge 可执行文件完整路径。
- `TOMOTA_STORY_SKILL_ROOT`：覆盖为用户自己的整合型 story skill 根目录。
- `TOMOTA_WEBNOVEL_SKILL_ROOT`：覆盖内置版的 `webnovel-writing` Skill 根目录。
- `TOMOTA_AGY_PREFIX_ARGS`：传给 AGY 的 JSON 参数数组；非必要不要设置。

`.env.example` 只用于说明，程序不会自动读取它。环境变量应由用户在当前 PowerShell 会话或其可信本机配置中设置。

## 初次验收

1. 打开 Studio，确认页面显示项目为空或只包含本机新建项目。
2. 在“系统设置”检查 AGY、Skill 和 Chrome/Edge 状态。
3. AGY 未登录时只提示用户走官方登录，不收集凭据。
4. 在“番茄运营”添加账号后打开可见浏览器，由用户本人扫码。
5. 先执行只读同步。没有明确批次确认时，不测试云端写入。

## 数据位置

- 作品与工作流：`<仓库>\books\` 和 `<仓库>\tomota.db`。
- Studio 运行数据：`<仓库>\studio.db`、`<仓库>\.tomota-studio\`。
- 番茄独立浏览器 profile：`%LOCALAPPDATA%\TomotaStudio\fanqie-profiles\`。

以上路径均被 Git 忽略。备份时应由用户单独加密保存，不应提交到代码仓库。

## 更新与复验

```powershell
git pull --ff-only
powershell -ExecutionPolicy Bypass -File .\scripts\setup_windows.ps1
```

更新后必须重新构建并测试。若平台页面结构、登录状态或发布结果不明确，保持停止状态并重新同步，禁止盲目重复提交。
