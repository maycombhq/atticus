package com.maycombhq.atticus.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path

/** The metarepo, its repos and changes, and the app's address (ADR 0099). */
class MetarepoTest {
    @TempDir
    lateinit var dir: Path

    @Test
    fun `a folder is a metarepo when it has org-pack or atticus org-pack`() {
        assertNull(Metarepo.orgPack(dir))
        Files.createDirectories(dir.resolve(".atticus/org-pack"))
        assertEquals(dir.resolve(".atticus/org-pack"), Metarepo.orgPack(dir))
        Files.createDirectories(dir.resolve("org-pack"))
        assertEquals(dir.resolve("org-pack"), Metarepo.orgPack(dir))
    }

    @Test
    fun `the repos in every profile's manifest, in order, once each`() {
        val pack = dir.resolve("org-pack")
        Files.createDirectories(pack.resolve("profiles/forge"))
        Files.createDirectories(pack.resolve("profiles/ledger"))
        Files.writeString(
            pack.resolve("profiles/forge/repos.manifest.yaml"),
            """
            schemaVersion: 1
            platform: forge
            repos:
              # the web app
              - id: forge-web
                url: https://git.example.test/forge/forge-web
                modules:
                  - path: api
                    component: forge-api
              - id: "forge-notes"
                type: node
            """.trimIndent(),
        )
        Files.writeString(pack.resolve("profiles/ledger/repos.manifest.yaml"), "repos:\n  - id: ledger-core\n  - id: forge-web\n")
        assertEquals(listOf("forge-web", "forge-notes", "ledger-core"), Metarepo.repos(pack))
        assertEquals(emptyList<String>(), Metarepo.repos(dir.resolve("missing")))
    }

    @Test
    fun `the changes from atticus change list --json`() {
        val json = """[{"id": "add-note-tags", "title": "Add tags to notes", "type": "feature", "state": "define"}]"""
        assertEquals(listOf(Change("add-note-tags", "Add tags to notes", "define")), Metarepo.changes(json))
        assertEquals(emptyList<Change>(), Metarepo.changes("No changes yet."))
    }

    @Test
    fun `the open questions from atticus questions list --json`() {
        val json = """{"questions": [{"id": "q-1", "repo": "forge-web", "question": "Is /admin an endpoint?", "options": [], "evidence": []}]}"""
        assertEquals(listOf(Question("q-1", "forge-web", "Is /admin an endpoint?")), Metarepo.questions(json))
        assertEquals(emptyList<Question>(), Metarepo.questions("{}"))
    }

    @Test
    fun `the platforms are the org pack's profiles`() {
        Files.createDirectories(dir.resolve("org-pack/profiles/forge"))
        Files.createDirectories(dir.resolve("org-pack/profiles/ledger"))
        assertEquals(listOf("forge", "ledger"), Metarepo.platforms(dir.resolve("org-pack")))
    }

    @Test
    fun `the address atticus ui prints when it is ready`() {
        val out = "Atticus is running at http://127.0.0.1:56088 (Ctrl+C stops it).\nFor assistants and scripts, the session token is abc\n"
        assertEquals("http://127.0.0.1:56088", Metarepo.appUrl(out))
        assertNull(Metarepo.appUrl("Starting…"))
        // Only this machine: an address elsewhere is not shown.
        assertNull(Metarepo.appUrl("Atticus is running at http://10.0.0.5:8080"))
    }

    @Test
    fun `an app screen's address, from the address the app printed`() {
        assertEquals("http://127.0.0.1:5123/#/home", Metarepo.screenUrl("http://127.0.0.1:5123", "#/home"))
        assertEquals("http://127.0.0.1:5123/#/runs?run=run-1-0001", Metarepo.screenUrl("http://127.0.0.1:5123/", "#/runs?run=run-1-0001"))
        // ADR 0110: the Prompt history screen, from Atticus: Prompt History.
        assertEquals("http://127.0.0.1:5123/#/history", Metarepo.screenUrl("http://127.0.0.1:5123", Metarepo.PROMPT_HISTORY_SCREEN))
        assertEquals("http://127.0.0.1:5123", Metarepo.screenUrl("http://127.0.0.1:5123", null))
        // Only a screen of the app: anything else opens the app as it is.
        assertEquals("http://127.0.0.1:5123", Metarepo.screenUrl("http://127.0.0.1:5123", "javascript:alert(1)"))
    }

    @Test
    fun `the App tab's address marks the panel as IntelliJ's, before the screen`() {
        // ADR 0194: the app leaves out its title, activity and status bars in an editor's panel.
        assertEquals("http://127.0.0.1:5123/?host=intellij#/home", Metarepo.panelUrl("http://127.0.0.1:5123", "#/home"))
        assertEquals("http://127.0.0.1:5123/?host=intellij#/runs?run=run-1-0001", Metarepo.panelUrl("http://127.0.0.1:5123/", "#/runs?run=run-1-0001"))
        assertEquals("http://127.0.0.1:5123/?host=intellij", Metarepo.panelUrl("http://127.0.0.1:5123", null))
        assertEquals("http://127.0.0.1:5123/?host=intellij", Metarepo.panelUrl("http://127.0.0.1:5123", "javascript:alert(1)"))
    }

    @Test
    fun `a practice sandbox's metarepo is the folder it names, not the sandbox folder`() {
        val dir = dir.resolve("atticus-practice.2").toString()
        val printed =
            """
            Made a practice sandbox in $dir: 7 Forge repos and the seeded change add-transfer-limit.
            Its metarepo is ${Path.of(dir, "metarepo")}. Run commands there (or add --root), starting with atticus learn.
            """.trimIndent()
        assertEquals(Path.of(dir, "metarepo").toString(), Metarepo.sandboxMetarepo(printed, dir))
        // When the line isn't there (an older command line), its metarepo/ folder.
        assertEquals(Path.of(dir, "metarepo").toString(), Metarepo.sandboxMetarepo("Made a practice sandbox.", dir))
    }

    @Test
    fun `the layout from sources yaml, and the defaults`() {
        Files.createDirectories(dir.resolve("org-pack"))
        assertEquals(Metarepo.Layout("openspec", "catalog"), Metarepo.layout(dir))
        Files.writeString(
            dir.resolve("org-pack/sources.yaml"),
            "schemaVersion: 3\nlayout:\n  openspec: docs/openspec   # ours\n  catalog: \"arch/catalog\"\nwikis: []\n",
        )
        assertEquals(Metarepo.Layout("docs/openspec", "arch/catalog"), Metarepo.layout(dir))
    }

    @Test
    fun `a file in ANSI from an older Notepad is read, not thrown`() {
        val f = dir.resolve("tasks.md")
        Files.write(f, byteArrayOf('C'.code.toByte(), 'a'.code.toByte(), 'f'.code.toByte(), 0xE9.toByte()))
        assertEquals(listOf("Caf\u00e9"), Metarepo.readLines(f))
        assertEquals(emptyList<String>(), Metarepo.readLines(dir.resolve("missing.md")))
    }
}
