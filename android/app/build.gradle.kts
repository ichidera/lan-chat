plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.lanchat"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.lanchat"
        minSdk = 26 // Android 8+: needed for reliable NSD/multicast + java.security x25519 helpers
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
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
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.recyclerview:recyclerview:1.3.2")
    implementation("androidx.room:room-runtime:2.6.1")
    implementation("androidx.room:room-ktx:2.6.1")
    kapt("androidx.room:room-compiler:2.6.1")

    // Google Tink gives us audited X25519 + ChaCha20-Poly1305 primitives that
    // match exactly what the desktop client does with Node's built-in crypto —
    // same algorithms, same wire format, two implementations.
    implementation("com.google.crypto.tink:tink-android:1.14.1")

    testImplementation("junit:junit:4.13.2")
}
