# 鼠标发送后与历史会话切换后的输入焦点修复

日期：2026-10-07，北京时间。本报告补充此前首轮中央输入框移到底部的焦点修复。

## 复现与根因

检查用户当前窗口，输入框没有 disabled、readOnly 或遮挡，点击 textarea 内部可输入。在已存在消息的会话中，输入第二个问题并用鼠标点击发送按钮，焦点落到 BODY。回复完成后直接通过键盘输入，textarea 的 value 仍为空，activeElement 仍为 BODY。

此前 `autoFocus={!isCenter}` 只在底部输入框挂载时执行，覆盖了首轮回车发送导致输入框重新挂载的路径。后续鼠标发送不会重新挂载输入框，发送按钮失焦后没有恢复输入焦点；切换已有历史会话也复用该输入框，原 autoFocus 不会重新执行。前次回归未覆盖这两种交互。

## 修改范围

- `src/components/ChatWindow.tsx`：通过现有 Ant Design TextArea ref，在会话切换或发送结束时恢复输入焦点，使用 `preventScroll` 保持消息区位置；保留首轮输入框重新挂载时的 autoFocus。
- `src/components/ChatWindow.test.tsx`：补鼠标发送后接续输入、切换已有会话后接续输入两项回归测试。

没有新增依赖、定时器、监听器、后端请求或流式状态管理。未改变断线、审批等未完成 AG-UI 任务的防重复发送限制。

## 验证

新增两项测试在修复前均失败：发送完成后焦点仍在按钮，切换会话后焦点为 BODY。修复后执行：

```sh
npm test -- src/components/ChatWindow.test.tsx src/hooks/useAguiChat.test.ts src/hooks/useAgentChat.test.ts src/api/agui.test.ts src/store/chatStore.test.ts
npm run build
git diff --check
```

实际结果：5 个文件、122 项测试通过；TypeScript 和 Vite 构建通过；diff 检查退出码 0。测试保留既有 Ant Design Mobile px tester、jsdom textarea 高度提示；构建保留既有 xlsx 混合导入和 chunk 大小提示。

真实浏览器刷新后，新建验收会话，三轮均用鼠标点击发送按钮。每轮回复完成后检查 activeElement 为对话 textarea，直接通过键盘输入下一轮，不调用 fill 或重新点击输入框。三轮分别收到「你好」「第二轮收到」「第三轮收到」。第三轮完成后输入框为空、有焦点、未 disabled、未 readOnly。

另切换到用户原有「你好，我需要昨日美股数据」会话，不重新聚焦即可通过键盘输入草稿，发送按钮可用。验证后清除测试草稿，最后切回用户原有会话，输入框保持焦点。

证据截图：`2026-10-07-chat-composer-mouse-multiturn.jpg`，显示同一会话完成三轮回复和底部输入框的焦点边框。

## 资源与边界

新增 effect 仅由会话 ID 和本地 sending 状态触发，不随每条 token 更新重复执行；每次最多调用一次组件 focus，不创建需要清理的后台资源。没有数据库、Redis、队列或模型调用增量，也未调整并发、连接池或容量限制。没有进行生产高并发测试；上述证据验证本机鼠标发送、键盘接续输入及历史切换路径。

回滚本轮增量可删除 composerRef、ref 属性及对应 focus effect；保留首轮 autoFocus 修复和既有运行状态限制。
