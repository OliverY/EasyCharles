package io.easycharles

import android.os.Build
import org.json.JSONObject

/**
 * 设备身份。字段定义见 docs/protocol.md §5.1。
 *
 * 分两类来源：
 *  - SDK 自动采集：os / brand / model / appId / appVersion / processName ...
 *  - 业务注入：env / userId / userName / tags，由 App 调用 [EasyCharles.setUser] 等提供
 */
data class DeviceIdentity(
    // ── 自动采集 ──
    val deviceId: String,
    val sessionId: String,
    val os: String = "Android",
    val osVersion: String = Build.VERSION.RELEASE.orEmpty(),
    val brand: String = Build.BRAND.orEmpty(),
    val manufacturer: String = Build.MANUFACTURER.orEmpty(),
    val model: String = Build.MODEL.orEmpty(),
    val marketName: String? = null,
    val appId: String,
    val appVersion: String,
    val appVersionCode: Long = 0L,
    val sdkVersion: String = EasyCharles.SDK_VERSION,
    val processName: String? = null,
    // ── 业务注入 ──
    val env: String? = null,
    val userId: String? = null,
    val userName: String? = null,
    val tags: List<String>? = null,
    val createdAt: Long = System.currentTimeMillis(),
    val updatedAt: Long = System.currentTimeMillis(),
) {

    fun toJson(): JSONObject = JSONObject().apply {
        put("deviceId", deviceId)
        put("sessionId", sessionId)
        put("os", os)
        put("osVersion", osVersion)
        put("brand", brand)
        put("manufacturer", manufacturer)
        put("model", model)
        putOrNull(this, "marketName", marketName)
        put("appId", appId)
        put("appVersion", appVersion)
        put("appVersionCode", appVersionCode)
        put("sdkVersion", sdkVersion)
        putOrNull(this, "processName", processName)
        putOrNull(this, "env", env)
        putOrNull(this, "userId", userId)
        putOrNull(this, "userName", userName)
        if (tags != null) put("tags", org.json.JSONArray(tags))
        put("createdAt", createdAt)
        put("updatedAt", updatedAt)
    }

    private fun putOrNull(obj: JSONObject, key: String, value: String?) {
        if (value == null) obj.put(key, JSONObject.NULL) else obj.put(key, value)
    }

    /** 生成一个只带变更字段的增量更新体 */
    fun patchJson(): JSONObject = JSONObject().apply {
        put("deviceId", deviceId)
        put("sessionId", sessionId)
        putOrNull(this, "env", env)
        putOrNull(this, "userId", userId)
        putOrNull(this, "userName", userName)
        if (tags != null) put("tags", org.json.JSONArray(tags))
        put("updatedAt", System.currentTimeMillis())
    }
}
