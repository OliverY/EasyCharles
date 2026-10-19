plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "io.easycharles"
    compileSdk = 34

    defaultConfig {
        minSdk = 21
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // 宿主 App 通常已依赖 OkHttp，这里用 compileOnly 避免版本冲突，
    // 同时保证 release 构建不引入任何额外代码（见 README 的接入方式）
    // 用较低的 4.10.0 编译：API 面更保守，宿主解析到 4.10 ~ 4.12 都能正常链接
    compileOnly("com.squareup.okhttp3:okhttp:4.10.0")
}
