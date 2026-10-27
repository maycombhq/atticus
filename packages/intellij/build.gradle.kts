import org.jetbrains.intellij.platform.gradle.IntelliJPlatformType
import org.jetbrains.kotlin.gradle.dsl.JvmDefaultMode
import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.tasks.KotlinJvmCompile

plugins {
    id("org.jetbrains.kotlin.jvm") version "2.3.20"
    id("org.jetbrains.intellij.platform") version "2.19.0"
}

group = "com.maycombhq"
version = "0.2.0"

// The IntelliJ IDEA on this machine, so nothing big is downloaded (ADR 0099). Its JetBrains
// Runtime (Java 25 for 2026.x) compiles the plugin and runs the tests.
val ideaPath = providers.gradleProperty("atticus.ideaPath").orNull?.takeIf { it.isNotBlank() }
val localIdea = ideaPath?.let { file(it) }?.takeIf { it.resolve("product-info.json").isFile }
val localJbr = localIdea?.resolve("jbr")?.takeIf { it.resolve("release").isFile }
// The IDEs `verifyPlugin` checks against when no local IDE is set: -Patticus.verifyIdes=2025.3.6,2026.2.3
// (IntelliJ IDEA versions). Left out, the Marketplace's recommended set (four IDEs, several GB).
val verifyIdes = providers.gradleProperty("atticus.verifyIdes").orNull?.split(',')?.map { it.trim() }?.filter { it.isNotEmpty() }.orEmpty()
val javaExe = if (System.getProperty("os.name").startsWith("Windows")) "java.exe" else "java"

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        // IntelliJ IDEA Community isn't published on its own from 2025.3: the one IntelliJ IDEA
        // distribution (free without a licence) is what the build downloads.
        if (localIdea != null) local(localIdea.path) else intellijIdea("2025.3.6")
        // The embedded browser is its own plugin from 2026.2 (the alias exists from 2025.3.1).
        bundledPlugin("com.intellij.modules.jcef")
        // `./gradlew verifyPlugin` checks the plugin's API use against the IDE (a small download).
        pluginVerifier()
    }
    testImplementation(platform("org.junit:junit-bom:5.13.4"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
    // The IntelliJ Platform's test runtime, which the Gradle plugin puts on the test classpath,
    // loads JUnit 4 classes (org.junit.rules.TestRule) even when every test is JUnit 5.
    testRuntimeOnly("junit:junit:4.13.2")
}

// Java 21 class files: they load in IntelliJ 2025.3.1 (Java 21) and in 2026.x (Java 25).
kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_21)
        // Inherit the platform interfaces' default methods instead of overriding them with
        // bridges: the bridges are what the Plugin Verifier listed as deprecated and experimental
        // API use (ToolWindowFactory.isApplicable, manage, getIcon; StatusBarWidget.getPresentation).
        jvmDefault.set(JvmDefaultMode.NO_COMPATIBILITY)
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
        // The plugin depends on nothing from the Marketplace, so the verifier needs none of its
        // plugins: without -offline it downloads 1 GB or more of them into ~/.pluginVerifier.
        freeArgs = listOf("-offline")
        ides {
            when {
                localIdea != null -> local(localIdea)
                verifyIdes.isNotEmpty() -> verifyIdes.forEach { create(IntelliJPlatformType.IntellijIdea, it) }
                else -> recommended()
            }
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

// `./gradlew runIde -Patticus.openProject=<metarepo>` opens that folder in the sandbox IDE.
val openProject = providers.gradleProperty("atticus.openProject").orNull?.takeIf { it.isNotBlank() }

// Plain lists, not the script's own values, so the configuration cache can keep the tasks.
val openProjectArgs: List<String> = listOfNotNull(openProject)

tasks.runIde {
    argumentProviders += CommandLineArgumentProvider { openProjectArgs }
}

val robotJvmArgs: List<String> =
    listOf(
        "-Drobot-server.port=8082",
        "-Dide.mac.message.dialogs.as.sheets=false",
        "-Djb.privacy.policy.text=<!--999.999-->",
        "-Djb.consents.confirmation.enabled=false",
        "-Didea.trust.all.projects=true",
        "-Dide.show.tips.on.startup.default.value=false",
    )

// `./gradlew runIdeForUiTests`: the IDE with the Remote Robot server on 127.0.0.1:8082, for a smoke
// test of the tool window and the actions (http://127.0.0.1:8082/hierarchy shows the UI's tree).
intellijPlatformTesting {
    runIde {
        register("runIdeForUiTests") {
            task {
                jvmArgumentProviders += CommandLineArgumentProvider { robotJvmArgs }
                argumentProviders += CommandLineArgumentProvider { openProjectArgs }
            }
            plugins {
                robotServerPlugin()
            }
        }
    }
}
