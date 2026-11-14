import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
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
        versionCode = 1
        versionName = "1.0.0"
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
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20250107")
    testImplementation("org.robolectric:robolectric:4.18")
}
