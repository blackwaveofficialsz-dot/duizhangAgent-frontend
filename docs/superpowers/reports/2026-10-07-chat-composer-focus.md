# 首轮对话后输入焦点丢失修复

日期：2026-10-07，北京时间。

## 复现与原因

在本地浏览器新建对话，聚焦中央输入框，输入首个问题后按 Enter。消息出现后，中央输入框被卸载，页面底部的新输入框重新挂载；`document.activeElement` 变成 `BODY`。底部输入框自身既未 disabled，也未 readOnly，但继续键入文字不会进入它。

另在用户原有会话中完成第二轮发送及真实 Tavily 查询，确认该次运行的终态清理和同一会话提交路径可以正常工作。本次修复针对已复现的输入焦点问题。

## 修改

- `src/components/ChatWindow.tsx`：底部 Ant Design TextArea 挂载时通过现有 `autoFocus` 属性接续键盘焦点。
- `src/components/ChatWindow.test.tsx`：补充首轮发送导致输入框切换后的焦点回归测试，同时检查第二轮文字可输入、发送按钮可用。

没有新增依赖、轮询、定时器、请求或状态管理；不改变流式运行、终态、取消和防重复发送策略。回滚只需移除新增的 `autoFocus={!isCenter}` 属性。

## 验证

1. 修复前单独运行新增测试，因焦点落在 `BODY` 而失败，与真实浏览器复现一致。
2. `npm test -- src/components/ChatWindow.test.tsx src/hooks/useAguiChat.test.ts src/hooks/useAgentChat.test.ts src/api/agui.test.ts src/store/chatStore.test.ts`：5 个测试文件、120 项测试通过。
3. `npm run build`：TypeScript 检查和 Vite 生产构建通过。
4. `git diff --check`：通过。
5. 刷新本地浏览器后，在同一会话按 Enter 完成第一轮；无需重新点击输入框，直接通过键盘键入并发送第二轮。第二轮完成真实 Tavily 搜索并展示来源链接；随后再次直接键入第三轮草稿，输入框保持焦点，发送按钮可用。验证后清除测试草稿，保留已完成的两轮对话。

测试有既有 Ant Design Mobile px tester 和 jsdom textarea 高度警告；构建有既有 xlsx 混合导入和 chunk 大小警告。未把这些提示作为本次修复范围。

这是一处本地组件焦点修复，未改变 CPU、内存、数据库连接、Redis 或队列配置，也没有新增服务端调用开销；没有进行生产容量或高并发验证。

浏览器验收截图：

![同一会话两轮对话完成，底部输入框保持焦点](2026-10-07-chat-composer-focus.jpg)
