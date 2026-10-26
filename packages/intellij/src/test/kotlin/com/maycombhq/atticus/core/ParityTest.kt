package com.maycombhq.atticus.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.nio.file.Files
import java.nio.file.Path

/**
 * WP6.3 and ADR 0105 addendum 2: every VS Code command has its place in IntelliJ: an action, a
 * screen of the app, a tab, a part of a dialog, Run a Command where running a command is the job,
 * or a reason it is VS Code only. Read from the VS Code extension's package.json, the plugin's
 * plugin.xml and the app's screens, so a new command anywhere fails here first.
 */
class ParityTest {
    private val packages = Path.of("").toAbsolutePath().parent
    private fun read(rel: String) = Files.readString(packages.resolve(rel))

    private val vscodeCommands =
        Regex(""""command":\s*"(atticus\.[A-Za-z]+)",\s*"title"""").findAll(read("vscode/package.json")).map { it.groupValues[1] }.toSet()
    private val pluginXml = read("intellij/src/main/resources/META-INF/plugin.xml")
    private val actions = Regex("""<action id="([^"]+)"""").findAll(pluginXml).map { it.groupValues[1] }.toSet()
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
        assertEquals(emptyList<String>(), Parity.MAP.values.filterIsInstance<InIntelliJ.Tab>().map { it.name }.filter { it !in Tabs.NAMES })
    }

    /**
     * ADR 0105 addendum 2: Run a Command is left only where running a command is genuinely the
     * job. The budget and the two entries are recorded in the ADR, so growing the count fails here.
     */
    @Test
    fun `Run a Command is left only where the ADR says`() {
        assertEquals(Parity.RUN_COMMAND_BUDGET, Parity.RUN_COMMANDS.size, "Run a Command entries, against ADR 0105 addendum 2")
        assertEquals(listOf("atticus.changeCommand", "atticus.repoCommand"), Parity.RUN_COMMANDS.sorted())
    }

    /** Every action a step of Steps names is declared, and no step names an action twice over. */
    @Test
    fun `every native step has its own action in plugin xml`() {
        assertEquals(emptyList<String>(), Steps.ACTION_IDS.filter { it !in actions }, "step actions not in plugin.xml")
        // Two VS Code commands may share one action (the spec draft is in the palette and on a row),
        // but one action never does two different jobs.
        for ((id, steps) in Steps.ALL.groupBy { it.actionId }) {
            assertEquals(1, steps.map { it.words to it.ai }.distinct().size, "$id runs more than one command")
        }
    }

    /** Every VS Code command the plugin places, said in words the ADR's table can be read from. */
    @Test
    fun `the counts add up to every VS Code command`() {
        val c = Parity.counts()
        assertEquals(Parity.MAP.size, c.values.sum(), "every command counted once")
        assertEquals(vscodeCommands.size, Parity.MAP.size)
        assertTrue(c.getValue("action") > 70, "most commands are native: ${c.getValue("action")}")
        assertEquals(2, c.getValue("vsCodeOnly"))
    }

    /** A VS Code-only entry always says why, so a gap is never left unsaid. */
    @Test
    fun `every VS Code only entry says why`() {
        for (v in Parity.MAP.values.filterIsInstance<InIntelliJ.VsCodeOnly>()) assertTrue(v.why.length > 20, v.why)
    }
}
