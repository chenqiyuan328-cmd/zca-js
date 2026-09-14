import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import fs from "node:fs";
import vm from "node:vm";
import cryptojs from "crypto-js";
import pako from "pako";

const bundle = fs.readFileSync(new URL("../dist/zca-runtime.js", import.meta.url), "utf8");
const secretKey = Buffer.alloc(32, 7).toString("base64");
const bridgeMessages = [];
const requests = [];
const sockets = [];
const socketKey = Buffer.alloc(32, 9).toString("base64");
let nativeStatusCalls = 0;

class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor(url) {
        this.url = url;
        this.readyState = MockWebSocket.CONNECTING;
        this.sent = [];
        sockets.push(this);
    }

    open() {
        this.readyState = MockWebSocket.OPEN;
        this.onopen?.({});
    }

    message(data) {
        this.onmessage?.({ data });
    }

    send(data) {
        this.sent.push(data);
    }

    close(code = 1000, reason = "") {
        this.readyState = MockWebSocket.CLOSED;
        this.onclose?.({ code, reason });
    }
}

function split(value) {
    const even = [];
    const odd = [];
    [...value].forEach((character, index) => (index % 2 === 0 ? even : odd).push(character));
    return { even, odd };
}

function loginKey(url) {
    const zcid = url.searchParams.get("zcid");
    const zcidExt = url.searchParams.get("zcid_ext");
    const extEven = split(cryptojs.MD5(zcidExt).toString().toUpperCase()).even;
    const zcidParts = split(zcid);
    return (
        extEven.slice(0, 8).join("") +
        zcidParts.even.slice(0, 12).join("") +
        zcidParts.odd.reverse().slice(0, 12).join("")
    );
}

function encryptUtf8(key, value) {
    return cryptojs.AES.encrypt(value, cryptojs.enc.Utf8.parse(key), {
        iv: { words: [0, 0, 0, 0], sigBytes: 16 },
        mode: cryptojs.mode.CBC,
        padding: cryptojs.pad.Pkcs7,
    }).ciphertext.toString(cryptojs.enc.Base64);
}

function encryptSession(value) {
    return cryptojs.AES.encrypt(value, cryptojs.enc.Base64.parse(secretKey), {
        iv: cryptojs.enc.Hex.parse("00000000000000000000000000000000"),
        mode: cryptojs.mode.CBC,
        padding: cryptojs.pad.Pkcs7,
    }).ciphertext.toString(cryptojs.enc.Base64);
}

function jsonResponse(value) {
    return new Response(JSON.stringify(value), {
        status: 200,
        headers: { "content-type": "application/json" },
    });
}

function socketFrame(command, subCommand, value) {
    const payload = new TextEncoder().encode(JSON.stringify(value));
    const output = new Uint8Array(4 + payload.byteLength);
    const view = new DataView(output.buffer);
    view.setUint8(0, 1);
    view.setUint16(1, command, true);
    view.setUint8(3, subCommand);
    output.set(payload, 4);
    return output.buffer;
}

async function encryptedSocketEvent(value) {
    const iv = webcrypto.getRandomValues(new Uint8Array(16));
    const additionalData = webcrypto.getRandomValues(new Uint8Array(16));
    const key = await webcrypto.subtle.importKey("raw", Buffer.from(socketKey, "base64"), "AES-GCM", false, [
        "encrypt",
    ]);
    const compressed = pako.deflate(new TextEncoder().encode(JSON.stringify(value)));
    const encrypted = new Uint8Array(
        await webcrypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData, tagLength: 128 }, key, compressed),
    );
    return {
        encrypt: 2,
        data: encodeURIComponent(Buffer.concat([iv, additionalData, encrypted]).toString("base64")),
    };
}

async function fetchMock(input, init = {}) {
    const url = new URL(input);
    requests.push({ url, init });
    if (url.pathname.endsWith("/account/login/native/check-login-status")) {
        nativeStatusCalls++;
        if (nativeStatusCalls > 1) {
            return jsonResponse({
                error_code: 0,
                data: {
                    status: "connected",
                    url: "https://id.zalo.me/checksession?continue=https%3A%2F%2Fchat.zalo.me",
                },
            });
        }
        return jsonResponse({ error_code: 0, data: { token: "native-token", status: "unknown" } });
    }
    if (url.pathname.endsWith("/account/logininfo")) {
        return jsonResponse({ error_code: 0, data: { logged: true } });
    }
    if (url.pathname.endsWith("/getLoginInfo")) {
        const data = {
            error_code: 0,
            data: {
                uid: "self-uid",
                zpw_enk: secretKey,
                zpw_ws: ["wss://ws.zalo.me/socket"],
                zpw_service_map_v3: {
                    friend: ["https://friend.zalo.me"],
                    chat: ["https://chat-api.zalo.me"],
                },
            },
        };
        return jsonResponse({ error_code: 0, data: encryptUtf8(loginKey(url), JSON.stringify(data)) });
    }
    if (url.pathname.endsWith("/getServerInfo")) {
        return jsonResponse({
            error_code: 0,
            data: {
                settings: {
                    features: {
                        socket: {
                            ping_interval: 60000,
                            close_and_retry_codes: [1006],
                            rotate_error_codes: [],
                        },
                    },
                },
            },
        });
    }
    if (url.pathname.endsWith("/profile/get")) {
        return jsonResponse({
            error_code: 0,
            data: encryptSession(JSON.stringify({ error_code: 0, data: { uid: "target-uid" } })),
        });
    }
    if (url.pathname.endsWith("/message/sms")) {
        return jsonResponse({
            error_code: 0,
            data: encryptSession(JSON.stringify({ error_code: 0, data: { msgId: 12345 } })),
        });
    }
    if (url.pathname.endsWith("/message/delete")) {
        const params = new URLSearchParams(init.body).get("params");
        assert.ok(params, "delete request must contain encrypted params");
        return jsonResponse({
            error_code: 0,
            data: encryptSession(JSON.stringify({ error_code: 0, data: { status: 0 } })),
        });
    }
    throw new Error(`Unexpected request ${url}`);
}

const context = {
    URL,
    URLSearchParams,
    Headers,
    Response,
    TextEncoder,
    TextDecoder,
    CustomEvent: class CustomEvent {
        constructor(type, options) {
            this.type = type;
            this.detail = options?.detail;
        }
    },
    navigator: { userAgent: "zca-runtime-test" },
    location: { protocol: "https:", hostname: "chat.zalo.me" },
    crypto: webcrypto,
    fetch: fetchMock,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
    Blob,
    atob,
    btoa,
    WebSocket: MockWebSocket,
    dispatchEvent() {},
    TestBridge: { postMessage: (message) => bridgeMessages.push(JSON.parse(message)) },
};
context.window = context;

vm.runInNewContext(bundle, context, { filename: "zca-runtime.js" });
assert.ok(context.ZCA, "bundle must expose window.ZCA");
assert.equal(context.ZCA.loginPageUrl, "https://id.zalo.me/account?continue=https%3A%2F%2Fchat.zalo.me");
assert.equal(context.ZCA.hostUrl, "https://chat.zalo.me/__zca_runtime_host__");
const nativeLogin = await context.ZCA.prepareNativeLogin();
assert.equal(nativeLogin.loginUrl, "zalo://login/?browser=chrome&token=native-token");
const nativeConfirmation = await context.ZCA.checkNativeLogin();
assert.equal(nativeConfirmation.navigating, true);
assert.equal(
    nativeConfirmation.navigationUrl,
    "https://id.zalo.me/checksession?continue=https%3A%2F%2Fchat.zalo.me",
);
assert.equal((await context.ZCA.checkNativeLogin()).logged, true);
assert.equal(
    requests.find(({ url }) => url.pathname.endsWith("/account/login/native/check-login-status"))?.init.method,
    "POST",
);
assert.equal(requests.find(({ url }) => url.pathname.endsWith("/account/logininfo"))?.init.method, "POST");
await context.ZCA.init({
    bridgeName: "TestBridge",
    imei: "test-imei",
    logging: false,
    autoConnect: false,
});
assert.equal(context.ZCA.getState().ready, true);

const sent = await context.ZCA.sendToPhone({
    phone: "0912345678",
    text: "hello",
    deleteOnlyMe: true,
    waitForAck: "server",
});
assert.equal(sent.phone, "84912345678");
assert.equal(sent.uid, "target-uid");
assert.equal(sent.msgId, "12345");
assert.ok(sent.cliMsgId);
assert.equal(sent.deletedOnlyMe, true);
assert.ok(bridgeMessages.some((message) => message.event === "task_complete"));
assert.ok(requests.some(({ url }) => url.pathname.endsWith("/message/delete")));

context.ZCA.startConnection();
assert.equal(sockets.length, 1);
sockets[0].open();
sockets[0].message(socketFrame(1, 1, { key: socketKey }));
await new Promise((resolve) => setTimeout(resolve, 0));
const deliveredTask = context.ZCA.sendToPhone({
    phone: "0912345678",
    text: "wait for delivered",
    deleteOnlyMe: true,
});
await new Promise((resolve) => setTimeout(resolve, 0));
sockets[0].message(
    socketFrame(
        502,
        0,
        await encryptedSocketEvent({
            data: {
                delivereds: [
                    {
                        msgId: "12345",
                        deliveredUids: ["target-uid"],
                        mSTs: Date.now(),
                    },
                ],
                seens: [],
            },
        }),
    ),
);
const delivered = await Promise.race([
    deliveredTask,
    new Promise((_, reject) =>
        setTimeout(
            () => reject(new Error(`Delivered ACK test timed out: ${JSON.stringify(bridgeMessages.slice(-5))}`)),
            2000,
        ),
    ),
]);
assert.equal(delivered.ack, 2);
assert.equal(delivered.deletedOnlyMe, true);
assert.ok(bridgeMessages.some((message) => message.event === "message_delivered"));

const seenWait = context.ZCA.waitForAck("12345", 3, 2000);
sockets[0].message(
    socketFrame(
        502,
        0,
        await encryptedSocketEvent({
            data: {
                delivereds: [],
                seens: [{ msgId: "12345", idTo: "target-uid", realMsgId: "12345" }],
            },
        }),
    ),
);
assert.equal((await seenWait).ack, 3);
assert.ok(bridgeMessages.some((message) => message.event === "message_seen"));

const finalCleanupMessage = await context.ZCA.sendToPhone({
    taskKey: "task-final-cleanup",
    phone: "0912345678",
    text: "cleanup at task end",
    deleteOnlyMe: false,
    waitForAck: "server",
});
assert.equal(finalCleanupMessage.deletedOnlyMe, false);
assert.equal(context.ZCA.getPendingDeletes("task-final-cleanup").length, 1);
const finalCleanup = await context.ZCA.finishTask("task-final-cleanup");
assert.equal(finalCleanup.attempted, 1);
assert.equal(finalCleanup.deleted, 1);
assert.equal(finalCleanup.pending, 0);
assert.equal(finalCleanup.failures.length, 0);
assert.equal(context.ZCA.getPendingDeletes("task-final-cleanup").length, 0);
assert.ok(bridgeMessages.some((message) => message.event === "task_cleanup_complete"));

context.ZCA.reset();
context.fetch = async () => jsonResponse({ error_code: -1, error_message: "Login required", data: null });
await assert.rejects(context.ZCA.init({ imei: "test-imei" }), (error) => error.code === "AUTH_REQUIRED");
assert.equal(context.ZCA.getState().state, "auth_required");

console.log("zca-runtime smoke test passed");
