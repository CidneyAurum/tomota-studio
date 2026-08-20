# Tomota 严格写作状态机

正式章节只走这一条状态链：

```text
故事圣经 → 章节场景卡 → 设计审查 → 正文
→ 逻辑审查/返工 → 人物对白审查/返工 → 伏笔与承接审查/返工
→ 无提示冷审/返工 → Canon 证据提取 → approved
```

每个审查结论必须有正文或设计证据。问题记录必须同时包含位置、原文、分类、违反规则和修复要求。`evidence` 为空、检查项缺失、存在开放问题或缺少任一审查门时，系统拒绝批准。

## Codex 驱动接口

```powershell
tomota workflow start --book-id demo --chapters 1,2 --max-revisions 5
tomota workflow next --run-id workflow-xxxxxxxxxxxx
tomota workflow submit --run-id workflow-xxxxxxxxxxxx --file D:\artifact.json
tomota workflow status --run-id workflow-xxxxxxxxxxxx
```

`next` 只生成当前阶段所需的紧凑任务包，并显示阶段、问题数和返工轮次。状态写入 SQLite 和书籍的 `workflow/<run-id>/state.json`，中断后可继续。任一章五轮返工后仍失败，整条队列停在 `blocked`，后续章节不会启动。

## 存储与清理

每章工作区只保留当前稿与上一稿。更早的工作稿、完整提示词和临时报告移动到 `books/<book-id>/.trash`；默认保留七天。手动清理永远先预览：

```powershell
tomota cleanup --book-id demo
tomota cleanup --book-id demo --apply
```

单书回收区上限为 100 MB；超限时从最旧回收内容开始清理。清理器只能删除 `.trash` 内文件，不能选择最终稿、章纲、Canon、人物/伏笔账本、审查报告或发布记录。云端内容不属于清理范围。

## 番茄边界

浏览器会话只记录 `logged_in/auth_required` 和页面可见作品信息，不记录 Cookie、Token、密码、验证码或二维码。默认范围仅包括作品、章节草稿、审核状态、排期和运营数据。实名、合同、收益、银行卡、税务和安全设置全部阻止；作品或公开章节删除永不自动执行。

发布桥接分三道边界：严格审查证据通过、明确批次确认、浏览器写入与逐章提交的操作时确认。遇到登录失效、验证码、风控、页面结构变化、网络不确定或重复章节时停止并重新读取状态，不盲目重试。
