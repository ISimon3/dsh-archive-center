# dsh-archive-center

DeepSeek Harness（dsh）的归档会话管理插件。在 **设置 → 归档会话** 中集中管理已归档的对话：浏览、搜索、恢复、彻底删除。

从零开发的原创插件（MIT），未基于任何第三方归档插件。

## 功能

- **浏览**：按工作区分组列出全部已归档会话（标题、目录、时间、预设）。
- **搜索**：关键词匹配标题/目录/id/预设，并同时检索会话正文（优先 FTS5 全文索引，不可用时自动逐会话扫描）。
- **对话预览**：点击标题展开最近 4 条用户/AI 消息，无需恢复即可确认是哪个会话。
- **恢复并打开**：通过官方公开 API `workspaceRegistry.unarchiveSession()` 取消归档，会话回到原工作区原位置。
- **彻底删除**：自动停止活跃 agent 后物理移除会话日志目录，并从归档集移除。**不可恢复**，需二次确认。
- **诊断**：列表为空时显示"归档集 / 会话存储 / 交集"三个计数，便于定位数据链路问题。

## 安装

```sh
dsh plugin --profile web add <本目录路径>
```

本机当前即以本地链接方式安装在 `web` profile（`~/.dsh/profiles/web`）。修改本目录代码后 `npm run build` 并重启 `dsh web` 即生效。

## 结构

- `src/index.js` — Host 半部：`archiveCenter` 服务（list / search / unarchive / delete / deleteMany / preview）+ 回环 HTTP 兜底路由 `/archive-center/api/*`。
- `src/client/index.js` — 浏览器半部：注册设置页 `settings.section`，服务代理优先、响应严格解包校验、HTTP 兜底。

## 安全边界

- 恢复只调用官方 registry API；删除仅作用于归档集中的会话，删除前校验目标目录名与会话 id 匹配。
- HTTP 兜底路由要求 Host 头合法、拒绝跨站请求、8 KiB 请求体上限。

## License

MIT
