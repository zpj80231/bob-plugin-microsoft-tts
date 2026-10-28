
## v1.1.1 (2026-10-28)

### Fixes

- 修复 Edge TTS 间歇性报「WebSocket 连接失败：`{"code":0,"type":...}`」的问题：微软 `api.msedgeservices.com` 会间歇性以 HTTP 429 拒绝 WebSocket 握手（实测成功率约 50%~85%，响应体为空且没有 `Retry-After`）。现在连接阶段失败会自动按指数退避重试，最多 4 次（200 / 400 / 800ms + 抖动）；服务端明确拒绝的错误（如 `Unsupported voice`）不重试。
- Edge TTS 错误提示可读化：不再直接输出 Bob 原生层错误对象的 JSON，改为提取可读描述（如「服务端拒绝握手（HTTP 状态非 101，常见于限流 429 或封禁 403）」）；命中 429 时提示「服务端限流」，重试耗尽时附带尝试次数。
- Edge TTS 新增 10 秒握手超时与连接关闭（`listenClose`）处理，避免服务端拒绝连接时一直等到插件超时。

## v1.1.0 (2026-10-13)

### Fixes

- 更新 Edge TTS 合成端点
- 修复 Edge TTS 合成报 403 的问题：微软自 2026 年 10 月起下线旧合成端点，合成 WebSocket 迁移至 `api.msedgeservices.com/tts/cognitiveservices/websocket/v1`（Token 改以 `Ocp-Apim-Subscription-Key` 参数传递，签名与请求头不变，音频输出不变）。

## v1.0.0 (2026-05-26)

### Features

- 支持 Edge TTS、Azure 认知服务、Azure 体验服务和 OpenAI 兼容网关四种合成方案。
- 支持简体中文、繁体中文、英语、日语、韩语常用语音。
- 支持情感风格、语速、音调、音量和输出音质配置。
- 支持长文本自动分块、并发合成和音频拼接。
- 内置 429 限流和 5xx 服务端错误的指数退避重试。
