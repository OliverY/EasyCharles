package io.easycharles

import okhttp3.HttpUrl
import okhttp3.Interceptor
import okhttp3.MediaType
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.Response
import okio.Buffer
import java.io.IOException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.UnknownHostException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/**
 * 数据面拦截器：把请求改写发往本地服务，本地服务再转发到真实服务器。
 *
 * 接入顺序很重要：**必须比业务的加解密拦截器先 addInterceptor**（也就是更外层）。
 * 这样请求方向抓到的是加密前的明文，响应方向抓到的是解密后的明文。
 *
 * ```kotlin
 * OkHttpClient.Builder()
 *     .addInterceptor(EasyCharlesInterceptor())   // ← 放在最外层
 *     .addInterceptor(yourCryptoInterceptor)
 *     .build()
 * ```
 */
class EasyCharlesInterceptor : Interceptor {

    private val seq = AtomicLong(0)

    @Suppress("DEPRECATION")
    override fun intercept(chain: Interceptor.Chain): Response {
        val cfg = EasyCharles.configOrNull() ?: return chain.proceed(chain.request())
        if (!EasyCharles.shouldIntercept()) return chain.proceed(chain.request())

        val original = chain.request()

        // 防止自环：请求已经指向本地服务就直接放行
        val proxy = runCatching { HttpUrl.parse(cfg.baseUrl) }.getOrNull()
        if (proxy != null && original.url.host == proxy.host && original.url.port == proxy.port) {
            return chain.proceed(original)
        }

        // body 只能写一次，先缓冲成 ByteArray，后面所有回放都基于它
        val snapshot = snapshot(original)
            ?: return chain.proceed(original)

        // F-12：重定向在拦截器内手动跟随（OkHttp 自动跟随发生在拦截器层之下，无法带 X-EC-Target）。
        // 每跳重新走代理并共享 X-EC-Seq（协议 §3.6），非首跳附加 X-EC-Redirect: 1 供服务端标记。
        val chainForProxy = if (cfg.proxyTimeoutMs > 0) {
            chain
                .withConnectTimeout(cfg.proxyTimeoutMs, TimeUnit.MILLISECONDS)
                .withReadTimeout(cfg.proxyTimeoutMs, TimeUnit.MILLISECONDS)
                .withWriteTimeout(cfg.proxyTimeoutMs, TimeUnit.MILLISECONDS)
        } else chain
        val hopSeq = seq.incrementAndGet().toString()

        var current = original
        var hop = 0
        while (true) {
            val response = try {
                chainForProxy.proceed(buildProxyRequest(current, snapshot, cfg, hopSeq, hop > 0))
            } catch (e: IOException) {
                // F-11：只有连接建立类失败才算代理不可达；超时可能已到达代理并转发，绝不重放（ADR-005/013）
                if (isProxyUnreachable(e) && EasyCharles.notifyFailure(cfg)) {
                    EasyCharles.log("proxy unreachable (${e.javaClass.simpleName}), fail-open")
                    return chain.proceed(replay(current, snapshot))
                }
                throw e
            }

            // 本地服务明确拒绝（协议不匹配 / 缺头 / token 无效）才回退，
            // 上游 502 / 504 属于真实业务失败，绝不重试，避免重复提交
            val ecError = response.header("X-EC-Error")
            if (ecError != null && ecError in FAIL_OPEN_ERRORS) {
                EasyCharles.log("proxy rejected with $ecError, fail-open")
                response.close()
                EasyCharles.notifyFailure(cfg)
                return chain.proceed(replay(current, snapshot))
            }

            EasyCharles.notifySuccess()

            // F-12：3xx + Location → 基于【原始 URL】resolve 新目标，继续走代理；超 10 跳返回最后一次响应
            val location = response.header("Location")
            if (response.code in 300..399 && !location.isNullOrBlank() && hop < MAX_REDIRECTS) {
                val next = current.url.resolve(location)
                if (next != null) {
                    response.close()
                    current = when (response.code) {
                        // 301/302/303 通常转 GET 并丢弃 body
                        301, 302, 303 -> original.newBuilder().url(next).method("GET", null).build()
                        // 307/308 保持 method 与 body（body 由 snapshot 重放）
                        else -> original.newBuilder().url(next).build()
                    }
                    hop++
                    continue
                }
            }
            return response
        }
    }

    @Suppress("DEPRECATION")
    private fun buildProxyRequest(
        current: Request,
        snapshot: BodySnapshot,
        cfg: EasyCharles.Config,
        seqValue: String,
        redirectHop: Boolean,
    ): Request {
        val base = cfg.baseUrl.trimEnd('/')
        val query = current.url.query?.takeIf { it.isNotEmpty() }?.let { "?$it" } ?: ""
        val proxyUrl = "$base/__ec/p${current.url.encodedPath()}$query"

        val builder = current.newBuilder()
            .url(proxyUrl)
            .addHeader("X-EC-Target", current.url.toString())
            .addHeader("X-EC-Seq", seqValue)

        if (redirectHop) builder.addHeader("X-EC-Redirect", "1")

        // F-14：LAN 模式注入 token（回环模式为空则不发送）
        cfg.token?.takeIf { it.isNotBlank() }?.let { builder.addHeader("X-EC-Token", it) }

        EasyCharles.identityOrNull()?.let { id ->
            builder.addHeader("X-EC-Device-Id", id.deviceId)
            builder.addHeader("X-EC-Session-Id", id.sessionId)
            builder.addHeader("X-EC-App-Id", id.appId)
        }

        // 显式重设 method + body（用 snapshot 副本），避免引用已消费的一次性 body
        if (snapshot.bytes != null && current.method != "GET" && current.method != "HEAD") {
            builder.method(current.method, RequestBody.create(snapshot.contentType, snapshot.bytes))
        } else {
            builder.method(current.method, null)
        }
        return builder.build()
    }

    /** 用缓冲下来的 bytes 重建一个等价请求，用于 fail-open 回放（绝不引用已消费的 one-shot body） */
    @Suppress("DEPRECATION")
    private fun replay(current: Request, snapshot: BodySnapshot): Request {
        val builder = current.newBuilder()
        if (snapshot.bytes != null && current.method != "GET" && current.method != "HEAD") {
            builder.method(current.method, RequestBody.create(snapshot.contentType, snapshot.bytes))
        } else {
            builder.method(current.method, null)
        }
        return builder.build()
    }

    private class BodySnapshot(val contentType: MediaType?, val bytes: ByteArray?)

    private fun snapshot(request: Request): BodySnapshot? {
        val body = request.body ?: return BodySnapshot(null, null)
        return try {
            val buffer = Buffer()
            body.writeTo(buffer)
            BodySnapshot(body.contentType(), buffer.readByteArray())
        } catch (t: Throwable) {
            EasyCharles.log("body snapshot failed, skip this request: ${t.message}")
            null
        }
    }

    private fun isProxyUnreachable(e: Throwable): Boolean {
        var t: Throwable? = e
        var depth = 0
        while (t != null && depth < 4) {
            if (t is ConnectException ||
                t is UnknownHostException ||
                t is NoRouteToHostException
            ) return true
            t = t.cause
            depth++
        }
        return false
    }

    private companion object {
        /** F-12：重定向链最大跳数（协议 §3.6） */
        const val MAX_REDIRECTS = 10
        val FAIL_OPEN_ERRORS = setOf(
            "EC_TARGET_MISSING",
            "EC_BAD_TARGET",
            "EC_PROTOCOL_MISMATCH",
            "EC_UNAUTHORIZED",
        )
    }
}
