import org.jetbrains.intellij.platform.gradle.IntelliJPlatformType
import org.jetbrains.kotlin.gradle.dsl.JvmDefaultMode
import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.tasks.KotlinJvmCompile

plugins {
    id("org.jetbrains.kotlin.jvm") version "2.3.20"
    id("org.jetbrains.intellij.platform") version "2.19.0"
}

group = "com.maycombhq"
version = "0.5.0"

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
        // What changed in this version, shown on the plugin's page in the IDE and the Marketplace.
        changeNotes =
            """
            <h3>0.5.0 (with Atticus 2.0.0-beta.21)</h3>
            <ul>
              <li><b>Says when the installed atticus is too old.</b> The plugin needs Atticus 2.0.0-beta.21 or newer; an older one is named once in a notification, with how to update, and the app still starts.</li>
              <li><b>Open in your editor opens here.</b> A cited line's link in the App tab opens the file at that line in this IDE (a VS Code link goes to the system).</li>
              <li><b>The canvas's exports save.</b> Mermaid, draw.io, SVG and PNG exports from the App tab ask where to save with the system's Save dialog, under the name the app gave.</li>
              <li>The App tab hosts the beta.21 app as it is: drawing a change on the canvas (Sketch), Match for links, and the organisation's own component types, each with its notes.</li>
            </ul>
            <h3>0.4.0 (with Atticus 2.0.0-beta.11)</h3>
            <ul>
              <li><b>Another repo… names any repo, system or team.</b> On a target question, Another repo… (and a topic question's A topic owned by another team or vendor) opens a picker of every repo of the manifest, read or not, every system of the profiles and every team in roles.yaml, and answers with <code>atticus questions answer &lt;id&gt; --target &lt;id&gt;</code>. A team with no system, or a name the list doesn't have, is offered as a new system, the command shown, and added to the profile (<code>--add-system vendor</code> or <code>internal</code>) only after your yes.</li>
              <li><b>Contract Mismatches</b> (<code>atticus join contracts</code>): the counts said, the whole check a click away, and Map › Mismatches in the App tab. The status bar counts the mismatches beside the questions.</li>
              <li><b>A Repo Type's Notes</b>, <b>Add a Note to a Repo Type</b>, <b>Draft Checklist Rules from the Notes</b> and <b>Save the Notes' Rule Drafts</b> (<code>atticus repo-type note</code> and <code>rules --save</code>): each write runs only after your yes, with the command shown. Nothing is committed or pushed.</li>
              <li><b>How Far the Map Has Got</b> (<code>atticus doctor --counts</code>) in a panel with Copy: counts and flags only, safe to paste.</li>
              <li>Esc in the App tab goes to the app (it leaves the diagram viewer's full screen, or clears Find a box) instead of moving focus to the editor; Shift+Esc still hides the tool window. F and / reach the app as they are.</li>
            </ul>
            """.trimIndent()
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
