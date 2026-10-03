# 网页端扩展 · 端到端手测清单

- 日期：2026-09-23
- 对应计划：`docs/superpowers/plans/2026-09-23-web-chat-phase1-2.md` Task 10 Step 7
- 对应说明：`extension/README.md`
- 状态：**待实测**（逐条勾选，把结果写在每条下面）

条目按计划原文照录，不改措辞。第 4、5、7 条是几何/去重/作废这三处修复的落地验收点；
第 10 条是纯只读与「不打印正文」这两条硬约束的现场复核。

- [ ] 1. `chrome://extensions` 打开开发者模式，加载 `extension/dist`。
  - 结果：
- [ ] 2. 打开首站的一个测试会话，点扩展图标打开侧边栏，按提示授予该站点权限。
  - 结果：
- [ ] 3. 在 DevTools 控制台执行一次 `chrome.storage.local.set({llmKey: "...", llmBase: "...", llmModel: "..."})`
      填入 key（设置界面是后续任务的事）。
  - 结果：
  - 备注：侧边栏的 Settings 区块现在已经能直接填这三项，控制台这条是等效的备用路径。
- [ ] 4. 让测试对象发一条消息 → 侧边栏在几秒内显示意图与行动建议。
  - 结果：
- [ ] 5. 连发三条 → 只出现一次判断，且针对最后一条。
  - 结果：
- [ ] 6. 自己回一条 → 面板不再挂着上一条的判断。
  - 结果：
- [ ] 7. 切到另一个会话 → 上一个会话的在途结果不会串台显示。
  - 结果：
  - 备注：WhatsApp Web 切会话时 URL 不变，这条在 WhatsApp 上测不出来（已知限制，见
    `extension/README.md`）；请在 Telegram / Slack / Discord / Teams 任一站点上测。
- [ ] 8. 一分钟内快速发 21 条 → 面板出现保险丝提示，点 Resume 后恢复。
  - 结果：
- [ ] 9. 在页面上删掉消息容器（控制台 `document.querySelector(ROOT).remove()`）→
      面板显示 `layout changed`，不是静默空白。
  - 结果：
- [ ] 10. 全程检查：扩展没有往页面写任何东西，控制台没有打印消息正文。
  - 结果：

## 读不出消息时先看这里

侧边栏「Diagnostic」区块展开 → `containerSelector` 与 `candidateContainers`：

- 第一条候选如果是左边的会话列表（联系人预览行数通常远多于消息行数），说明容器选错了，
  `rowCount` 会明显偏大、行文本是联系人名；
- `directionSignal` 是 `weak` 或 `none`，说明方向判断没有真的分出两侧，
  `counts` 里 `unknown` 会占多数——此时 `isSelf` 判不出来的消息不会被当成回复目标，
  面板会一直停在「等待消息」，这是刻意的保守行为。

这段 JSON 只含结构、不含正文，可以直接贴进 issue。
