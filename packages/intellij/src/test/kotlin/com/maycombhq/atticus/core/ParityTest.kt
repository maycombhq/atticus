package com.maycombhq.atticus.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import java.nio.file.Files
import java.nio.file.Path

/**
 * WP6.3: every VS Code command has its place in IntelliJ: an action, Run a Command, a screen of the
 * app or a tab, or a reason it is VS Code only. Read from the VS Code extension's package.json,
 * the plugin's plugin.xml and the app's screens, so a new command anywhere fails here first.
 */
class ParityTest {
    private val packages = Path.of("").toAbsolutePath().parent
    private fun read(rel: String) = Files.readString(packages.resolve(rel))

    private val vscodeCommands =
        Regex(""""command":\s*"(atticus\.[A-Za-z]+)",\s*"title"""").findAll(read("vscode/package.json")).map { it.groupValues[1] }.toSet()
    private val actions = Regex("""<action id="([^"]+)"""").findAll(read("intellij/src/main/resources/META-INF/plugin.xml")).map { it.groupValues[1] }.toSet()
    // A screen on one line or, as Prettier writes a longer one, over several (Home).
    private val screens = Regex("""\{\s*id: "([a-z-]+)",\s*label:""").findAll(read("ui/src/app/screens.ts")).map { it.groupValues[1] }.toSet()

    @Test
    fun `every VS Code command has its place in IntelliJ`() {
        assertEquals(true, vscodeCommands.size > 50, "read the VS Code commands")
        assertEquals(emptyList<String>(), vscodeCommands.filter { it !in Parity.MAP }.sorted(), "VS Code commands IntelliJ doesn't place")
        assertEquals(emptyList<String>(), Parity.MAP.keys.filter { it !in vscodeCommands }.sorted(), "placed, but not a VS Code command any more")
    }

    @Test
    fun `every action and screen it names exists`() {
        val missingActions = Parity.MAP.values.filterIsInstance<InIntelliJ.Action>().map { it.id }.filter { it !in actions }.distinct()
        assertEquals(emptyList<String>(), missingActions, "actions not in plugin.xml")
        val missingScreens = Parity.MAP.values.filterIsInstance<InIntelliJ.App>().map { it.hash.removePrefix("#/").substringBefore('?') }.filter { it !in screens }.distinct()
        assertEquals(emptyList<String>(), missingScreens, "screens not in the app")
        val tabs = setOf(Copy.APP_TAB, Copy.WAITING_TAB, Copy.OUTPUT_TAB)
        assertEquals(emptyList<String>(), Parity.MAP.values.filterIsInstance<InIntelliJ.Tab>().map { it.name }.filter { it !in tabs })
    }
}
