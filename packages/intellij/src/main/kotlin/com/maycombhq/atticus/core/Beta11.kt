package com.maycombhq.atticus.core

import java.nio.file.Files
import java.nio.file.Path

/** One entry of the "Another repo…" picker, as `atticus questions show <id> --json` lists it under `picks`. */
data class TargetPick(
    val id: String,
    /** repo, system or team. */
    val kind: String,
    val name: String,
    val read: Boolean? = null,
    val boundary: String? = null,
    /** A team with no system yet: the system naming it adds to the profile, with `--add-system internal`. */
    val adds: AddsSystem? = null,
)

data class AddsSystem(val id: String, val name: String, val owner: String)

/** What naming a target brings: an answer as it stands, or a new system for the profile, asked first. */
sealed interface TargetPlan {
    val target: String

    data class Answer(override val target: String) : TargetPlan

    data class Offer(override val target: String, val id: String, val name: String, val vendor: Boolean, val owner: String? = null) : TargetPlan
}

/** The contract check's counts over the estate (`atticus join contracts --json`'s `counts`, ADR 0164). */
data class ContractCounts(val links: Int, val compared: Int, val mismatches: Int, val unconfirmed: Int)

/**
 * What beta.11 added to the command line and the app, caught up in the plugin (ADR 0166): the
 * "Another repo…" picker of a target or topics question (ADR 0162), the contract check (ADR
 * 0164), a repo type's notes and their rule drafts (ADR 0163), and the app's viewer keys in the
 * tool window. Tested without the IDE; ide/Beta11Actions.kt asks and shows.
 */
object Beta11 {
    /** The options that open the picker rather than answer (core's PICKER_LABELS in the command line). */
    val PICKER_LABELS = setOf("Another repo…", "A topic owned by another team or vendor")

    const val TOPICS_STEP = "facts-topics"

    /** Whether the option picked (from 1) opens the picker: it names nothing, so it is never the answer. */
    fun opensPicker(q: OpenQuestion, option: Int?): Boolean = option != null && q.options.getOrNull(option - 1)?.label in PICKER_LABELS

    /** `atticus questions show <id> --json`: the question and, for a targets or topics question, its picker. */
    fun showArgv(id: String): List<String> = listOf("questions", "show", id, "--json")

    /** The picker the question carries; null when the command line gave none (before 2.0.0-beta.11). */
    fun picks(json: String): List<TargetPick>? {
        val root = runCatching { Json.objectIn(json) }.getOrNull().obj() ?: return null
        val list = root["picks"] as? List<*> ?: return null
        return list.mapNotNull { it.obj() }.mapNotNull { p ->
            val id = p.str("id") ?: return@mapNotNull null
            val adds = p["adds"].obj()?.let { a -> a.str("id")?.let { AddsSystem(it, a.str("name") ?: it, a.str("owner") ?: id) } }
            TargetPick(id, p.str("kind") ?: "repo", p.str("name") ?: id, p["read"] as? Boolean, p.str("boundary"), adds)
        }
    }

    /** A topic's owner is a system or a team: a repo's own facts say what it publishes. */
    fun shown(picks: List<TargetPick>, step: String?): List<TargetPick> = if (step == TOPICS_STEP) picks.filter { it.kind != "repo" } else picks

    /** A row of the picker: the id first (what --target takes), then what it is. */
    fun line(p: TargetPick): String {
        val what =
            when (p.kind) {
                "repo" -> listOfNotNull(Copy.PICK_REPO, if (p.read == true) Copy.PICK_READ else Copy.PICK_NOT_READ, p.name.takeIf { it != p.id })
                "system" -> listOfNotNull(Copy.PICK_SYSTEM, p.boundary, p.name.takeIf { it != p.id })
                else -> listOfNotNull(Copy.PICK_TEAM, p.name.takeIf { it != p.id }, if (p.adds != null) Copy.PICK_NO_SYSTEM else null)
            }
        return "${p.id}  —  ${what.joinToString(", ")}"
    }

    /** The id a row stands for, or what was typed when it is no row. */
    fun targetOf(chosen: String): String = chosen.substringBefore("  —  ").trim()

    /**
     * A repo, a system or a team with a system answers as it is; a team with none, or a name the
     * picker doesn't have, is a new system for the profile, asked before anything is written. The
     * command line decides again: it writes.
     */
    fun plan(picks: List<TargetPick>, typed: String): TargetPlan? {
        val t = typed.trim()
        if (t.isEmpty()) return null
        val p = picks.firstOrNull { it.id.equals(t, ignoreCase = true) }
        if (p != null && p.kind == "team" && p.adds != null) return TargetPlan.Offer(p.id, p.adds.id, p.adds.name, vendor = false, owner = p.adds.owner)
        if (p != null) return TargetPlan.Answer(p.id)
        val id = t.lowercase().replace(Regex("[^a-z0-9]+"), "-").trim('-')
        if (id.isEmpty()) return null
        return TargetPlan.Offer(t, id, t, vendor = true)
    }

    /** `questions answer <id> --target <t> [--add-system vendor|internal] [--match <rule>]`. */
    fun targetArgv(id: String, target: String, addSystem: String? = null, match: String? = null): List<String> =
        listOf("questions", "answer", id, "--target", target.trim()) +
            (addSystem?.let { listOf("--add-system", it) } ?: emptyList()) +
            (match?.trim()?.takeIf { it.isNotEmpty() }?.let { listOf("--match", it) } ?: emptyList())

    // ---------------------------------------------------------------- the contract check (F7)

    val CONTRACTS_ARGV = listOf("join", "contracts")

    /** The app's Map › Mismatches page. */
    const val MISMATCHES_SCREEN = "#/mismatches"

    /** The counts `atticus join contracts --json` printed; null when it printed none. */
    fun contractCounts(json: String): ContractCounts? {
        val c = runCatching { Json.objectIn(json) }.getOrNull().obj()?.get("counts").obj() ?: return null
        val m = (c["mismatches"] as? Number)?.toInt() ?: return null
        fun n(k: String) = (c[k] as? Number)?.toInt() ?: 0
        return ContractCounts(n("links"), n("compared"), m, n("unconfirmed"))
    }

    /** The status bar's part, only when the check found a mismatch. */
    fun contractsStatus(c: ContractCounts?): String? = c?.takeIf { it.mismatches > 0 }?.let { "${it.mismatches} contract mismatch${if (it.mismatches == 1) "" else "es"}" }

    /** The counts in words, for the status bar's tooltip and the action's notice. */
    fun contractsWords(c: ContractCounts?): String? =
        when {
            c == null -> null
            c.compared == 0 -> Copy.CONTRACTS_NONE
            else -> Copy.contractsCounts(c.mismatches, c.unconfirmed, c.compared)
        }

    // ---------------------------------------------------------------- a repo type's notes (F9)

    /** `repo-type note <type> | --org-wide`, with `--add "..."` when a note is given; null type is org-wide. */
    fun noteArgv(type: String?, note: String? = null): List<String> =
        listOf("repo-type", "note") + (if (type == null) listOf("--org-wide") else listOf(type)) + (note?.let { listOf("--add", it) } ?: emptyList())

    /** A note as the command line takes it: one line, 1 to 1,000 characters; null otherwise. */
    fun noteOf(typed: String?): String? = typed?.replace(Regex("\\s*[\\r\\n]+\\s*"), " ")?.trim()?.takeIf { it.isNotEmpty() && it.length <= 1000 }

    val RULES_ARGV = listOf("repo-type", "rules")
    val RULES_SAVE_ARGV = listOf("repo-type", "rules", "--save")

    /** The org pack's repo types: the folders of `repo-types/` with a `type.yaml`, sorted. */
    fun repoTypes(orgPack: Path?): List<String> {
        val dir = orgPack?.resolve("repo-types") ?: return emptyList()
        if (!Files.isDirectory(dir)) return emptyList()
        return Files.list(dir).use { s ->
            s.filter { Files.isRegularFile(it.resolve("type.yaml")) }.map { it.fileName.toString() }.filter { !it.startsWith(".") }.sorted().toList()
        }
    }

    // ---------------------------------------------------------------- counts safe to paste (F10)

    val COUNTS_ARGV = listOf("doctor", "--counts")

    /**
     * The app's viewer keys in the tool window (F10). IntelliJ's keymap binds Esc to Focus Editor,
     * and the platform dispatches a key to the keymap before the browser sees it, so Esc pressed in
     * the app would leave the tool window instead of full screen or Find a box. The tool window
     * takes Esc itself and gives it to the page as the key the viewer listens for: on the element
     * with focus, so Find a box clears its search, and bubbling to the window, so full screen
     * leaves. F and / are bound to nothing in the keymap and reach the page as they are.
     */
    const val ESCAPE_TO_PAGE =
        "(function(){var t=document.activeElement||document.body;" +
            "t.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',keyCode:27,bubbles:true,cancelable:true}));})();"
}
