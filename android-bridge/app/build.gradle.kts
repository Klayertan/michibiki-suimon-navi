plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }

android {
    namespace = "jp.suisuinavi.qz1bridge"
    compileSdk = 37
    defaultConfig { applicationId = "jp.suisuinavi.qz1bridge"; minSdk = 26; targetSdk = 37; versionCode = 1; versionName = "1.0" }
}

dependencies { implementation("org.java-websocket:Java-WebSocket:1.5.7") }
