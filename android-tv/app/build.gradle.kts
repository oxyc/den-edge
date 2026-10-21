import java.net.URI

plugins {
    id("com.android.application")
}

val denVersion = rootProject.file("VERSION").readText().trim()
val versionParts = denVersion.split('.').map(String::toInt)
require(versionParts.size == 3 && versionParts.all { it in 0..999 }) {
    "VERSION must contain three numeric components between 0 and 999"
}
val denVersionCode = versionParts[0] * 1_000_000 + versionParts[1] * 1_000 + versionParts[2]
val denTvUrl = providers.gradleProperty("denTvUrl").orElse("https://den-tv.oxy.fi/").get()
val parsedTvUrl = URI(denTvUrl)
require(
    parsedTvUrl.scheme == "https" &&
        parsedTvUrl.host != null &&
        parsedTvUrl.rawUserInfo == null &&
        parsedTvUrl.rawFragment == null
) { "denTvUrl must be a public HTTPS URL without credentials or a fragment" }

val keystoreFile = providers.environmentVariable("DEN_ANDROID_KEYSTORE_FILE")
val keystorePassword = providers.environmentVariable("DEN_ANDROID_STORE_PASSWORD")
val keyAliasName = providers.environmentVariable("DEN_ANDROID_KEY_ALIAS")
val keyPasswordValue = providers.environmentVariable("DEN_ANDROID_KEY_PASSWORD")
val hasReleaseSigning = listOf(
    keystoreFile,
    keystorePassword,
    keyAliasName,
    keyPasswordValue,
).all { it.isPresent }

android {
    namespace = "com.den.edge.tv"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.den.edge.tv"
        minSdk = 23
        targetSdk = 36
        versionCode = denVersionCode
        versionName = denVersion
        buildConfigField("String", "DEN_TV_URL", "\"${denTvUrl.replace("\\", "\\\\").replace("\"", "\\\"")}\"")
    }

    if (hasReleaseSigning) {
        signingConfigs {
            create("release") {
                storeFile = file(keystoreFile.get())
                storePassword = keystorePassword.get()
                keyAlias = keyAliasName.get()
                keyPassword = keyPasswordValue.get()
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (hasReleaseSigning) signingConfig = signingConfigs.getByName("release")
        }
    }

    buildFeatures {
        buildConfig = true
    }

    lint {
        abortOnError = true
        checkReleaseBuilds = true
        warningsAsErrors = true
        // API 36 is the current stable SDK and exceeds Google Play's Android TV requirement. Lint also advertises
        // preview SDKs and newer build tools; those do not define this shell's compatibility floor.
        disable += setOf("OldTargetApi", "GradleDependency", "AndroidGradlePluginVersion")
    }
}

dependencies {
    implementation("androidx.activity:activity:1.13.0")
    testImplementation("junit:junit:4.13.2")
}

dependencyLocking {
    lockAllConfigurations()
}
