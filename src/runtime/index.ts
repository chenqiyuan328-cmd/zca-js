import cryptojs from "crypto-js";
import JSONBigFactory from "json-bigint";
import pako from "pako";

const RUNTIME_VERSION = "0.2.2";
const DEFAULT_API_TYPE = 30;
const DEFAULT_API_VERSION = 685;

type JsonMap = Record<string, unknown>;

type ServiceMap = {
    friend: string[];
    chat: string[];
};

type RuntimeSession = {
    uid: string;
    imei: string;
    language: string;
    secretKey: string;
    services: ServiceMap & Record<string, string[]>;
    wsUrls: string[];
    socket: {
        pingInterval: number;
        closeAndRetryCodes: number[];
        rotateErrorCodes: number[];
    };
};

export type RuntimeState = "idle" | "initializing" | "ready" | "auth_required" | "error";
export type ConnectionState = "idle" | "connecting" | "connected" | "reconnecting" | "disconnected";
export type AckLevel = 1 | 2 | 3;

export type RuntimeOptions = {
    apiType?: number;
    apiVersion?: number;
    language?: string;
    imei?: string;
    bridgeName?: string;
    logging?: boolean;
    autoConnect?: boolean;
    reconnect?: boolean;
};

export type ZaloUserByPhone = {
    uid: string;
    zalo_name?: string;
    display_name?: string;
    avatar?: string;
    [key: string]: unknown;
};

export type SentText = {
    taskKey?: string;
    phone?: string;
    uid: string;
    msgId: string;
    cliMsgId: string;
    deletedOnlyMe: boolean;
    ack: AckLevel;
};

export type SendToPhoneOptions = {
    taskKey?: string;
    phone: string;
    text: string;
    deleteOnlyMe?: boolean;
    waitForAck?: "server" | "delivered" | "seen";
    ackTimeoutMs?: number;
};

export type CleanupSentMessagesOptions = {
    taskKey?: string;
    minimumAck?: AckLevel;
};

export type CleanupSentMessagesResult = {
    taskKey?: string;
    attempted: number;
    deleted: number;
    pending: number;
    failures: Array<{
        msgId: string;
        code: string;
        message: string;
        zaloCode?: number;
    }>;
};

export type AckEvent = {
    ack: AckLevel;
    msgId: string;
    realMsgId?: string;
    uid?: string;
    timestamp?: number;
};

export type NativeLoginResult = {
    token: string;
    loginUrl: string;
    status: string;
};

export type DeleteOnlyMeTarget = {
    uid: string;
    msgId: string | number;
    cliMsgId: string | number;
    uidFrom?: string;
};

export class ZCARuntimeError extends Error {
    constructor(
        message: string,
        public readonly code: string,
        public readonly zaloCode?: number,
    ) {
        super(message);
        this.name = "ZCARuntimeError";
    }
}

type ZaloEnvelope<T> = {
    error_code: number;
    error_message?: string;
    data: T;
};

const JSONBig = JSONBigFactory({ storeAsString: true });

function base64Bytes(value: string) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

async function socketBytes(value: unknown): Promise<Uint8Array> {
    if (value instanceof ArrayBuffer || Object.prototype.toString.call(value) === "[object ArrayBuffer]") {
        return new Uint8Array(value as ArrayBuffer);
    }
    if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    if (typeof Blob !== "undefined" && value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
    if (typeof value === "string") return new TextEncoder().encode(value);
    throw new ZCARuntimeError("Unsupported WebSocket frame", "INVALID_SOCKET_FRAME");
}

async function decodeSocketPayload(parsed: JsonMap, cipherKey?: string) {
    if (typeof parsed.data !== "string" || typeof parsed.encrypt !== "number") {
        throw new ZCARuntimeError("Invalid Zalo socket payload", "INVALID_SOCKET_PAYLOAD");
    }
    const encryptType = parsed.encrypt;
    if (![0, 1, 2, 3].includes(encryptType)) {
        throw new ZCARuntimeError("Unsupported Zalo socket encryption", "INVALID_SOCKET_PAYLOAD");
    }
    if (encryptType === 0) return JSONBig.parse(parsed.data) as JsonMap;

    const encoded = base64Bytes(encryptType === 1 ? parsed.data : decodeURIComponent(parsed.data));
    let decoded: Uint8Array = encoded;
    if (encryptType !== 1) {
        if (!cipherKey || encoded.byteLength < 48) {
            throw new ZCARuntimeError("Missing Zalo socket cipher key", "MISSING_CIPHER_KEY");
        }
        const algorithm = {
            name: "AES-GCM",
            iv: encoded.slice(0, 16),
            additionalData: encoded.slice(16, 32),
            tagLength: 128,
        };
        const key = await globalThis.crypto.subtle.importKey("raw", base64Bytes(cipherKey), "AES-GCM", false, [
            "decrypt",
        ]);
        decoded = new Uint8Array(await globalThis.crypto.subtle.decrypt(algorithm, key, encoded.slice(32)));
    }
    const inflated = encryptType === 3 ? decoded : pako.inflate(decoded);
    return JSONBig.parse(new TextDecoder().decode(inflated)) as JsonMap;
}

function hasOwn(value: object, key: PropertyKey) {
    return Object.prototype.hasOwnProperty.call(value, key);
}

function md5(value: string) {
    return cryptojs.MD5(value).toString();
}

function makeUUID() {
    if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
        const random = Math.floor(Math.random() * 16);
        const value = character === "x" ? random : (random & 0x3) | 0x8;
        return value.toString(16);
    });
}

function makeImei() {
    const storageKey = "__zca_runtime_imei_v1";
    try {
        // Reuse the official browser identity when available.
        const officialImei = discoverOfficialImei();
        if (officialImei) {
            localStorage.setItem(storageKey, officialImei);
            return officialImei;
        }
        const saved = localStorage.getItem(storageKey);
        if (saved) return saved;
        const generated = `${makeUUID()}-${md5(navigator.userAgent)}`;
        localStorage.setItem(storageKey, generated);
        return generated;
    } catch {
        return `${makeUUID()}-${md5(navigator.userAgent)}`;
    }
}

function discoverOfficialImei() {
    try {
        for (const key of ["z_uuid", "sh_z_uuid"]) {
            const stored = localStorage.getItem(key)?.trim() || "";
            if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[0-9a-f]{32}$/i.test(stored)) {
                return stored;
            }
        }
    } catch {
        // Storage may be disabled in the host WebView.
    }
    return "";
}

function signKey(type: string, params: JsonMap) {
    const keys = Object.keys(params)
        .filter((key) => hasOwn(params, key))
        .sort();
    return md5(`zsecure${type}${keys.map((key) => String(params[key])).join("")}`);
}

function encodeWithUtf8Key(key: string, data: string, output: "hex" | "base64", uppercase = false) {
    const iv = { words: [0, 0, 0, 0], sigBytes: 16 } as cryptojs.lib.WordArray;
    const encoded = cryptojs.AES.encrypt(data, cryptojs.enc.Utf8.parse(key), {
        iv,
        mode: cryptojs.mode.CBC,
        padding: cryptojs.pad.Pkcs7,
    }).ciphertext.toString(output === "hex" ? cryptojs.enc.Hex : cryptojs.enc.Base64);
    return uppercase ? encoded.toUpperCase() : encoded;
}

function decodeWithUtf8Key(key: string, data: string) {
    const iv = { words: [0, 0, 0, 0], sigBytes: 16 } as cryptojs.lib.WordArray;
    return cryptojs.AES.decrypt(
        { ciphertext: cryptojs.enc.Base64.parse(decodeURIComponent(data)) } as cryptojs.lib.CipherParams,
        cryptojs.enc.Utf8.parse(key),
        { iv, mode: cryptojs.mode.CBC, padding: cryptojs.pad.Pkcs7 },
    ).toString(cryptojs.enc.Utf8);
}

function encodeSessionPayload(secretKey: string, data: string) {
    const key = cryptojs.enc.Base64.parse(secretKey);
    const iv = cryptojs.enc.Hex.parse("00000000000000000000000000000000");
    return cryptojs.AES.encrypt(data, key, {
        iv,
        mode: cryptojs.mode.CBC,
        padding: cryptojs.pad.Pkcs7,
    }).ciphertext.toString(cryptojs.enc.Base64);
}

function decodeSessionPayload(secretKey: string, data: string) {
    const key = cryptojs.enc.Base64.parse(secretKey);
    const iv = cryptojs.enc.Hex.parse("00000000000000000000000000000000");
    return cryptojs.AES.decrypt(
        { ciphertext: cryptojs.enc.Base64.parse(decodeURIComponent(data)) } as cryptojs.lib.CipherParams,
        key,
        { iv, mode: cryptojs.mode.CBC, padding: cryptojs.pad.Pkcs7 },
    ).toString(cryptojs.enc.Utf8);
}

class ParamsEncryptor {
    private readonly zcid: string;
    private readonly zcidExt: string;
    private readonly encryptKey: string;

    constructor(type: number, imei: string) {
        this.zcid = encodeWithUtf8Key("3FC4F0D2AB50057BCE0D90D9187A22B1", `${type},${imei},${Date.now()}`, "hex", true);
        this.zcidExt = ParamsEncryptor.randomString();
        this.encryptKey = this.createEncryptKey();
    }

    private static randomString() {
        const length = Math.floor(Math.random() * 7) + 6;
        let output = "";
        while (output.length < length) output += Math.random().toString(16).slice(2);
        return output.slice(0, length);
    }

    private static split(value: string) {
        const even: string[] = [];
        const odd: string[] = [];
        [...value].forEach((character, index) => (index % 2 === 0 ? even : odd).push(character));
        return { even, odd };
    }

    private createEncryptKey() {
        const zcidExtHash = ParamsEncryptor.split(md5(this.zcidExt).toUpperCase()).even;
        const zcidParts = ParamsEncryptor.split(this.zcid);
        return (
            zcidExtHash.slice(0, 8).join("") +
            zcidParts.even.slice(0, 12).join("") +
            zcidParts.odd.reverse().slice(0, 12).join("")
        );
    }

    build(data: JsonMap) {
        return {
            key: this.encryptKey,
            data: encodeWithUtf8Key(this.encryptKey, JSON.stringify(data), "base64"),
            params: { zcid: this.zcid, zcid_ext: this.zcidExt, enc_ver: "v2" },
        };
    }
}

class ZCARuntime {
    readonly version = RUNTIME_VERSION;
    readonly loginPageUrl = "https://id.zalo.me/account?continue=https%3A%2F%2Fchat.zalo.me";
    readonly hostUrl = "https://chat.zalo.me/";
    readonly isolatedHostUrl = "https://chat.zalo.me/__zca_runtime_host__";
    private state: RuntimeState = "idle";
    private options: Required<Omit<RuntimeOptions, "bridgeName" | "imei">> &
        Pick<RuntimeOptions, "bridgeName" | "imei"> = {
        apiType: DEFAULT_API_TYPE,
        apiVersion: DEFAULT_API_VERSION,
        language: "vi",
        logging: false,
        autoConnect: true,
        reconnect: true,
    };
    private session: RuntimeSession | null = null;
    private listeners = new Map<string, Set<(payload: unknown) => void>>();
    private lastClientId = 0;
    private connectionState: ConnectionState = "idle";
    private socket: WebSocket | null = null;
    private socketKey?: string;
    private socketEndpointIndex = 0;
    private reconnectAttempt = 0;
    private reconnectTimer?: ReturnType<typeof setTimeout>;
    private pingTimer?: ReturnType<typeof setInterval>;
    private manuallyClosed = false;
    private nativeLogin?: NativeLoginResult & { createdAt: number };
    private ackByMessage = new Map<string, AckEvent>();
    private sentByMessage = new Map<string, SentText>();
    private ackWaiters = new Map<
        string,
        Set<{
            level: AckLevel;
            resolve: (ack: AckEvent) => void;
            reject: (error: ZCARuntimeError) => void;
            timer: ReturnType<typeof setTimeout>;
        }>
    >();

    get isReady() {
        return this.state === "ready" && this.session !== null;
    }

    get isConnected() {
        return this.connectionState === "connected";
    }

    configure(options: RuntimeOptions = {}) {
        this.options = { ...this.options, ...options };
        return this.getState();
    }

    getState() {
        return {
            state: this.state,
            ready: this.isReady,
            uid: this.session?.uid ?? "",
            connection: this.connectionState,
            connected: this.isConnected,
            version: this.version,
        };
    }

    on(event: string, listener: (payload: unknown) => void) {
        const listeners = this.listeners.get(event) ?? new Set();
        listeners.add(listener);
        this.listeners.set(event, listeners);
        return () => listeners.delete(listener);
    }

    private emit(event: string, payload: unknown) {
        this.listeners.get(event)?.forEach((listener) => {
            try {
                listener(payload);
            } catch {
                // Listener failures must not break the runtime event loop.
            }
        });
        try {
            window.dispatchEvent(new CustomEvent(`zca:${event}`, { detail: payload }));
        } catch {
            // CustomEvent is optional in older Android WebViews.
        }
        const bridgeName = this.options.bridgeName;
        if (bridgeName) {
            try {
                const bridge = (window as unknown as Record<string, { postMessage?: (message: string) => void }>)[
                    bridgeName
                ];
                bridge?.postMessage?.(JSON.stringify({ event, payload, runtimeVersion: this.version }));
            } catch {
                // The Flutter channel may disappear while the WebView reloads.
            }
        }
    }

    private setState(state: RuntimeState, reason?: string) {
        this.state = state;
        const snapshot = { ...this.getState(), reason: reason ?? "" };
        this.emit("status", snapshot);
        return snapshot;
    }

    private assertAllowedOrigin() {
        if (
            location.protocol !== "https:" ||
            !(location.hostname === "zalo.me" || location.hostname.endsWith(".zalo.me"))
        ) {
            throw new ZCARuntimeError("Runtime must run on a Zalo HTTPS origin", "INVALID_ORIGIN");
        }
    }

    private makeURL(baseURL: string, params: Record<string, string | number> = {}, withVersion = true) {
        const url = new URL(baseURL);
        Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));
        if (withVersion) {
            if (!url.searchParams.has("zpw_ver")) url.searchParams.set("zpw_ver", String(this.options.apiVersion));
            if (!url.searchParams.has("zpw_type")) url.searchParams.set("zpw_type", String(this.options.apiType));
        }
        return url.toString();
    }

    private async request(url: string, init: RequestInit = {}) {
        const headers = new Headers(init.headers);
        if (!headers.has("Accept")) headers.set("Accept", "application/json, text/plain, */*");
        if (init.body instanceof URLSearchParams && !headers.has("Content-Type")) {
            headers.set("Content-Type", "application/x-www-form-urlencoded;charset=UTF-8");
        }
        return fetch(url, { ...init, headers, credentials: "include" });
    }

    private async readJson<T>(response: Response) {
        if (!response.ok) throw new ZCARuntimeError(`HTTP ${response.status}`, "HTTP_ERROR");
        return (await response.json()) as T;
    }

    private async resolve<T>(response: Response) {
        const session = this.requireSession();
        const outer = await this.readJson<ZaloEnvelope<string>>(response);
        if (outer.error_code !== 0) {
            throw new ZCARuntimeError(outer.error_message || "Zalo request failed", "ZALO_ERROR", outer.error_code);
        }
        let inner: ZaloEnvelope<T>;
        try {
            inner = JSONBig.parse(decodeSessionPayload(session.secretKey, outer.data)) as ZaloEnvelope<T>;
        } catch {
            throw new ZCARuntimeError("Unable to decrypt Zalo response", "INVALID_RESPONSE");
        }
        if (inner.error_code !== 0) {
            throw new ZCARuntimeError(inner.error_message || "Zalo request failed", "ZALO_ERROR", inner.error_code);
        }
        return inner.data;
    }

    private requireSession() {
        if (!this.session || this.state !== "ready") {
            throw new ZCARuntimeError("Zalo session is not ready", "AUTH_REQUIRED");
        }
        return this.session;
    }

    private nextClientId() {
        this.lastClientId = Math.max(Date.now(), this.lastClientId + 1);
        return this.lastClientId;
    }

    async prepareNativeLogin(browser = "chrome", force = false): Promise<NativeLoginResult> {
        this.assertAllowedOrigin();
        if (!force && this.nativeLogin && Date.now() - this.nativeLogin.createdAt < 90_000) {
            return {
                token: this.nativeLogin.token,
                loginUrl: this.nativeLogin.loginUrl,
                status: this.nativeLogin.status,
            };
        }
        const response = await this.request("https://id.zalo.me/account/login/native/check-login-status", {
            method: "POST",
            cache: "no-store",
            headers: { "X-Requested-With": "XMLHttpRequest" },
            body: this.loginForm(),
        });
        const envelope = await this.readJson<ZaloEnvelope<{ token?: string; status?: string } | null>>(response);
        const token = envelope.data?.token?.trim() || "";
        if (envelope.error_code !== 0 || !token) {
            throw new ZCARuntimeError(
                envelope.error_message || "Unable to prepare Zalo app login",
                "NATIVE_LOGIN_UNAVAILABLE",
                envelope.error_code,
            );
        }
        const result = {
            token,
            status: envelope.data?.status || "unknown",
            loginUrl: `zalo://login/?browser=${encodeURIComponent(browser)}&token=${encodeURIComponent(token)}`,
        };
        this.nativeLogin = { ...result, createdAt: Date.now() };
        this.emit("login_url", result);
        return result;
    }

    async checkNativeLogin() {
        this.assertAllowedOrigin();
        const response = await this.request("https://id.zalo.me/account/logininfo", {
            method: "POST",
            cache: "no-store",
            headers: { "X-Requested-With": "XMLHttpRequest" },
            body: this.loginForm(),
        });
        const envelope = await this.readJson<ZaloEnvelope<JsonMap | null>>(response);
        if (envelope.error_code !== 0) {
            throw new ZCARuntimeError(
                envelope.error_message || "Unable to check Zalo login",
                "LOGIN_CHECK_FAILED",
                envelope.error_code,
            );
        }
        const requiresConfirmation = envelope.data?.require_confirm_pwd === true;
        const accountLogged = envelope.data?.logged === true;
        const logged = accountLogged && !requiresConfirmation;
        const result = { logged, accountLogged, requiresConfirmation, data: envelope.data ?? {} };
        this.emit(logged ? "authenticated" : "auth_required", result);
        if (logged) this.nativeLogin = undefined;
        return result;
    }

    private loginForm() {
        if (location.hostname !== "id.zalo.me") {
            throw new ZCARuntimeError("Open the Zalo login page before requesting authorization", "LOGIN_PAGE_REQUIRED");
        }
        const form = new URLSearchParams({ continue: "https://chat.zalo.me/" });
        // The version belongs to the login UI, not the chat API version 685.
        for (const script of Array.from(document.scripts)) {
            const match = script.src.match(/^https:\/\/stc-zlogin\.zdn\.vn\/main-([\d.]+)\.js(?:\?.*)?$/);
            if (match) {
                form.set("v", match[1]);
                break;
            }
        }
        return form;
    }

    async init(options: RuntimeOptions = {}) {
        if (this.socket || this.reconnectTimer) this.stopConnection();
        this.configure(options);
        this.assertAllowedOrigin();
        this.setState("initializing");
        const imei = this.options.imei || makeImei();
        this.options.imei = imei;
        const language = this.options.language;
        try {
            const baseData = { computer_name: "Web", imei, language, ts: Date.now() };
            const encryptor = new ParamsEncryptor(this.options.apiType, imei);
            const encrypted = encryptor.build(baseData);
            const loginParams: JsonMap = {
                ...encrypted.params,
                params: encrypted.data,
                type: this.options.apiType,
                client_version: this.options.apiVersion,
            };
            loginParams.signkey = signKey("getlogininfo", loginParams);
            const loginUrl = this.makeURL("https://wpa.chat.zalo.me/api/login/getLoginInfo", {
                ...(loginParams as Record<string, string | number>),
                nretry: 0,
            });
            const loginOuter = await this.readJson<ZaloEnvelope<string>>(await this.request(loginUrl));
            if (loginOuter.error_code !== 0 || !loginOuter.data) {
                throw new ZCARuntimeError(
                    loginOuter.error_message || "Zalo authorization is required",
                    "AUTH_REQUIRED",
                    loginOuter.error_code,
                );
            }
            const loginDecoded = JSONBig.parse(decodeWithUtf8Key(encrypted.key, loginOuter.data)) as {
                error_code: number;
                error_message?: string;
                data?: JsonMap;
            };
            const loginInfo = loginDecoded.data;
            if (loginDecoded.error_code !== 0 || !loginInfo) {
                throw new ZCARuntimeError(
                    loginDecoded.error_message || "Zalo authorization is required",
                    "AUTH_REQUIRED",
                    loginDecoded.error_code,
                );
            }

            const serverParams: JsonMap = {
                imei,
                type: this.options.apiType,
                client_version: this.options.apiVersion,
                computer_name: "Web",
            };
            serverParams.signkey = signKey("getserverinfo", serverParams);
            const serverUrl = this.makeURL(
                "https://wpa.chat.zalo.me/api/login/getServerInfo",
                serverParams as Record<string, string | number>,
                false,
            );
            const serverOuter = await this.readJson<ZaloEnvelope<JsonMap>>(await this.request(serverUrl));
            if (serverOuter.error_code !== 0 || !serverOuter.data) {
                throw new ZCARuntimeError(
                    serverOuter.error_message || "Unable to initialize Zalo services",
                    "INIT_FAILED",
                    serverOuter.error_code,
                );
            }
            const secretKey = String(loginInfo.zpw_enk || "");
            const uid = String(loginInfo.uid || "");
            const services = loginInfo.zpw_service_map_v3 as RuntimeSession["services"] | undefined;
            const wsUrls = Array.isArray(loginInfo.zpw_ws)
                ? loginInfo.zpw_ws.filter((value): value is string => typeof value === "string" && value.length > 0)
                : [];
            const settings = (serverOuter.data.setttings || serverOuter.data.settings || {}) as JsonMap;
            const features = (settings.features || {}) as JsonMap;
            const socketSettings = (features.socket || {}) as JsonMap;
            const pingInterval = Number(socketSettings.ping_interval || 30_000);
            const closeAndRetryCodes = Array.isArray(socketSettings.close_and_retry_codes)
                ? socketSettings.close_and_retry_codes.map(Number)
                : [1006];
            const rotateErrorCodes = Array.isArray(socketSettings.rotate_error_codes)
                ? socketSettings.rotate_error_codes.map(Number)
                : [];
            if (!secretKey || !uid || !services?.friend?.[0] || !services?.chat?.[0]) {
                throw new ZCARuntimeError("Incomplete Zalo session", "INVALID_SESSION");
            }
            this.session = {
                uid,
                imei,
                language,
                secretKey,
                services,
                wsUrls,
                socket: {
                    pingInterval: Math.max(5_000, pingInterval),
                    closeAndRetryCodes,
                    rotateErrorCodes,
                },
            };
            this.setState("ready");
            if (this.options.autoConnect && wsUrls.length > 0) this.startConnection();
            return this.getState();
        } catch (error) {
            this.session = null;
            const runtimeError =
                error instanceof ZCARuntimeError ? error : new ZCARuntimeError(String(error), "INIT_FAILED");
            this.setState(runtimeError.code === "AUTH_REQUIRED" ? "auth_required" : "error", runtimeError.code);
            this.emit("error", {
                code: runtimeError.code,
                message: runtimeError.message,
                zaloCode: runtimeError.zaloCode,
            });
            throw runtimeError;
        }
    }

    startConnection() {
        const session = this.requireSession();
        if (
            this.socket &&
            (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)
        ) {
            return this.getState();
        }
        if (session.wsUrls.length === 0) {
            throw new ZCARuntimeError("Zalo did not provide a WebSocket endpoint", "ACK_UNAVAILABLE");
        }
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = undefined;
        this.manuallyClosed = false;
        this.connectionState = this.reconnectAttempt > 0 ? "reconnecting" : "connecting";
        this.emit("connection", this.getState());

        const endpoint = session.wsUrls[this.socketEndpointIndex % session.wsUrls.length];
        const url = this.makeURL(endpoint, { t: Date.now() });
        const socket = new WebSocket(url);
        socket.binaryType = "arraybuffer";
        this.socket = socket;

        socket.onopen = () => {
            if (this.socket !== socket) return;
            this.reconnectAttempt = 0;
            this.connectionState = "connected";
            this.emit("connected", this.getState());
            this.emit("connection", this.getState());
        };
        socket.onmessage = (event) => {
            if (this.socket !== socket) return;
            void this.handleSocketFrame(event.data).catch((error) => {
                const runtimeError =
                    error instanceof ZCARuntimeError
                        ? error
                        : new ZCARuntimeError(String(error), "SOCKET_DECODE_FAILED");
                this.emit("connection_error", { code: runtimeError.code, message: runtimeError.message });
            });
        };
        socket.onerror = () => {
            if (this.socket === socket) {
                this.emit("connection_error", { code: "SOCKET_ERROR", message: "Zalo WebSocket error" });
            }
        };
        socket.onclose = (event) => {
            if (this.socket !== socket) return;
            this.socket = null;
            this.socketKey = undefined;
            this.stopPing();
            this.connectionState = "disconnected";
            this.emit("disconnected", { code: event.code, reason: event.reason || "" });
            this.emit("connection", this.getState());
            if (!this.manuallyClosed && this.shouldReconnect(event.code)) this.scheduleReconnect(event.code);
        };
        return this.getState();
    }

    stopConnection() {
        this.manuallyClosed = true;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = undefined;
        this.stopPing();
        const socket = this.socket;
        this.socket = null;
        this.socketKey = undefined;
        if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "runtime_stop");
        this.connectionState = "idle";
        this.emit("connection", this.getState());
        return this.getState();
    }

    private shouldReconnect(code: number) {
        if (!this.options.reconnect || code === 1000 || code === 3000 || code === 3003) return false;
        const configured = this.session?.socket.closeAndRetryCodes ?? [];
        return code === 1006 || configured.length === 0 || configured.includes(code);
    }

    private scheduleReconnect(code: number) {
        const session = this.session;
        if (!session) return;
        if (session.socket.rotateErrorCodes.includes(code) && session.wsUrls.length > 1) {
            this.socketEndpointIndex = (this.socketEndpointIndex + 1) % session.wsUrls.length;
        }
        this.reconnectAttempt++;
        const delays = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000];
        const delay = delays[Math.min(this.reconnectAttempt - 1, delays.length - 1)];
        this.connectionState = "reconnecting";
        this.emit("reconnecting", { attempt: this.reconnectAttempt, delay, code });
        this.emit("connection", this.getState());
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            try {
                this.startConnection();
            } catch (error) {
                this.emit("connection_error", { code: "RECONNECT_FAILED", message: String(error) });
            }
        }, delay);
    }

    private stopPing() {
        if (this.pingTimer) clearInterval(this.pingTimer);
        this.pingTimer = undefined;
    }

    private sendSocket(version: number, command: number, subCommand: number, data: JsonMap) {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
        const payload = new TextEncoder().encode(JSON.stringify(data));
        const frame = new Uint8Array(4 + payload.byteLength);
        const view = new DataView(frame.buffer);
        view.setUint8(0, version);
        view.setUint16(1, command, true);
        view.setUint8(3, subCommand);
        frame.set(payload, 4);
        this.socket.send(frame);
        return true;
    }

    private async handleSocketFrame(raw: unknown) {
        const bytes = await socketBytes(raw);
        if (bytes.byteLength < 4) throw new ZCARuntimeError("Invalid WebSocket header", "INVALID_SOCKET_FRAME");
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const version = view.getUint8(0);
        const command = view.getUint16(1, true);
        const subCommand = view.getUint8(3);
        const json = new TextDecoder().decode(bytes.slice(4));
        if (!json) return;
        const parsed = JSONBig.parse(json) as JsonMap;

        if (version === 1 && command === 1 && subCommand === 1 && typeof parsed.key === "string") {
            this.socketKey = parsed.key;
            this.stopPing();
            const interval = this.session?.socket.pingInterval ?? 30_000;
            this.pingTimer = setInterval(() => {
                this.sendSocket(1, 2, 1, { eventId: Date.now() });
            }, interval);
            this.emit("cipher_ready", { ready: true });
            return;
        }

        if (!((command === 502 || command === 522) && subCommand === 0)) return;
        const decoded = await decodeSocketPayload(parsed, this.socketKey);
        const data = (decoded.data || {}) as JsonMap;
        const delivered = Array.isArray(data.delivereds) ? data.delivereds : [];
        const seen = Array.isArray(data.seens) ? data.seens : Array.isArray(data.groupSeens) ? data.groupSeens : [];
        for (const item of delivered) {
            if (!item || typeof item !== "object") continue;
            const value = item as JsonMap;
            const event: AckEvent = {
                ack: 2,
                msgId: String(value.msgId || value.realMsgId || ""),
                realMsgId: value.realMsgId ? String(value.realMsgId) : undefined,
                uid: Array.isArray(value.deliveredUids) ? String(value.deliveredUids[0] || "") : undefined,
                timestamp: Number(value.mSTs || Date.now()),
            };
            if (event.msgId) this.recordAck(event, "message_delivered");
        }
        for (const item of seen) {
            if (!item || typeof item !== "object") continue;
            const value = item as JsonMap;
            const event: AckEvent = {
                ack: 3,
                msgId: String(value.msgId || value.realMsgId || ""),
                realMsgId: value.realMsgId ? String(value.realMsgId) : undefined,
                uid: value.idTo
                    ? String(value.idTo)
                    : Array.isArray(value.seenUids)
                      ? String(value.seenUids[0] || "")
                      : undefined,
                timestamp: Date.now(),
            };
            if (event.msgId) this.recordAck(event, "message_seen");
        }
    }

    private recordAck(event: AckEvent, eventName: "message_delivered" | "message_seen") {
        const ids = [event.msgId, event.realMsgId].filter((value): value is string => Boolean(value));
        for (const id of ids) {
            const current = this.ackByMessage.get(id);
            if (!current || current.ack <= event.ack) this.ackByMessage.set(id, event);
            const sent = this.sentByMessage.get(id);
            if (sent && sent.ack < event.ack) sent.ack = event.ack;
            while (this.ackByMessage.size > 2_000) {
                const oldest = this.ackByMessage.keys().next().value as string | undefined;
                if (!oldest) break;
                this.ackByMessage.delete(oldest);
            }
            const waiters = this.ackWaiters.get(id);
            if (!waiters) continue;
            for (const waiter of [...waiters]) {
                if (event.ack < waiter.level) continue;
                clearTimeout(waiter.timer);
                waiters.delete(waiter);
                waiter.resolve(event);
            }
            if (waiters.size === 0) this.ackWaiters.delete(id);
        }
        this.emit(eventName, event);
    }

    async waitForConnection(timeoutMs = 15_000) {
        if (this.connectionState === "connected") return this.getState();
        this.startConnection();
        return new Promise<ReturnType<ZCARuntime["getState"]>>((resolve, reject) => {
            const timer = setTimeout(() => {
                unsubscribe();
                reject(new ZCARuntimeError("Zalo WebSocket connection timed out", "CONNECTION_TIMEOUT"));
            }, timeoutMs);
            const unsubscribe = this.on("connected", () => {
                clearTimeout(timer);
                unsubscribe();
                resolve(this.getState());
            });
        });
    }

    async waitForAck(msgId: string | number, level: 2 | 3 = 2, timeoutMs = 60_000) {
        const id = String(msgId);
        const current = this.ackByMessage.get(id);
        if (current && current.ack >= level) return current;
        return new Promise<AckEvent>((resolve, reject) => {
            const waiters = this.ackWaiters.get(id) ?? new Set();
            const waiter = {
                level: level as AckLevel,
                resolve,
                reject,
                timer: setTimeout(
                    () => {
                        waiters.delete(waiter);
                        if (waiters.size === 0) this.ackWaiters.delete(id);
                        const error = new ZCARuntimeError(`ACK ${level} timed out`, "ACK_TIMEOUT");
                        this.emit("ack_timeout", { msgId: id, ack: level });
                        reject(error);
                    },
                    Math.max(1_000, timeoutMs),
                ),
            };
            waiters.add(waiter);
            this.ackWaiters.set(id, waiters);
        });
    }

    async findUserByPhone(rawPhone: string) {
        const session = this.requireSession();
        let phone = rawPhone.trim().replace(/[^0-9]/g, "");
        if (!phone) throw new ZCARuntimeError("Phone number is required", "INVALID_PHONE");
        if (phone.startsWith("0") && session.language === "vi") phone = `84${phone.slice(1)}`;
        const payload = {
            phone,
            avatar_size: 240,
            language: session.language,
            imei: session.imei,
            reqSrc: 40,
        };
        const encrypted = encodeSessionPayload(session.secretKey, JSON.stringify(payload));
        const url = this.makeURL(`${session.services.friend[0]}/api/friend/profile/get`, { params: encrypted });
        try {
            const user = await this.resolve<ZaloUserByPhone>(await this.request(url));
            if (!user?.uid) throw new ZCARuntimeError("Phone number was not found on Zalo", "PHONE_NOT_FOUND");
            return { phone, user };
        } catch (error) {
            if (error instanceof ZCARuntimeError && error.zaloCode === 216) {
                throw new ZCARuntimeError("Phone number was not found on Zalo", "PHONE_NOT_FOUND", 216);
            }
            throw error;
        }
    }

    async sendText(uid: string, text: string): Promise<SentText> {
        const session = this.requireSession();
        const target = uid.trim();
        const message = text.trim();
        if (!target) throw new ZCARuntimeError("Target UID is required", "INVALID_UID");
        if (!message) throw new ZCARuntimeError("Message text is required", "EMPTY_MESSAGE");
        const cliMsgId = String(this.nextClientId());
        const payload = {
            message,
            clientId: Number(cliMsgId),
            imei: session.imei,
            ttl: 0,
            toid: target,
        };
        const encrypted = encodeSessionPayload(session.secretKey, JSON.stringify(payload));
        const url = this.makeURL(`${session.services.chat[0]}/api/message/sms`, { nretry: 0 });
        const response = await this.resolve<{ msgId: string | number }>(
            await this.request(url, { method: "POST", body: new URLSearchParams({ params: encrypted }) }),
        );
        if (response?.msgId === undefined || response?.msgId === null) {
            throw new ZCARuntimeError("Zalo did not return a message ID", "INVALID_SEND_RESPONSE");
        }
        const result: SentText = {
            uid: target,
            msgId: String(response.msgId),
            cliMsgId,
            deletedOnlyMe: false,
            ack: 1,
        };
        this.sentByMessage.set(result.msgId, result);
        this.emit("message_sent", result);
        return result;
    }

    async deleteOnlyMe(target: DeleteOnlyMeTarget) {
        const session = this.requireSession();
        const payload = {
            toid: target.uid,
            cliMsgId: this.nextClientId(),
            msgs: [
                {
                    cliMsgId: String(target.cliMsgId),
                    globalMsgId: String(target.msgId),
                    ownerId: target.uidFrom || session.uid,
                    destId: target.uid,
                },
            ],
            onlyMe: 1,
            imei: session.imei,
        };
        const encrypted = encodeSessionPayload(session.secretKey, JSON.stringify(payload));
        const url = this.makeURL(`${session.services.chat[0]}/api/message/delete`);
        const response = await this.resolve<{ status: number }>(
            await this.request(url, { method: "POST", body: new URLSearchParams({ params: encrypted }) }),
        );
        const result = { ...target, status: Number(response?.status ?? 0), deletedOnlyMe: true };
        const sent = this.sentByMessage.get(String(target.msgId));
        if (sent) sent.deletedOnlyMe = true;
        this.emit("message_deleted", result);
        return result;
    }

    getPendingDeletes(taskKey?: string) {
        return [...this.sentByMessage.values()]
            .filter((sent) => !sent.deletedOnlyMe && (!taskKey || sent.taskKey === taskKey))
            .map((sent) => ({ ...sent }));
    }

    async cleanupSentMessages(options: CleanupSentMessagesOptions = {}): Promise<CleanupSentMessagesResult> {
        const minimumAck = options.minimumAck ?? 1;
        const candidates = this.getPendingDeletes(options.taskKey).filter((sent) => sent.ack >= minimumAck);
        const failures: CleanupSentMessagesResult["failures"] = [];
        let deleted = 0;
        for (const sent of candidates) {
            try {
                await this.deleteOnlyMe(sent);
                deleted++;
            } catch (error) {
                const runtimeError =
                    error instanceof ZCARuntimeError ? error : new ZCARuntimeError(String(error), "DELETE_FAILED");
                failures.push({
                    msgId: sent.msgId,
                    code: runtimeError.code,
                    message: runtimeError.message,
                    zaloCode: runtimeError.zaloCode,
                });
            }
        }
        const result: CleanupSentMessagesResult = {
            taskKey: options.taskKey,
            attempted: candidates.length,
            deleted,
            pending: this.getPendingDeletes(options.taskKey).length,
            failures,
        };
        this.emit("cleanup_complete", result);
        return result;
    }

    async finishTask(taskKey: string) {
        const normalizedTaskKey = taskKey.trim();
        if (!normalizedTaskKey) throw new ZCARuntimeError("Task key is required", "INVALID_TASK_KEY");
        const result = await this.cleanupSentMessages({ taskKey: normalizedTaskKey, minimumAck: 1 });
        this.emit("task_cleanup_complete", result);
        return result;
    }

    async sendToPhone(input: SendToPhoneOptions) {
        try {
            const ackMode = input.waitForAck ?? (input.deleteOnlyMe ? "delivered" : "server");
            if (ackMode !== "server") await this.waitForConnection(Math.min(input.ackTimeoutMs ?? 15_000, 30_000));
            const { phone, user } = await this.findUserByPhone(input.phone);
            const sent = await this.sendText(user.uid, input.text);
            sent.taskKey = input.taskKey?.trim() || undefined;
            sent.phone = phone;
            if (ackMode !== "server") {
                const ack = await this.waitForAck(sent.msgId, ackMode === "seen" ? 3 : 2, input.ackTimeoutMs);
                sent.ack = ack.ack;
            }
            if (input.deleteOnlyMe) {
                await this.deleteOnlyMe(sent);
                sent.deletedOnlyMe = true;
            }
            this.emit("task_complete", sent);
            return sent;
        } catch (error) {
            const runtimeError =
                error instanceof ZCARuntimeError ? error : new ZCARuntimeError(String(error), "SEND_FAILED");
            this.emit("task_error", {
                phone: input.phone,
                code: runtimeError.code,
                message: runtimeError.message,
                zaloCode: runtimeError.zaloCode,
            });
            throw runtimeError;
        }
    }

    reset() {
        this.stopConnection();
        for (const waiters of this.ackWaiters.values()) {
            for (const waiter of waiters) {
                clearTimeout(waiter.timer);
                waiter.reject(new ZCARuntimeError("Runtime was reset", "RUNTIME_RESET"));
            }
        }
        this.ackWaiters.clear();
        this.ackByMessage.clear();
        this.sentByMessage.clear();
        this.session = null;
        return this.setState("idle");
    }
}

export type ZCARuntimeAPI = ZCARuntime;

const runtime = new ZCARuntime();

declare global {
    interface Window {
        ZCA: ZCARuntime;
    }
}

window.ZCA = runtime;

export default runtime;
