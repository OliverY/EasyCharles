package io.easycharles

import android.app.Application
import android.content.Context
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import java.util.UUID

/**
 * EasyCharles 入口。
 *
 * release 安全：非 debuggable 进程里所有能力自动 no-op，
 * 即便代码被打进包也不会产生任何网络行为。
 */
object EasyCharles {

    const val SDK_VERSION = "0.1.0"
    internal const val PROTOCOL_VERSION = 2
    private const val TAG = "EasyCharles"

    data class Config(
        /** 本地服务地址。模拟器用 http://10.0.2.2:8899，真机 USB 用 http://127.0.0.1:8899 */
        val baseUrl: String = "http://127.0.0.1:8899",
        /** 局域网模式 token（ADR-007）：服务端 --lan 启动时生成，从这里注入；回环模式留空 */
        val token: String? = null,
        val enabled: Boolean = true,
        /** 连不上本地服务时直连真实服务器。生产环境必须保持 true */
        val failOpen: Boolean = true,
        /** userName 属个人信息，默认不上报 */
        val reportUserName: Boolean = false,
        val env: String = "test",
        /** 连续多少次【连接类】失败后熔断，不再尝试本地服务（超时不计数，ADR-005/013） */
        val consecutiveFailLimit: Int = 3,
        /** 熔断冷却时长（ms）：到期放一个请求半开探测，避免用户重启服务后 SDK 仍永久直连 */
        val circuitCooldownMs: Long = 30_000L,
        /** 代理请求超时（ms）。0 = 不额外限制，跟随宿主 client 的业务超时（ADR-013） */
        val proxyTimeoutMs: Long = 0,
        val enableControlPlane: Boolean = true,
    )

    private const val PREFS = "easy_charles"
    private const val KEY_DEVICE_ID = "device_id"

    @Volatile
    private var config: Config? = null

    @Volatile
    private var identity: DeviceIdentity? = null

    @Volatile
    private var debuggable = false

    @Volatile
    private var remotelyDisabled = false

    @Volatile
    private var failStreak = 0

    @Volatile
    private var circuitOpen = false

    @Volatile
    private var circuitOpenedAt = 0L

    /** 协议不匹配等不可恢复原因导致的永久关闭，只能靠重新 init 复位 */
    @Volatile
    private var disabled = false

    private var controlPlane: ControlPlane? = null
    private val sessionId: String = UUID.randomUUID().toString()

    /**
     * 建议在 Application.onCreate 里调用。
     * 非 debuggable 构建会直接返回，后续所有方法都是 no-op。
     */
    @JvmOverloads
    @Synchronized
    fun init(context: Context, config: Config = Config()) {
        val app = context.applicationContext
        debuggable = (app.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        if (!debuggable) {
            log("not a debuggable build, EasyCharles stays disabled")
            return
        }
        // 重复 init（如多进程 / 宿主反复调用）会泄漏上一条控制线的线程与 WS
        controlPlane?.shutdown()
        controlPlane = null
        this.config = config
        this.identity = buildIdentity(app, config)
        this.circuitOpen = false
        this.failStreak = 0
        this.disabled = false
        if (config.enableControlPlane) {
            controlPlane = ControlPlane(config) { identity ?: buildIdentity(app, config) }.also {
                it.start()
                it.startHeartbeat()
            }
        }
        log("ready, baseUrl=${config.baseUrl}")
    }

    /** 业务登录后调用，把 userId / userName 打到控制台设备标签上 */
    @JvmOverloads
    fun setUser(userId: String?, userName: String? = null) {
        val cfg = config ?: return
        val cur = identity ?: return
        identity = cur.copy(
            userId = userId,
            userName = if (cfg.reportUserName) userName else null,
            updatedAt = System.currentTimeMillis(),
        )
        controlPlane?.updateIdentity()
    }

    fun setEnv(env: String) {
        val cur = identity ?: return
        identity = cur.copy(env = env, updatedAt = System.currentTimeMillis())
        controlPlane?.updateIdentity()
    }

    fun setTags(tags: List<String>) {
        val cur = identity ?: return
        identity = cur.copy(tags = tags, updatedAt = System.currentTimeMillis())
        controlPlane?.updateIdentity()
    }

    /** 服务端下发 set_enabled 指令时调用 */
    internal fun setRemoteEnabled(enabled: Boolean) {
        remotelyDisabled = !enabled
        log("remote enabled=$enabled")
    }

    internal fun disable() {
        disabled = true
        log("disabled permanently (protocol mismatch), re-init required")
    }

    internal fun configOrNull(): Config? = config

    internal fun identityOrNull(): DeviceIdentity? = identity

    internal fun shouldIntercept(): Boolean {
        val cfg = config ?: return false
        if (disabled || remotelyDisabled) return false
        if (!circuitOpen) return cfg.enabled
        // 半开探测：熔断后冷却一段时间放一个请求试水，否则用户重启本地服务也永远恢复不了
        if (System.currentTimeMillis() - circuitOpenedAt >= cfg.circuitCooldownMs) {
            circuitOpen = false
            failStreak = 0
            log("circuit half-open, probing local service again")
            return cfg.enabled
        }
        return false
    }

    internal fun notifySuccess() {
        failStreak = 0
        circuitOpen = false
    }

    /** 返回是否应该 fail-open */
    internal fun notifyFailure(cfg: Config): Boolean {
        failStreak++
        if (failStreak >= cfg.consecutiveFailLimit && !circuitOpen) {
            circuitOpen = true
            circuitOpenedAt = System.currentTimeMillis()
            log("circuit open after $failStreak failures, retry in ${cfg.circuitCooldownMs}ms")
        }
        return cfg.failOpen
    }

    internal fun log(msg: String) {
        Log.d(TAG, msg)
    }

    private fun buildIdentity(ctx: Context, cfg: Config): DeviceIdentity {
        val pi = packageInfo(ctx)
        @Suppress("DEPRECATION")
        val versionCode: Long = if (Build.VERSION.SDK_INT >= 28) {
            pi?.longVersionCode ?: 0L
        } else {
            (pi?.versionCode ?: 0).toLong()
        }
        return DeviceIdentity(
            deviceId = getDeviceId(ctx),
            sessionId = sessionId,
            appId = ctx.packageName,
            appVersion = pi?.versionName.orEmpty(),
            appVersionCode = versionCode,
            processName = currentProcessName(),
            env = cfg.env,
        )
    }

    @Suppress("DEPRECATION")
    private fun packageInfo(ctx: Context): android.content.pm.PackageInfo? = runCatching {
        val pm = ctx.packageManager
        if (Build.VERSION.SDK_INT >= 33) {
            pm.getPackageInfo(ctx.packageName, PackageManager.PackageInfoFlags.of(0))
        } else {
            pm.getPackageInfo(ctx.packageName, 0)
        }
    }.getOrNull()

    private fun currentProcessName(): String? = runCatching {
        if (Build.VERSION.SDK_INT >= 28) Application.getProcessName() else null
    }.getOrNull()

    /**
     * 持久设备标识：自建 UUID 存 SharedPreferences。
     * 不用 ANDROID_ID（Android 8+ 按签名变化、重装会变），不用 IMEI（无权限且有合规风险）。
     */
    private fun getDeviceId(ctx: Context): String {
        val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        prefs.getString(KEY_DEVICE_ID, null)?.let { return it }
        val id = UUID.randomUUID().toString()
        prefs.edit().putString(KEY_DEVICE_ID, id).apply()
        return id
    }
}
