package io.easycharles

import okhttp3.MediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/**
 * 控制面：HTTP 握手 + WebSocket 长连接。
 *
 * 控制面只负责注册身份、心跳、接收指令。它与数据面完全独立，
 * 控制面失败不得影响请求转发（[EasyCharlesInterceptor] 有自己的 fail-open）。
 */
internal class ControlPlane(
    private val config: EasyCharles.Config,
    private val identityProvider: () -> DeviceIdentity,
) {

    private val client = OkHttpClient.Builder()
        .pingInterval(30, TimeUnit.SECONDS)
        .build()

    private val scheduler: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "ec-control").apply { isDaemon = true }
    }

    @Volatile
    private var ws: WebSocket? = null

    @Volatile
    private var wsUrl: String? = null

    /** F-13：握手失败退避重试（1s → 2s → 5s → … → 30s 封顶），成功后重置 */
    @Volatile
    private var retryDelayMs = 1000L

    @Volatile
    private var stopped = false

    @Volatile
    private var heartbeatStarted = false

    fun start() {
        if (stopped) return
        scheduler.execute { handshake() }
    }

    private fun handshake() {
        val body = JSONObject().apply { put("identity", identityProvider().toJson()) }
        val builder = Request.Builder()
            .url("${config.baseUrl.trimEnd('/')}/__ec/hello")
            .post(RequestBody.create(JSON_MEDIA, body.toString()))
        // F-14：LAN 模式握手需带 token（服务端 --lan 强制，ADR-007）；回环模式为空则不带
        config.token?.takeIf { it.isNotBlank() }?.let { builder.header("X-EC-Token", it) }
        try {
            client.newCall(builder.build()).execute().use { resp ->
                if (resp.code == 401) {
                    // token 无效是配置问题，重试无意义
                    EasyCharles.log("hello unauthorized (check token), give up")
                    return
                }
                if (!resp.isSuccessful) {
                    EasyCharles.log("hello failed: HTTP ${resp.code}, retry in ${retryDelayMs}ms")
                    scheduleHandshakeRetry()
                    return
                }
                val json = JSONObject(resp.body?.string().orEmpty())
                val protocol = json.optInt("protocol", -1)
                if (protocol != PROTOCOL_VERSION) {
                    EasyCharles.log("protocol mismatch: server=$protocol sdk=$PROTOCOL_VERSION, will disable")
                    EasyCharles.disable()
                    return
                }
                wsUrl = json.optString("wsUrl").takeIf { it.isNotBlank() }
            }
        } catch (t: Throwable) {
            EasyCharles.log("hello error: ${t.message}, retry in ${retryDelayMs}ms")
            scheduleHandshakeRetry()
            return
        }
        if (wsUrl == null) {
            EasyCharles.log("hello missing wsUrl, retry in ${retryDelayMs}ms")
            scheduleHandshakeRetry()
            return
        }
        retryDelayMs = 1000L
        openWebSocket()
    }

    private fun scheduleHandshakeRetry() {
        if (stopped) return
        val delay = retryDelayMs
        retryDelayMs = minOf(retryDelayMs * 2, MAX_RETRY_DELAY_MS)
        scheduler.schedule({ if (!stopped && ws == null) handshake() }, delay, TimeUnit.MILLISECONDS)
    }

    private fun openWebSocket() {
        val url = wsUrl ?: return
        if (stopped) return
        val req = Request.Builder().url(url).build()
        ws = client.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (stopped) {
                    webSocket.close(1000, "shutdown")
                    return
                }
                val hello = JSONObject().apply { put("identity", identityProvider().toJson()) }
                // F-14：LAN 模式首条 WS 消息带 token（服务端首条消息鉴权）
                config.token?.takeIf { it.isNotBlank() }?.let { hello.put("token", it) }
                send("hello", hello)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                runCatching {
                    val m = JSONObject(text)
                    when (m.optString("type")) {
                        "command" -> handleCommand(m.optJSONObject("payload"))
                        "welcome" -> EasyCharles.log("control plane ready")
                    }
                }.onFailure { EasyCharles.log("bad ws message: ${it.message}") }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                EasyCharles.log("ws failure: ${t.message}")
                scheduleReconnect()
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                scheduleReconnect()
            }
        })
    }

    private fun scheduleReconnect() {
        if (stopped) return
        ws = null
        scheduler.schedule({ if (!stopped && ws == null) handshake() }, 5, TimeUnit.SECONDS)
    }

    private fun handleCommand(payload: JSONObject?) {
        when (payload?.optString("action")) {
            "set_enabled" -> {
                val enabled = payload.optBoolean("enabled", true)
                EasyCharles.setRemoteEnabled(enabled)
            }
            "reset_mock" -> EasyCharles.log("server asked to reset mock pointers (handled server-side)")
            else -> EasyCharles.log("unknown command ignored")
        }
    }

    private fun send(type: String, payload: JSONObject) {
        val msg = JSONObject().apply {
            put("v", PROTOCOL_VERSION)
            put("type", type)
            put("payload", payload)
        }
        runCatching { ws?.send(msg.toString()) }
    }

    /** 业务登录 / 登出后调用，把 userId 等变更推给服务端 */
    fun updateIdentity() {
        send("identity_update", identityProvider().patchJson())
    }

    fun startHeartbeat() {
        if (heartbeatStarted) return
        heartbeatStarted = true
        scheduler.scheduleAtFixedRate({
            send("heartbeat", JSONObject().apply { put("t", System.currentTimeMillis()) })
        }, 30, 30, TimeUnit.SECONDS)
    }

    /** 释放线程与 WS；重复 init 时被上一实例调用 */
    fun shutdown() {
        stopped = true
        runCatching { ws?.close(1000, "shutdown") }
        ws = null
        scheduler.shutdownNow()
        client.dispatcher.executorService.shutdown()
    }

    companion object {
        private val JSON_MEDIA: MediaType? = MediaType.parse("application/json; charset=utf-8")
        private const val PROTOCOL_VERSION = 2
        private const val MAX_RETRY_DELAY_MS = 30_000L
    }
}
