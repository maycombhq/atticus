import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.tasks.KotlinJvmCompile

plugins {
    id("org.jetbrains.kotlin.jvm") version "2.3.20"
    id("org.jetbrains.intellij.platform") version "2.19.0"
}

group = "com.maycombhq"
version = "0.1.0"

// The IntelliJ IDEA on this machine, so nothing big is downloaded (ADR 0099). Its JetBrains
// Runtime (Java 25 for 2026.x) compiles the plugin and runs the tests.
val ideaPath = providers.gradleProperty("atticus.ideaPath").orNull?.takeIf { it.isNotBlank() }
val localIdea = ideaPath?.let { file(it) }?.takeIf { it.resolve("product-info.json").isFile }
val localJbr = localIdea?.resolve("jbr")?.takeIf { it.resolve("release").isFile }
val javaExe = if (System.getProperty("os.name").startsWith("Windows")) "java.exe" else "java"

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        if (localIdea != null) local(localIdea.path) else intellijIdeaCommunity("2025.3.6")
        // The embedded browser is its own plugin from 2026.2 (the alias exists from 2025.3.1).
        bundledPlugin("com.intellij.modules.jcef")
        // `./gradlew verifyPlugin` checks the plugin's API use against the IDE (a small download).
        pluginVerifier()
    }
    testImplementation(platform("org.junit:junit-bom:5.13.4"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

// Java 21 class files: they load in IntelliJ 2025.3.1 (Java 21) and in 2026.x (Java 25).
kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_21)
    }
    if (localJbr == null) jvmToolchain(21)
}

java {
    sourceCompatibility = JavaVersion.VERSION_21
    targetCompatibility = JavaVersion.VERSION_21
}

if (localJbr != null) {
    tasks.withType<KotlinJvmCompile>().configureEach {
        kotlinJavaToolchain.jdk.use(localJbr, JavaVersion.VERSION_25)
        compilerOptions.jvmTarget.set(JvmTarget.JVM_21)
    }
    tasks.withType<JavaCompile>().configureEach {
        options.isFork = true
        options.forkOptions.javaHome = localJbr
    }
    tasks.withType<Test>().configureEach {
        executable = localJbr.resolve("bin").resolve(javaExe).path
    }
}

intellijPlatform {
    // The settings page has no searchable options worth building an IDE run for.
    buildSearchableOptions = false
    instrumentCode = false
    pluginVerification {
        ides {
            if (localIdea != null) local(localIdea) else recommended()
        }
    }
    pluginConfiguration {
        id = "com.maycombhq.atticus"
        name = "Atticus"
        version = project.version.toString()
        ideaVersion {
            sinceBuild = "253.29346"
            untilBuild = provider { null }
        }
    }
}

tasks.test {
    useJUnitPlatform()
}
