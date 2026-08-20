# Tomota Writer

本项目是一个本地优先的中文网文写作中台，仓库已内置可移植的
`webnovel-writing` Skill 核心。全新电脑无需先安装 Skill，Tomota 会直接读取
仓库内的模块、模板与审查规则，锁定文件哈希，按阶段路由任务，并把生成和审查记录到本地。

## Tomota Studio

Tomota Studio 是本项目的本地可视化控制台。Google Antigravity 负责生成当前阶段产物，
Tomota 严格状态机负责验证和推进；没有 Codex/OpenAI 生产后备。依赖 Python 3.11+、Node.js 22.13+、npm、Google Chrome 或 Microsoft Edge。Node 22.13 是内置 SQLite 运行时的最低版本。首次使用先安装依赖并构建：

```powershell
$repo = (Get-Location).Path
Set-Location "$repo\studio"
npm ci
npm run build
Set-Location $repo
python -m pip install -e .
tomota studio
```

Windows 也可以直接使用仓库内的部署脚本：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup_windows.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\start_windows.ps1
```

如需让 Codex 本身也使用仓库内的同一套 Skill，可在安装时增加开关：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup_windows.ps1 -InstallCodexSkill
```

或单独运行 `scripts/install_codex_skill.ps1`。目标目录已存在时脚本不会覆盖；明确使用
`-Replace` 时会先把旧 Skill 移到带时间戳的备份目录。详见 [skills/README.md](skills/README.md)。

完整的迁移、依赖、数据隔离与 AI 自动部署约束见 [docs/LOCAL_DEPLOYMENT_FOR_AI.md](docs/LOCAL_DEPLOYMENT_FOR_AI.md)。

工作台只监听 `127.0.0.1`，首次启动会为 `tomota.db` 建立只读备份和现有作品文件哈希清单，
不会移动或覆盖原稿。AGY CLI 未安装或登录失效时，生成任务会停在当前阶段并显示处理说明。
番茄运营使用独立的可见 Chrome/Edge 配置目录；扫码、验证码和风控均由用户在浏览器完成，
Studio 不提供 Cookie、Token、密码或验证码读取接口。

常用机器接口全部输出 JSON：

```powershell
tomota workflow status --run-id workflow-xxxxxxxxxxxx --json
tomota fanqie policy --json
tomota fanqie session --book-id demo --json
```

## 快速开始

```powershell
python -m pip install -e .
tomota skill refresh-lock
tomota skill verify
tomota init --book-id demo --title "未命名长篇" --synopsis "主角在一次异常事件后被迫做出选择。"
tomota plan --book-id demo
tomota status --book-id demo
```

正式写作使用可断点续跑的严格状态机；旧 `autopilot` 只保留为兼容入口，不能自行批准章节：

```powershell
tomota workflow start --book-id demo --chapters 1,2 --max-revisions 5
tomota workflow next --run-id workflow-xxxxxxxxxxxx
tomota workflow submit --run-id workflow-xxxxxxxxxxxx --file D:\artifact.json
tomota workflow status --run-id workflow-xxxxxxxxxxxx
tomota release --book-id demo
tomota publish --batch batch-xxxxxxxxxxxx --confirm "PUBLISH batch-xxxxxxxxxxxx" --dry-run
```

严格流程依次完成故事圣经、场景卡、设计审查、正文、三轮专项审查与返工、无提示冷审、带正文证据的 Canon 更新。每章最多五轮返工；任一审查门缺少非空证据都保持 `blocked`。详见 [docs/STRICT_WORKFLOW.md](docs/STRICT_WORKFLOW.md)。

`tomota run` 仍然保留为同一流程的兼容入口；`--no-release` 可关闭自动准备发布批次，`--mock` 仅用于测试。

如果当前 Codex 已经根据 PromptPack 生成了规划或正文，可直接导入：

```powershell
tomota ingest-outline --book-id demo --file D:\稿件\第一卷章纲.md
tomota ingest-outline --book-id demo --file D:\稿件\chapters.json
tomota ingest --book-id demo --chapter 1 --file D:\稿件\第1章.txt
```

正文导入会沿用本地已有章节契约；没有契约时，需要额外提供
`--title --objective --obstacle --change --next-first-beat`。导入后必审，失败章节保持
`blocked`，不会进入发布队列。

生产生成由 Google Antigravity 承担。Tomota 不会在 Antigravity 不可用时自动切换到其他模型；任务会保留在当前阶段，等待恢复或人工处理。

旧版命令行适配器仍可用于兼容或独立测试，但不属于 Studio 的生产生成后备：

```powershell
# 兼容适配器 A：本地模型命令。命令从 stdin 读取 JSON，输出正文或 {"text":"正文"}
$env:TOMOTA_GENERATOR_COMMAND = "python D:\\tools\\tomota_model_runner.py"
tomota autopilot --book-id demo --generator command

# 兼容适配器 B：Responses API；密钥只从环境变量读取，不写入项目
$env:OPENAI_API_KEY = "你的密钥"
$env:TOMOTA_OPENAI_MODEL = "gpt-5.4"
tomota autopilot --book-id demo --generator openai
```

如果没有模型运行时，`auto` 模式会把整批任务汇总为一个交接包并停止，不会要求你逐章复制 PromptPack。`--mock` 只用于测试，不能作为正式正文生成器。发布命令默认只使用 dry-run 驱动，真实浏览器驱动需要由已登录的官方浏览器会话接入。

真实浏览器发布采用“两段式桥接”：先导出任务，再在当前已登录的番茄官方浏览器会话中运行
`scripts/fanqie_browser_driver.mjs`。Python 不接触浏览器凭据；桥接层只使用可见页面，遇到
验证码、实名、人脸认证、安全验证或页面结构变化立即停止。示例：

```powershell
tomota publish --mode browser --batch batch-xxxxxxxxxxxx --confirm "PUBLISH batch-xxxxxxxxxxxx"
```

然后在当前浏览器会话的脚本入口执行桥接函数。先用 `submit: false` 检查登录态和作品匹配；
确认页面正确后，再把它改为 `submit: true` 执行已确认批次：

```javascript
const { runFanqiePublishJob } = await import("C:/path/to/tomota/scripts/fanqie_browser_driver.mjs");
await runFanqiePublishJob({
  browser,
  jobPath: "C:/path/to/tomota/books/demo/publish/jobs/batch-xxxxxxxxxxxx.json",
  confirmation: "PUBLISH batch-xxxxxxxxxxxx",
  submit: false,
});
```

实际写入时还需在当次调用中提供 `actionConfirmation: "WRITE <批次编号>"`，并按任务文件正文哈希提供逐章 `chapterConfirmations`；不要把这些确认提前写进任务文件。

完成后回写：

```powershell
tomota publish --mode browser --batch batch-xxxxxxxxxxxx --reconcile
```

桥接脚本默认为预览；实际写入还要求 `WRITE <批次编号>`，逐章提交要求
`SUBMIT <批次编号>:<章节号>:<正文哈希前12位>` 的操作时确认。它不会保存密码、Cookie、验证码或实名资料，也不会调用番茄私有接口。

废稿清理默认只预览；显式 `--apply` 才清除七天回收内容：

```powershell
tomota cleanup --book-id demo
tomota cleanup --book-id demo --apply
```

Tomota 默认使用仓库内置路径：

```text
<仓库>\skills\webnovel-writing
```

可通过环境变量 `TOMOTA_WEBNOVEL_SKILL_ROOT` 覆盖为用户自己的完整版 Skill。可移植版不包含下载的小说原文、PDF、抓取工具和语料索引；系统不会读取密码、Cookie、验证码或浏览器存储，也不会绕过番茄的实名和风控流程。

## 生成方式

当前 Codex skill 本身是提示词和资料运行时，不是本地模型 API。Tomota 已提供 `command` 和 `openai` 两种自动生成适配器；无运行时配置时才回退为可追踪的单批次 PromptPack 交接包。

## 目录

```text
config/      skill 锁文件
skills/      可移植的 webnovel-writing Skill 核心与安装说明
library/     运行时索引和规则快照
books/       书籍、Canon、章纲、正文、审查和发布记录
src/tomota/  适配器、路由、流水线、审查、存储和发布接口
scripts/     番茄官方浏览器会话桥接脚本
tests/       unittest 测试
```
