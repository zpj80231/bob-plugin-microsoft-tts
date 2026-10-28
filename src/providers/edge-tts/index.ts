/**
 * @file Edge 大声朗读 Provider 主流程
 * @description 本文件实现了通过 Microsoft Edge 浏览器"大声朗读"功能的 WebSocket
 *   协议进行语音合成的 Provider。该方案无需 API Key，通过模拟 Edge 浏览器的
 *   WebSocket 连接获取合成音频。
 *
 * 核心流程：
 * 1. 校验 Bob 运行时是否支持 `$websocket` API（需 Bob 1.6.0+）；
 * 2. 解析输出格式（仅支持 MP3）；
 * 3. 建立 WebSocket 连接，发送语音配置和 SSML 请求；
 * 4. 接收二进制帧，提取音频数据；
 * 5. 收到 `turn.end` 信号后拼接所有音频块并返回。
 *
 * 重试策略：
 * 新端点 `api.msedgeservices.com` 会**间歇性**以 HTTP 429 拒绝 WebSocket 握手
 * （2026-10-28 实测成功率约 50%~85%，响应体为空且没有 `Retry-After`），
 * 因此连接层失败按指数退避重试，见 {@link MAX_ATTEMPTS}。
 * 服务端明确拒绝的请求（如 `Unsupported voice`）不重试。
 */

import type {SynthesisRequest} from '../../types';
import {makeError} from '../../util/error';
import {delay} from '../../util/async';
import {buildSsml} from '../../core/ssml';
import {
    buildSpeechConfig,
    buildWebSocketHeaders,
    buildWebSocketUrl,
    createConnectionId,
    makeSsmlMessage,
} from './protocol';
import {concatBytes} from '../../util/bytes';
import {extractAudioPayload} from './frame';

/**
 * 默认音频输出格式
 * @description Edge 大声朗读 WebSocket 协议支持的 MP3 输出格式。
 */
const DEFAULT_OUTPUT_FORMAT = 'audio-24khz-96kbitrate-mono-mp3';

/** WebSocket 合成全局超时时间（秒） */
const SYNTHESIS_TIMEOUT_SEC = 60;

/** WebSocket 合成全局超时时间（毫秒） */
const SYNTHESIS_TIMEOUT_MS = SYNTHESIS_TIMEOUT_SEC * 1000;

/**
 * 握手超时时间（毫秒）
 * @description 超过该时长仍未触发 `listenOpen` 则判定本次连接失败并进入重试，
 *   避免握手阶段丢事件时一直挂到 Bob 的插件超时。
 */
const CONNECT_TIMEOUT_MS = 10000;

/**
 * 超时回调最小经过时间（秒）
 * @description 防止运行时定时器 shim 异常导致超时回调被提前触发。
 *   若回调触发时实际经过时间不足此阈值，则忽略本次超时。
 */
const MIN_ELAPSED_SEC = 5;

/**
 * 最大尝试次数（含首次）
 * @description 实测 429 极少连续出现 3 次以上，4 次尝试成功率已足够高；
 *   同时把最坏等待控制在"最多 4 次握手 + 约 1.4 秒退避"的量级。
 */
const MAX_ATTEMPTS = 4;

/**
 * 重试基础退避时长（毫秒）
 * @description 第 n 次重试等待 `RETRY_BASE_DELAY_MS × 2^(n-1)`，另叠加 0~100ms 抖动，
 *   避免同一时刻的多个请求同步重试再次撞上限流。
 */
const RETRY_BASE_DELAY_MS = 200;

/**
 * 单次尝试耗时上限（毫秒）
 * @description 单次尝试已耗时超过该值（多为合成阶段的 60 秒超时）时不再重试，
 *   否则用户要等数分钟才看到错误，而且重试也不会更接近成功。
 */
const RETRY_ELAPSED_LIMIT_MS = 15000;

/** 限流判定：429 出现在状态码字段或错误文本中 */
const RATE_LIMIT_RE = /(?:^|\D)429(?:\D|$)/;

/**
 * 服务端明确拒绝的关闭原因
 * @description 命中这些关键字说明请求内容本身有问题（语音不存在、SSML 非法等），
 *   重试只会得到同样的结果。
 */
const FATAL_CLOSE_RE = /unsupported voice|not supported|invalid|synthesis request|ssml/i;

/**
 * Bob 原生层透出的错误类型 → 中文提示
 * @description `$websocket` 的错误对象里 `type` 字段是底层 Starscream 的枚举名，
 *   对用户毫无意义，命中已知枚举时替换成可读说明；未知值保持原样便于排查。
 */
const ERROR_TYPE_HINTS: Record<string, string> = {
    notAnUpgrade: '服务端拒绝握手（HTTP 状态非 101，常见于限流 429 或封禁 403）',
    upgradeError: '握手升级失败',
    protocolError: 'WebSocket 协议错误',
    compressionError: 'WebSocket 压缩帧解析失败',
    connectionClosed: '连接被服务端关闭',
    timeout: '连接超时',
};

/**
 * 带重试元信息的 Edge TTS 错误。
 */
type EdgeError = Error & {
    /** `false` 表示该错误不可重试；`undefined` 视为可重试 */
    retryable?: boolean;
    /** 是否为服务端限流（HTTP 429） */
    rateLimited?: boolean;
};

/**
 * 解析音频输出格式
 * @description 校验用户配置的输出格式，仅支持包含 `'mp3'` 的格式字符串，
 *   其他格式或空值均回退到 {@link DEFAULT_OUTPUT_FORMAT}。
 *
 * @param format - 用户配置的输出格式字符串，如 `'audio-24khz-96kbitrate-mono-mp3'`
 * @returns 有效的 MP3 输出格式字符串
 */
function resolveOutputFormat(format: string | undefined): string {
    if (!format) return DEFAULT_OUTPUT_FORMAT;
    if (format.indexOf('mp3') >= 0) return format;
    return DEFAULT_OUTPUT_FORMAT;
}

/**
 * 截断过长文本
 *
 * @param text - 原始文本
 * @param max - 保留的最大长度
 * @returns 超出长度时补 `…` 的文本
 */
function truncate(text: string, max: number): string {
    return text.length > max ? text.slice(0, max) + '…' : text;
}

/**
 * 把 Bob `$websocket` 回调里拿到的错误转换成可读文案
 * @description Bob 在 `listenError` 中传入的可能是字符串、`Error`，也可能是
 *   由原生层桥接过来的**普通对象**（形如 `{"code":0,"type":"..."}`）。
 *   直接 `JSON.stringify` 会得到用户看不懂的 JSON，真实原因（如 429）也被淹没，
 *   因此优先挑出 message/reason/code 等字段拼成人类可读文本，仅在没有可用字段时
 *   才回退到 JSON。
 *
 * @param error - 回调收到的原始错误
 * @returns 可读的错误描述与是否属于限流
 */
function describeSocketError(error: unknown): { detail: string; rateLimited: boolean } {
    if (typeof error === 'string') {
        return {detail: error, rateLimited: RATE_LIMIT_RE.test(error)};
    }
    if (error instanceof Error) {
        return {detail: error.message, rateLimited: RATE_LIMIT_RE.test(error.message)};
    }
    if (error && typeof error === 'object') {
        const record = error as Record<string, unknown>;
        const parts: string[] = [];
        let rateLimited = false;

        // 按“信息量”从高到低挑选字段
        const textKeys = ['message', 'reason', 'error', 'type', 'description'];
        const numberKeys = ['status', 'statusCode', 'code'];

        for (const key of textKeys) {
            const value = record[key];
            if (typeof value === 'string' && value) {
                if (RATE_LIMIT_RE.test(value)) rateLimited = true;
                parts.push(key === 'type' && ERROR_TYPE_HINTS[value] ? ERROR_TYPE_HINTS[value] : value);
            }
        }
        for (const key of numberKeys) {
            const value = record[key];
            if (typeof value === 'number' || (typeof value === 'string' && value)) {
                if (RATE_LIMIT_RE.test(String(value))) rateLimited = true;
                parts.push(key + '=' + value);
            }
        }

        if (parts.length > 0) {
            return {detail: parts.join(', '), rateLimited};
        }

        try {
            const json = JSON.stringify(error);
            if (json && json !== '{}') {
                return {detail: truncate(json, 200), rateLimited: RATE_LIMIT_RE.test(json)};
            }
        } catch (_) {
            // JSON.stringify 可能因循环引用抛错，落到下面的兜底
        }
        return {detail: Object.prototype.toString.call(error), rateLimited: false};
    }
    return {detail: String(error), rateLimited: false};
}

/**
 * 构造带重试元信息的错误
 *
 * @param message - 展示给用户的错误描述
 * @param detail - 附加调试信息（原始错误文本）
 * @param retryable - 是否允许重试
 * @param rateLimited - 是否为服务端限流
 * @returns 可被重试逻辑识别的错误对象
 */
function makeEdgeError(message: string, detail: string, retryable: boolean, rateLimited: boolean): EdgeError {
    const err = makeError('api', message, detail) as EdgeError;
    err.retryable = retryable;
    err.rateLimited = rateLimited;
    return err;
}

/**
 * 归一化任意异常为 {@link EdgeError}
 *
 * @param raw - 捕获到的任意异常
 * @returns 带重试元信息的错误对象
 */
function toEdgeError(raw: unknown): EdgeError {
    if (raw && typeof raw === 'object' && 'retryable' in (raw as Record<string, unknown>)) {
        return raw as EdgeError;
    }
    const message = raw instanceof Error ? raw.message : String(raw);
    return makeEdgeError(message, message, true, false);
}

/**
 * 把重试过程中的中间失败转换成最终展示的错误
 *
 * @param err - 最后一次失败
 * @param attempts - 实际尝试次数
 * @returns 最终抛出的错误
 */
function finalizeFailure(err: EdgeError, attempts: number): EdgeError {
    if (attempts <= 1) return err;
    const message = err.rateLimited
        ? `Edge TTS 服务端限流（HTTP 429），已尝试 ${attempts} 次仍失败，请稍后再试`
        : `${err.message}（已尝试 ${attempts} 次）`;
    return makeEdgeError(message, err.message, false, !!err.rateLimited);
}

/**
 * 输出单次失败日志（仅在 Bob 调试环境可用）
 *
 * @param attempt - 第几次尝试
 * @param err - 失败原因
 * @param retrying - 是否还会继续重试
 */
function logAttemptFailure(attempt: number, err: EdgeError, retrying: boolean): void {
    if (typeof $log === 'undefined' || !$log || !$log.error) return;
    $log.error(`[edge-tts] 第 ${attempt} 次合成失败${retrying ? '，准备重试' : ''}：${err.message}`);
}

/**
 * 单次 WebSocket 合成尝试
 * @description 建立一次 WebSocket 连接完成合成，失败时抛出带 `retryable` 标记的
 *   {@link EdgeError}，由外层 {@link synthesizeViaEdgeTts} 决定是否重试。
 *
 * @param params - 语音合成请求参数
 * @param outputFormat - 已校验的音频输出格式
 * @returns MP3 格式的音频字节数组
 */
function synthesizeOnce(params: SynthesisRequest, outputFormat: string): Promise<number[]> {
    return new Promise<number[]>((resolve, reject) => {
        const requestId = createConnectionId();
        const connectionId = createConnectionId();
        const muid = createConnectionId();
        const chunks: number[][] = [];
        let finished = false;
        let socket: BobWebSocket | undefined;
        let connectTimer: ReturnType<typeof setTimeout> | undefined;
        let synthesisTimer: ReturnType<typeof setTimeout> | undefined;
        let openTime = 0;

        function cleanup(): void {
            if (connectTimer != null) {
                clearTimeout(connectTimer);
                connectTimer = undefined;
            }
            if (synthesisTimer != null) {
                clearTimeout(synthesisTimer);
                synthesisTimer = undefined;
            }
            if (socket && socket.close) {
                try { socket.close(); } catch (_) {}
            }
        }

        function done(err: Error | null, bytes?: number[]): void {
            if (finished) return;
            finished = true;
            cleanup();
            if (err) {
                reject(err);
                return;
            }
            resolve(bytes!);
        }

        function fail(message: string, detail: string, retryable: boolean, rateLimited = false): void {
            done(makeEdgeError(message, detail, retryable, rateLimited));
        }

        try {
            socket = $websocket!.new({
                url: buildWebSocketUrl(connectionId),
                allowSelfSignedSSLCertificates: true,
                timeoutInterval: 30,
                header: buildWebSocketHeaders(muid),
            });

            connectTimer = setTimeout(() => {
                fail(
                    `Edge TTS 连接超时（${CONNECT_TIMEOUT_MS / 1000}s 内未建立连接）`,
                    'connect timeout',
                    true,
                );
            }, CONNECT_TIMEOUT_MS);

            socket.listenOpen(function () {
                if (finished) return;
                if (connectTimer != null) {
                    clearTimeout(connectTimer);
                    connectTimer = undefined;
                }
                openTime = Date.now();
                synthesisTimer = setTimeout(() => {
                    const elapsed = (Date.now() - openTime) / 1000;
                    if (elapsed < MIN_ELAPSED_SEC) return;
                    fail(`Edge TTS 合成超时（${SYNTHESIS_TIMEOUT_SEC}s）`, 'synthesis timeout', true);
                }, SYNTHESIS_TIMEOUT_MS);
                socket!.sendString(buildSpeechConfig(requestId, outputFormat));
                socket!.sendString(makeSsmlMessage(requestId, buildSsml({ ...params, style: '' })));
            });

            socket.listenReceiveData(function (_, data) {
                try {
                    const payload = extractAudioPayload(data);
                    if (payload.length > 0) {
                        chunks.push(payload);
                    }
                } catch (err) {
                    done(err as Error);
                }
            });

            socket.listenReceiveString(function (_, message) {
                if (String(message).indexOf('Path:turn.end') >= 0) {
                    const bytes = concatBytes(chunks);
                    if (bytes.length === 0) {
                        fail('Edge TTS 没有返回音频数据', 'empty audio', true);
                        return;
                    }
                    done(null, bytes);
                }
            });

            socket.listenError(function (_, error) {
                const {detail, rateLimited} = describeSocketError(error);
                fail(
                    rateLimited
                        ? 'Edge TTS 服务端限流（HTTP 429）'
                        : `Edge TTS WebSocket 连接失败：${detail}`,
                    detail,
                    true,
                    rateLimited,
                );
            });

            // listenClose 在部分 Bob 版本不存在；存在时能拿到服务端关闭原因
            // （例如 "Unsupported voice xxx"），比一直等到超时快得多
            if (typeof socket.listenClose === 'function') {
                socket.listenClose(function (_socket: BobWebSocket, ...rest: unknown[]) {
                    if (finished) return;
                    const code = rest.filter((item): item is number => typeof item === 'number')[0];
                    const reason = rest.filter((item): item is string => typeof item === 'string').join(' ');
                    const retryable = !FATAL_CLOSE_RE.test(reason);
                    const label = code == null ? '连接被关闭' : '连接被关闭（code=' + code + '）';
                    fail(
                        `Edge TTS ${label}${reason ? '：' + reason : ''}`,
                        'close ' + (code == null ? '' : code) + ' ' + reason,
                        retryable,
                    );
                });
            }

            socket.open();
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            fail(`Edge TTS 合成失败：${msg}`, msg, false);
        }
    });
}

/**
 * 通过 Edge 大声朗读 WebSocket 协议进行语音合成
 * @description 使用 Bob 的 `$websocket` API 与 Microsoft Edge 大声朗读服务建立
 *   WebSocket 连接，发送 SSML 请求并接收合成音频数据。处理流程：
 *   1. 校验运行时是否支持 `$websocket` API；
 *   2. 解析输出格式并尝试合成（{@link synthesizeOnce}）；
 *   3. 失败且错误可重试时，按指数退避等待后再次尝试，最多 {@link MAX_ATTEMPTS} 次；
 *   4. 重试耗尽后抛出带尝试次数的可读错误。
 *
 * @param params - 语音合成请求参数
 * @returns MP3 格式的音频字节数组（`number[]`）
 * @throws 当运行时不支持 `$websocket`、重试后仍连接失败、音频数据为空时抛出错误
 */
export async function synthesizeViaEdgeTts(params: SynthesisRequest): Promise<number[]> {
    if (typeof $websocket === 'undefined' || !$websocket || !$websocket.new) {
        throw makeError('api', 'Edge TTS 需要 Bob 1.6.0+ 的 $websocket API');
    }

    const outputFormat = resolveOutputFormat(params.outputFormat);

    let attempts = 0;
    let last: EdgeError | undefined;

    while (attempts < MAX_ATTEMPTS) {
        attempts++;
        const startedAt = Date.now();
        try {
            return await synthesizeOnce(params, outputFormat);
        } catch (raw) {
            const err = toEdgeError(raw);
            last = err;
            const elapsed = Date.now() - startedAt;
            const retrying = err.retryable !== false
                && attempts < MAX_ATTEMPTS
                && elapsed < RETRY_ELAPSED_LIMIT_MS;
            logAttemptFailure(attempts, err, retrying);
            if (!retrying) break;

            const waitMs = RETRY_BASE_DELAY_MS * Math.pow(2, attempts - 1) + Math.floor(Math.random() * 100);
            await delay(waitMs);
        }
    }

    throw finalizeFailure(last!, attempts);
}
