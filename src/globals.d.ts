/**
 * @module globals
 * @description Bob 运行时全局变量类型声明。
 *
 * Bob 插件运行在 JavaScriptCore 环境中，主程序会注入若干全局变量
 * （`$option`、`$data`、`$http`、`$websocket`），
 * 本文件为这些全局变量提供 TypeScript 类型声明，以便在 `src/*.ts` 中直接引用。
 * 所有声明均为 `declare const`，不参与运行时，仅用于编译期类型检查。
 */

/** Bob 插件配置选项，键值对形式，值均为字符串。由 Bob 主程序从配置面板注入。 */
declare const $option: Record<string, string> | undefined;

/**
 * Bob 数据转换工具，提供字节数组到 Base64 的编码能力。
 *
 * 在 JavaScriptCore 环境中替代 `Buffer` / `btoa` 等 API。
 */
declare const $data:
    | {
          /**
           * 将字节数组包装为可 Base64 编码的对象。
           *
           * @param bytes - 输入字节数组或 Uint8Array
           * @returns 包含 `toBase64()` 方法的对象
           */
          fromByteArray(bytes: number[] | Uint8Array): { toBase64(): string };
      }
    | undefined;

/**
 * Bob HTTP 请求工具，提供异步网络请求能力。
 *
 * 在 JavaScriptCore 环境中替代 `fetch` / `XMLHttpRequest` 等 API。
 */
declare const $http:
    | {
          /**
           * 发起 HTTP 请求。
           *
           * @param options - 请求选项，包含 method、url、header、body、timeout、handler
           * @param options.method - HTTP 方法
           * @param options.url - 请求 URL
           * @param options.header - 可选的请求头
           * @param options.body - 可选的请求体
           * @param options.timeout - 可选的超时时间（毫秒）
           * @param options.handler - 响应回调函数
           */
          request(options: {
              method: string;
              url: string;
              header?: Record<string, string>;
              body?: string | Record<string, unknown>;
              timeout?: number;
              handler: (resp: unknown) => void;
          }): void;
      }
    | undefined;

/**
 * Bob 日志工具，用于在插件调试窗口中输出日志。
 *
 * 仅在 Bob 运行时存在，非调试环境可能为 `undefined`，使用前需判空。
 */
declare const $log:
    | {
          /** 输出普通日志 */
          info?(message: string): void;
          /** 输出错误日志 */
          error?(message: string): void;
      }
    | undefined;

/**
 * Bob WebSocket API，用于与 TTS 服务建立双向通信连接。
 *
 * `socket.listenReceiveData` 第二参数是字节数组（或 `$data`-like 对象），
 * `listenReceiveString` 第二参数是文本帧（如 `'turn.end'`）。
 */
declare const $websocket:
    | {
          /**
           * 创建新的 WebSocket 连接实例。
           *
           * @param options - WebSocket 连接选项
           * @param options.url - WebSocket 服务器 URL
           * @param options.header - 可选的自定义请求头
           * @param options.allowSelfSignedSSLCertificates - 是否允许自签名 SSL 证书
           * @param options.timeoutInterval - 可选的超时时间（秒）
           * @returns BobWebSocket 实例
           */
          new: (options: {
              url: string;
              header?: Record<string, string>;
              allowSelfSignedSSLCertificates?: boolean;
              timeoutInterval?: number;
          }) => BobWebSocket;
      }
    | undefined;

/**
 * Bob WebSocket 连接实例接口。
 *
 * 提供连接管理、消息收发和事件监听能力。
 */
interface BobWebSocket {
    /** 打开 WebSocket 连接 */
    open(): void;
    /** 关闭 WebSocket 连接 */
    close(): void;
    /**
     * 发送文本帧。
     *
     * @param payload - 待发送的文本内容
     */
    sendString(payload: string): void;
    /**
     * 监听连接打开事件。
     *
     * @param handler - 连接打开时的回调函数
     */
    listenOpen(handler: () => void): void;
    /**
     * 监听文本帧接收事件。
     *
     * @param handler - 接收文本帧时的回调函数，第二参数为文本内容（如 `'turn.end'`）
     */
    listenReceiveString(handler: (socket: BobWebSocket, message: string) => void): void;
    /**
     * 监听二进制帧接收事件。
     *
     * @param handler - 接收二进制数据时的回调函数，第二参数为字节数组或 `$data`-like 对象
     */
    listenReceiveData(handler: (socket: BobWebSocket, data: unknown) => void): void;
    /**
     * 监听连接错误事件。
     *
     * @param handler - 发生错误时的回调函数，第二参数为错误信息
     */
    listenError(handler: (socket: BobWebSocket, error: unknown) => void): void;
    /**
     * 监听连接关闭事件。
     *
     * 回调参数形态在各 Bob 版本间不完全一致，实际参数可能是
     * `(socket, code, reason)`、`(socket, reason)`，早期版本也可能没有该方法，
     * 因此声明为可选并用可变参数接收。
     *
     * @param handler - 连接关闭时的回调函数
     */
    listenClose?(handler: (socket: BobWebSocket, ...rest: unknown[]) => void): void;
}
