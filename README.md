# Microsoft TTS Bob 插件

> 基于 Microsoft Azure / Edge TTS 的免 API Key 文字转语音 Bob 插件

[![Bob](https://img.shields.io/badge/Bob-1.8.0%2B-blue.svg)](https://bobtranslate.com/)

## 特性

- **4 种合成方案**：Edge TTS / Azure 认知服务 / Azure 体验服务 / OpenAI 兼容网关，按需切换
- **零密钥、零部署**：Edge TTS 通过模拟 Edge 浏览器 WebSocket 协议免费使用；Azure 认知服务通过模拟 Microsoft Translator 客户端签名动态获取临时 Token，无需 API Key
- **长文本自动分块**：超过 1500 字符的文本按句子边界自动拆分，批量并发请求后拼接
- **自动重试**：429 限流和 5xx 服务端错误自动指数退避重试
- **5 语种 + 多情感**：简中、繁中、英、日、韩；支持 general / cheerful / sad / angry 等情感风格
- **全可调**：语速 / 音调 / 音量 / MP3 音质 / 情感风格逐项切换

<p>
<img src=".images/bob-plugin-microsoft-tts-1.png" alt="Microsoft TTS Bob 插件配置截图 1" />
<img src=".images/bob-plugin-microsoft-tts-2.png" alt="Microsoft TTS Bob 插件配置截图 2" />
</p>

## Provider 说明

| Provider | 认证方式 | 协议 | 适用场景                      |
|----------|---------|------|---------------------------|
| `edge-tts`（推荐） | Sec-MS-GEC 签名 | WebSocket | 逆向 Edge 浏览器的大声朗读，免费稳定     |
| `azure-cognitive` | MSTranslatorAndroidApp 签名 | HTTP REST | 功能最全，支持情感风格、长文本分块         |
| `azure-trial` | 无需认证 | HTTP REST | Azure 官网接口，易触发 429 限流     |
| `openai-gateway` | 无（透传到网关） | HTTP REST | 自建 OpenAI 兼容网关或第三方服务，绕过直连限制 |

## 安装

1. 从 [Releases](https://github.com/zpj80231/bob-plugin-microsoft-tts/releases) 下载最新 `.bobplugin` 文件
2. 双击安装到 Bob，Bob 设置 → 服务 → 语音合成 → 添加
3. 在 Bob 设置中将 "语音合成" 切换为本插件

## 配置项

| 配置 | 类型 | 默认 | 说明 |
|------|------|------|------|
| 合成方案 (provider) | menu | `edge-tts` | 选择 TTS Provider |
| zh-CN / zh-TW / en-US / ja-JP / ko-KR 语音 | menu | 各语种主流女声 | 按个人偏好挑男声/女声 |
| 语速 (rate) | menu | `+0%` | `-50% ~ +50%`；觉得拖沓 → `+10%` ~ `+25%` |
| 音调 (pitch) | menu | `+0Hz` | `-50Hz ~ +50Hz` |
| 音量 (volume) | menu | `+0%` | `-50% ~ +50%` |
| 音质 (outputFormat) | menu | `24kHz / 48kbps` | 含 24kHz/96kbps、48kHz/192kbps 等 6 档 |
| 情感风格 (style) | menu | `general` | `cheerful / sad / angry / serious / calm / gentle` 等；语音不支持时回落 general |
| OpenAI 兼容网关地址 (ttsEndpoint) | text | 空 | 选择 `openai-gateway` 时填写完整 URL |

## 自建网关用法

如果微软接口在你的网络下不稳定，可以参考 [wangwangit/tts](https://github.com/wangwangit/tts) 部署一份到 Cloudflare Worker，得到一个 `https://your-worker.workers.dev/v1/audio/speech` 端点，绑定你的域名，填进"OpenAI 兼容网关地址"字段。

请求体示例（自建网关需要兼容此格式）：

```json
{
  "input": "要朗读的文本",
  "voice": "zh-CN-XiaoxiaoNeural",
  "speed": 1.0,
  "pitch": "0",
  "style": "general"
}
```

## 工作原理

```
Bob 选中文本
   │
   ▼
main.js（esbuild 单文件 bundle）
   │
   └──► service/synthesis-request    （读取 Bob 配置，生成统一请求）
          │
          └──► providers/index        （按 provider 分发）
                 ├── edge-tts          → WebSocket + Sec-MS-GEC 签名
                 ├── azure-cognitive   → core/azure-token 签名 → Azure TTS API
                 ├── azure-trial       → Azure 官网接口
                 └── openai-gateway    → OpenAI 兼容 /v1/audio/speech
   ▼
Bob 播放器 ◄──── MP3 / WAV 音频
```

## 更新

本插件支持 Bob 自动更新检测，发现新版本时提示用户更新。

## 常见问题

**Q：朗读偶尔报 429 错误？**

A：Azure 官网端点有频率限制。插件已内置自动重试（指数退避），但短时间内频繁触发仍可能失败。建议切换到 `edge-tts` 方案。

**Q：直连微软失败？**

A：可能是 `dev.microsofttranslator.com` 在你的网络受限。可以切换到 `edge-tts` 方案，或填一个自建网关 URL 绕过。

**Q：情感风格不生效？**

A：不是所有语音都支持 `<mstts:express-as>`。一般 `zh-CN-XiaoxiaoNeural`、`en-US-AriaNeural` 等语音支持；不支持时服务端会忽略 style 字段，回落到 general。另外，Edge TTS 方案不支持情感风格，仅 Azure 认知服务支持。

**Q：Azure 体验服务和 Azure 认知服务有什么区别？**

A：认知服务通过 Microsoft Translator 签名获取临时 Token，支持情感风格和长文本分块，更稳定；体验服务是 Azure 官网接口，无需签名但易触发限流。

**Q：Edge TTS 和 Azure 认知服务怎么选？**

A：Edge TTS 免费稳定，适合日常使用，但不支持情感风格；Azure 认知服务功能最全（情感风格、SSML 全部配置项），但依赖 Microsoft Translator 签名，偶尔可能因签名变更失效。

## 开发

```bash
pnpm install
pnpm run typecheck   # 类型检查
pnpm run build       # 构建产物
pnpm run clean       # 清理构建产物
```

## 致谢

- [wangwangit/tts](https://github.com/wangwangit/tts)：Azure 认知服务签名协议的原始实现参考
- [rany2/edge-tts](https://github.com/rany2/edge-tts)：Edge Read Aloud 协议参考
- [bobtranslate.com](https://bobtranslate.com/)：Bob 插件平台
- [Linux.do](https://linux.do/)：Linux.do 社区
