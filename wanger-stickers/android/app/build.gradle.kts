import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// Release signing comes from android/keystore.properties (never committed) or the same four
// values in environment variables; without them assembleRelease builds an unsigned APK.
val signing = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
    for (k in listOf("storeFile", "storePassword", "keyAlias", "keyPassword")) {
        System.getenv("WANGER_APK_" + k.uppercase())?.let { setProperty(k, it) }
    }
}
val hasSigning = listOf("storeFile", "storePassword", "keyAlias", "keyPassword").all { !signing.getProperty(it).isNullOrBlank() }

android {
    namespace = "com.wanger.stickers"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.wanger.stickers"
        minSdk = 23
        targetSdk = 36
        versionCode = 2
        versionName = "1.1.0"
    }

    signingConfigs {
        if (hasSigning) {
            create("release") {
                storeFile = rootProject.file(signing.getProperty("storeFile"))
                storePassword = signing.getProperty("storePassword")
                keyAlias = signing.getProperty("keyAlias")
                keyPassword = signing.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (hasSigning) signingConfig = signingConfigs.getByName("release")
        }
    }

    buildFeatures {
        compose = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    testOptions {
        unitTests.isIncludeAndroidResources = true
        // Robolectric downloads Android jars from Maven Central; `-ProbolectricRepo=<url>` points it
        // at a mirror where Maven Central is rate-limited.
        unitTests.all { t ->
            (project.findProperty("robolectricRepo") as String?)?.let { t.systemProperty("robolectric.dependency.repo.url", it) }
        }
    }

    lint {
        abortOnError = true
        warningsAsErrors = false
    }

    dependenciesInfo {
        // no Google-encrypted dependency blob in the APK (F-Droid / direct installs)
        includeInApk = false
        includeInBundle = false
    }
}

kotlin {
    compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
}

dependencies {
    // Jetpack Compose + Material 3 (BOM 2026.06.01: the newest that builds with compileSdk 36 / AGP 8.13)
    val compose = platform("androidx.compose:compose-bom:2026.06.01")
    implementation(compose)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-core")
    implementation("androidx.activity:activity-compose:1.13.0")

    testImplementation(compose)
    testImplementation("androidx.compose.ui:ui-test-junit4")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
    testImplementation("androidx.test:core:1.7.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20250107")
    testImplementation("org.robolectric:robolectric:4.18")
}
