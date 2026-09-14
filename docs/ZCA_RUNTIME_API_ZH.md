# ZCA Runtime 中文接入文档

本文档对应浏览器注入版 `zca-runtime.js`，适用于 Android WebView、Flutter WebView 或浏览器控制台。当前 Runtime 只实现个人账号的同设备登录、手机号查找、文字发送、ACK 和单向删除，不包含图片发送、二维码自动化或验证码绕过。

> 这是非官方 Zalo Web 接口，接口可能变化，账号也可能受到限制。请控制调用频率，并先使用测试账号验证。

## 1. 构建和注入

在项目根目录执行：

```bash
npm run build:runtime
```

输出文件：

- `dist/zca-runtime.js`：单行压缩版，用于 WebView 注入。
- `dist/zca-runtime.debug.js`：未压缩版，用于调试。

注入成功后，全局对象为：

```js
window.ZCA
```

检查是否注入成功：

```js
typeof window.ZCA === "object";
window.ZCA.version;
window.ZCA.getState();
```

Runtime 只能运行在 `https://zalo.me` 或其子域名页面。每次 WebView 页面跳转后，JavaScript 上下文都会被清空，因此必须重新注入 `zca-runtime.js`。

## 2. 推荐的完整流程

### 2.1 加载登录页

WebView 首先加载：

```js
window.ZCA.loginPageUrl
// https://id.zalo.me/account?continue=https%3A%2F%2Fchat.zalo.me
```

实际接入时，原生层可以直接保存这个固定地址。页面加载完成后注入 Runtime。

### 2.2 检查是否已经登录

```js
const result = await window.ZCA.checkNativeLogin();

if (result.logged) {
    console.log("已经登录", result.data);
} else {
    console.log("尚未登录");
}
```

返回格式：

```js
{
    logged: false,
    data: { /* Zalo 返回的登录状态 */ }
}
```

### 2.3 生成同设备唤起地址

```js
const login = await window.ZCA.prepareNativeLogin("chrome", true);

console.log(login.loginUrl);
```

返回格式：

```js
{
    token: "...",
    status: "unknown",
    loginUrl: "zalo://login/?browser=chrome&token=..."
}
```

参数说明：

- `browser`：写入 Zalo Deep Link 的浏览器标识，默认 `chrome`。
- `force`：是否强制获取新 token，默认 `false`。非强制模式会复用 90 秒内的 token。

`loginUrl` 应交给 Android/Flutter 原生层打开。不要依赖 WebView 内的 `location.href` 唤起 Zalo。

### 2.4 等待用户在 Zalo 中确认

应用回到前台后，定时调用：

```js
const result = await window.ZCA.checkNativeLogin();
if (result.logged) {
    // 登录成功，停止轮询
} else if (result.navigating && result.navigationUrl) {
    // Zalo App 已批准。让同一个 WebView 打开该地址以完成 Cookie 交换。
    location.href = result.navigationUrl;
}
```

建议轮询间隔 1～2 秒，并设置总超时时间。不要在轮询中反复调用 `prepareNativeLogin()`，否则 token 会变化。
`navigating` 表示 Zalo App 已确认但 Web Cookie 尚未写入；必须使用创建 token 的同一个 WebView 打开
`navigationUrl`，不能把它交给外部浏览器。

### 2.5 进入消息宿主页

登录成功后，让同一个 WebView 加载：

```js
window.ZCA.hostUrl
// https://chat.zalo.me/__zca_runtime_host__
```

这个地址当前会返回 HTTP 404，这是有意使用的无脚本同源宿主页，用于避免完整 Zalo Web 页面自己建立另一条 WebSocket。宿主层不要把该地址的 404 当作登录失败，也不要自动跳转错误页。

页面加载完成后，再次注入 `zca-runtime.js`。

### 2.6 初始化并连接

```js
await window.ZCA.init({
    bridgeName: "ZaloBridge",
    logging: false,
    autoConnect: true,
    reconnect: true,
});

await window.ZCA.waitForConnection(15000);
```

### 2.7 按手机号发送文字

```js
const result = await window.ZCA.sendToPhone({
    phone: "0912345678",
    text: "测试消息",
    waitForAck: "delivered",
    ackTimeoutMs: 60000,
    deleteOnlyMe: true,
});

console.log(result);
```

返回示例：

```js
{
    phone: "84912345678",
    uid: "1234567890123456789",
    msgId: "9876543210123456789",
    cliMsgId: "1750000000000",
    deletedOnlyMe: true,
    ack: 2
}
```

## 3. 属性和方法一览

### 3.1 属性

| 属性 | 类型 | 说明 |
| --- | --- | --- |
| `version` | `string` | Runtime 版本。 |
| `loginPageUrl` | `string` | 同设备登录前需要加载的 Zalo 登录页。 |
| `hostUrl` | `string` | 登录后初始化及发送消息使用的同源宿主页。 |
| `isReady` | `boolean` | 会话资料是否初始化完成。 |
| `isConnected` | `boolean` | ACK WebSocket 是否已连接。 |

### 3.2 方法

| 方法 | 作用 |
| --- | --- |
| `configure(options)` | 保存 Runtime 配置，但不执行登录初始化。 |
| `getState()` | 获取当前会话及连接状态。 |
| `on(event, listener)` | 监听 Runtime 事件，返回取消监听函数。 |
| `prepareNativeLogin(browser, force)` | 获取 token 和 `zalo://` 同设备登录地址。 |
| `checkNativeLogin()` | 检查登录页 Cookie 对应的账号是否已经确认登录。 |
| `init(options)` | 读取登录会话、服务地址和密钥，并按配置建立 WebSocket。 |
| `startConnection()` | 手动启动 ACK WebSocket。 |
| `stopConnection()` | 主动关闭 WebSocket 和自动重连。 |
| `waitForConnection(timeoutMs)` | 等待 WebSocket 连接成功。 |
| `waitForAck(msgId, level, timeoutMs)` | 等待指定消息达到送达或已读状态。 |
| `findUserByPhone(phone)` | 将手机号查询为 Zalo 用户 UID。 |
| `sendText(uid, text)` | 直接向 UID 发送文字。 |
| `deleteOnlyMe(target)` | 仅从当前账号的会话中删除指定消息。 |
| `sendToPhone(options)` | 手机号查询、发送、等待 ACK、单向删除的一体化方法。 |
| `getPendingDeletes(taskKey)` | 查询当前页面生命周期内尚未单向删除的已发送消息。 |
| `cleanupSentMessages(options)` | 按任务和最低 ACK 批量兜底删除消息。 |
| `finishTask(taskKey)` | 任务结束时清理该任务剩余的 ACK 1/2/3 消息。 |
| `reset()` | 关闭连接、取消等待并清空当前 Runtime 会话。 |

## 4. 配置项

`configure()` 和 `init()` 接受相同配置：

```js
window.ZCA.configure({
    apiType: 30,
    apiVersion: 685,
    language: "vi",
    imei: "可选的固定 IMEI",
    bridgeName: "ZaloBridge",
    logging: false,
    autoConnect: true,
    reconnect: true,
});
```

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `apiType` | `30` | Zalo Web API 类型，一般不修改。 |
| `apiVersion` | `685` | Zalo Web API 版本；Zalo 升级后可能需要更新。 |
| `language` | `vi` | 会话语言。`vi` 下以 `0` 开头的号码会转换成越南国家码 `84`。 |
| `imei` | 自动生成并持久化 | Web 客户端设备标识。宿主需要固定设备时可以传入。 |
| `bridgeName` | 未设置 | Flutter/Android JavaScript Channel 的全局名称。 |
| `logging` | `false` | 预留的日志开关。 |
| `autoConnect` | `true` | `init()` 完成后是否自动连接 WebSocket。 |
| `reconnect` | `true` | 非主动断开时是否自动重连。 |

## 5. 状态判断

```js
const state = window.ZCA.getState();
```

返回格式：

```js
{
    state: "idle",
    ready: false,
    uid: "",
    connection: "idle",
    connected: false,
    version: "0.2.0"
}
```

`state` 可能为：

- `idle`：尚未初始化或已经重置。
- `initializing`：正在初始化会话。
- `ready`：HTTP 会话可用，可以查手机号和发送消息。
- `auth_required`：Cookie 未登录或登录已失效。
- `error`：初始化发生其他错误。

`connection` 可能为：

- `idle`
- `connecting`
- `connected`
- `reconnecting`
- `disconnected`

注意：`ready: true` 只说明 HTTP 发送会话可用；需要等待送达或已读 ACK 时，还必须满足 `connected: true`。

## 6. 发送相关方法

### 6.1 `findUserByPhone(phone)`

```js
const result = await window.ZCA.findUserByPhone("0912345678");
console.log(result.phone, result.user.uid);
```

号码会去除空格、加号、短横线等非数字字符。当前默认越南规则会把 `0912345678` 转换为 `84912345678`。

`PHONE_NOT_FOUND` 不一定能严格证明号码没有注册，也可能与 Zalo 的隐私或查询限制有关。

### 6.2 `sendText(uid, text)`

```js
const sent = await window.ZCA.sendText("目标 UID", "你好");
```

成功返回 `ack: 1`，表示发送接口已经接受并返回消息 ID，不等于对方已经收到。

### 6.3 `waitForAck(msgId, level, timeoutMs)`

```js
const delivered = await window.ZCA.waitForAck(sent.msgId, 2, 60000);
const seen = await window.ZCA.waitForAck(sent.msgId, 3, 120000);
```

ACK 含义：

| ACK | 名称 | 含义 |
| --- | --- | --- |
| `1` | server | Zalo 发送接口已经返回消息 ID。 |
| `2` | delivered | Runtime 收到送达事件。 |
| `3` | seen | Runtime 收到已读事件。 |

离线、隐私设置或协议变化都可能导致 ACK 超时。`ACK_TIMEOUT` 不能直接解释为消息发送失败。

### 6.4 `deleteOnlyMe(target)`

```js
await window.ZCA.deleteOnlyMe({
    uid: sent.uid,
    msgId: sent.msgId,
    cliMsgId: sent.cliMsgId,
});
```

这是“仅为当前账号删除”，不是撤回。接收方仍然可以看到消息。

### 6.5 `sendToPhone(options)`

这是自动任务推荐使用的方法：

```js
await window.ZCA.sendToPhone({
    phone: "0912345678",
    text: "你好",
    deleteOnlyMe: false,
    waitForAck: "server",
    ackTimeoutMs: 60000,
});
```

参数：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `phone` | 是 | 目标手机号。 |
| `text` | 是 | 非空文字内容，首尾空白会被去掉。 |
| `deleteOnlyMe` | 否 | 是否发送后仅在当前账号删除。默认 `false`。 |
| `waitForAck` | 否 | `server`、`delivered` 或 `seen`。 |
| `ackTimeoutMs` | 否 | 等待连接和 ACK 的超时时间。 |

当没有填写 `waitForAck` 时：

- `deleteOnlyMe: false` 默认使用 `server`。
- `deleteOnlyMe: true` 默认等待 `delivered` 后再单向删除。

## 7. 事件和宿主桥接

### 7.1 JavaScript 内监听

```js
const unsubscribe = window.ZCA.on("task_complete", (payload) => {
    console.log("任务完成", payload);
});

// 不再需要时取消监听
unsubscribe();
```

也可以监听浏览器事件：

```js
window.addEventListener("zca:task_error", (event) => {
    console.log(event.detail);
});
```

### 7.2 Flutter/Android Channel

初始化时传入 `bridgeName`：

```js
await window.ZCA.init({ bridgeName: "ZaloBridge" });
```

Runtime 会调用：

```js
window.ZaloBridge.postMessage(JSON.stringify({
    event: "事件名",
    payload: {},
    runtimeVersion: "0.2.0"
}));
```

宿主统一按 JSON 解析即可。

### 7.3 事件列表

| 事件 | 说明 |
| --- | --- |
| `status` | Runtime 状态变化。 |
| `login_url` | 已生成同设备登录 URL。 |
| `authenticated` | 登录状态检查为已登录。 |
| `auth_required` | 登录状态检查为未登录。 |
| `error` | 初始化错误。 |
| `connection` | WebSocket 连接状态变化。 |
| `connected` | WebSocket 已连接。 |
| `disconnected` | WebSocket 已断开。 |
| `reconnecting` | 正在自动重连。 |
| `connection_error` | WebSocket 创建或消息解码错误。 |
| `cipher_ready` | WebSocket 加密密钥已就绪。 |
| `message_sent` | 发送接口成功返回消息 ID。 |
| `message_delivered` | 收到送达 ACK。 |
| `message_seen` | 收到已读 ACK。 |
| `ack_timeout` | 等待 ACK 超时。 |
| `message_deleted` | 单向删除接口执行完成。 |
| `task_complete` | `sendToPhone()` 全流程完成。 |
| `task_error` | `sendToPhone()` 任一步骤失败。 |
| `cleanup_complete` | 一轮批量兜底清理完成。 |
| `task_cleanup_complete` | 指定任务的最终清理完成。 |

## 8. 送达清理和任务结束兜底清理

按 WS 任务流程使用时，为每条消息传入相同的 `taskKey`：

```js
await window.ZCA.sendToPhone({
    taskKey: "task-10001",
    phone: "0912345678",
    text: "任务消息",
    waitForAck: "delivered",
    deleteOnlyMe: true,
});
```

这条路径会在收到送达 ACK 后立即执行一次单向删除。如果等待 ACK 或删除失败，已经发送成功的消息仍保留在 Runtime 的待清理记录中。

任务最终结算或结束后，再调用：

```js
const cleanup = await window.ZCA.finishTask("task-10001");
console.log(cleanup);
```

`finishTask()` 会再次清理该任务下所有尚未删除、且至少达到 ACK 1 的消息：

```js
{
    taskKey: "task-10001",
    attempted: 2,
    deleted: 2,
    pending: 0,
    failures: []
}
```

也可以手动指定最低 ACK：

```js
await window.ZCA.cleanupSentMessages({
    taskKey: "task-10001",
    minimumAck: 2,
});
```

查询尚未清理的记录：

```js
const pending = window.ZCA.getPendingDeletes("task-10001");
```

注意：Runtime 中的待清理记录只存在于当前页面 JavaScript 生命周期。WebView 重载或进程退出后，需要由宿主根据持久化的 `uid`、`msgId`、`cliMsgId` 重新调用 `deleteOnlyMe()`。正式接入 `win_sms` 时，应像 WS 流程一样由 Flutter 保存任务快照并在连接恢复后重试。

## 9. 错误处理

```js
try {
    await window.ZCA.sendToPhone({
        phone: "0912345678",
        text: "测试",
        waitForAck: "delivered",
    });
} catch (error) {
    console.log(error.name);      // ZCARuntimeError
    console.log(error.code);      // Runtime 错误码
    console.log(error.message);   // 错误说明
    console.log(error.zaloCode);  // 可选的 Zalo 原始错误码
}
```

常见错误码：

| 错误码 | 说明 |
| --- | --- |
| `INVALID_ORIGIN` | 当前页面不是 Zalo HTTPS 域名。 |
| `NATIVE_LOGIN_UNAVAILABLE` | 无法生成同设备登录 token。 |
| `LOGIN_CHECK_FAILED` | 登录状态接口失败。 |
| `AUTH_REQUIRED` | 当前 Cookie 未登录或会话已失效。 |
| `INIT_FAILED` | 会话初始化失败。 |
| `INVALID_SESSION` | Zalo 返回的会话信息不完整。 |
| `HTTP_ERROR` | HTTP 状态码不是成功状态。 |
| `ZALO_ERROR` | Zalo 接口返回业务错误。 |
| `INVALID_RESPONSE` | Zalo 响应无法解密或解析。 |
| `INVALID_PHONE` | 手机号为空或无有效数字。 |
| `PHONE_NOT_FOUND` | 没有查询到可用的 Zalo 用户。 |
| `INVALID_UID` | 目标 UID 为空。 |
| `EMPTY_MESSAGE` | 文字内容为空。 |
| `INVALID_TASK_KEY` | `finishTask()` 没有收到有效任务键。 |
| `INVALID_SEND_RESPONSE` | 发送响应中没有消息 ID。 |
| `ACK_UNAVAILABLE` | Zalo 没有提供 WebSocket 地址。 |
| `CONNECTION_TIMEOUT` | WebSocket 连接超时。 |
| `ACK_TIMEOUT` | 等待送达或已读 ACK 超时。 |
| `SOCKET_ERROR` | WebSocket 错误。 |
| `SOCKET_DECODE_FAILED` | WebSocket 二进制事件解码失败。 |
| `SEND_FAILED` | 未归类的发送流程错误。 |
| `DELETE_FAILED` | 未归类的单向删除错误。 |
| `RUNTIME_RESET` | 等待过程中 Runtime 被重置。 |

## 10. WebView 接入注意事项

1. 登录页和消息宿主页必须使用同一个 CookieStore；不要使用两个互不共享 Cookie 的 WebView。
2. 开启 JavaScript、DOM Storage 和 Cookie，并允许第三方 Cookie（如果所用 WebView 版本需要）。
3. 原生层负责处理 `zalo://`，同时处理设备未安装 Zalo 的情况。
4. 应用回到前台后再轮询登录状态；设置超时并允许用户重试。
5. 每次页面跳转后重新注入 Runtime。
6. 对 `hostUrl` 的预期 404 做白名单处理。
7. 一个账号避免同时运行多个 Zalo Web/Runtime WebSocket。
8. 自动任务需要在宿主层实现限速、重试、幂等、防重复发送和任务结果持久化。
9. 遇到 CAPTCHA、设备确认或风控必须交给用户正常完成，Runtime 不会绕过。
10. 当前仅支持一对一文字消息，不支持图片、文件和群消息。

## 11. 最小调试脚本

登录完成、进入 `hostUrl` 并重新注入后，可在控制台执行：

```js
window.ZCA.on("status", console.log);
window.ZCA.on("connection", console.log);
window.ZCA.on("task_complete", console.log);
window.ZCA.on("task_error", console.error);

await window.ZCA.init({ autoConnect: true, logging: true });
await window.ZCA.waitForConnection();

console.log(window.ZCA.getState());
```

确认状态为 `ready: true`、`connected: true` 后，再使用测试号码调用 `sendToPhone()`。
