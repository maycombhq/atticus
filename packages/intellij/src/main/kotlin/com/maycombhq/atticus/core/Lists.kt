package com.maycombhq.atticus.core

import java.nio.file.Files
import java.nio.file.Path

/** One choice in a list: the value the command takes, what a person reads, and a word beside it. */
data class Pick(val value: String, val label: String, val detail: String)

/**
 * The lists Run a Command picks an argument from when it is one of the metarepo's own (ADR 0099),
 * as the VS Code extension does: knowledge items, needs, features, manual steps, triage items,
 * glossary terms, findings (from the command line's JSON), and records, flows, proposals and
 * stories (from the metarepo's files). Nothing here calls the IDE, so it is tested on its own.
 */
object Lists {
    /** The argument kinds the catalogue already names, and the ids it calls text. */
    private val BY_KIND = mapOf("flow" to "flow", "system" to "system", "record" to "record", "finding" to "finding")

    private val BY_ARG =
        mapOf(
            "knowledge verify item" to "knowledge-item",
            "knowledge correct item" to "knowledge-item",
            "knowledge reject item" to "knowledge-item",
            "needs done item" to "need",
            "needs skip item" to "need",
            "needs reopen item" to "need",
            "feature show id" to "feature",
            "feature name id" to "feature",
            "feature tag id" to "feature",
            "feature split id" to "feature",
            "feature link id" to "feature",
            "feature spec id" to "feature",
            "feature merge into" to "feature",
            "feature merge from" to "feature",
            "todo show step" to "todo",
            "todo done step" to "todo",
            "todo run step" to "todo",
            "triage decide item" to "triage",
            "glossary link term" to "term",
            "glossary alias term" to "term",
            "onboard check name" to "dialect-proposal",
            "onboard accept name" to "dialect-proposal",
            "onboard check framework name" to "framework-proposal",
            "onboard accept framework name" to "framework-proposal",
            "tests generate story" to "story",
        )

    /** The list an argument is picked from, or null when it is typed. */
    fun kindFor(command: String, arg: String, kind: String): String? = BY_ARG["$command $arg"] ?: BY_KIND[kind]

    private fun list(json: String): List<Map<*, *>> =
        (runCatching { Json.objectIn(json) }.getOrNull() as? List<*>)?.mapNotNull { it.obj() } ?: emptyList()

    private fun field(json: String, key: String): List<Map<*, *>> = runCatching { Json.objectIn(json) }.getOrNull().obj()?.objs(key) ?: emptyList()

    /** `atticus knowledge list --json`. */
    fun knowledgeItems(json: String): List<Pick> =
        list(json).mapNotNull { i ->
            val id = i.str("id") ?: return@mapNotNull null
            val review = i["review"].obj()?.str("verdict")?.let { if (it == "verified") "verified" else it } ?: "not reviewed"
            Pick(id, i.str("title") ?: i.str("name") ?: id, "${i.str("knowledgeKind") ?: i.str("kind") ?: ""} · $review")
        }

    /** `atticus needs --change <id> --all --json`. */
    fun needs(json: String): List<Pick> =
        list(json).mapNotNull { n ->
            val item = n.str("item") ?: return@mapNotNull null
            val target = n.str("for")
            Pick(item, n.str("title") ?: item, "${n.str("status") ?: "open"} · ${if (target == null || target == "change") "for the change" else "for $target"}")
        }

    /** `atticus feature list --json`. */
    fun features(json: String): List<Pick> =
        field(json, "features").mapNotNull { f ->
            val id = f.str("id") ?: return@mapNotNull null
            Pick(id, f.str("name") ?: id, id)
        }

    /** `atticus todo --all --json`: a step is named with its change, as todo show takes it. */
    fun todos(json: String): List<Pick> =
        list(json).mapNotNull { t ->
            val id = t.str("id") ?: return@mapNotNull null
            val change = t.str("change")
            Pick(if (change != null) "$change/$id" else id, t.str("title") ?: id, listOfNotNull(change, t.str("state")).joinToString(" · "))
        }

    /** `atticus triage --json`. */
    fun triage(json: String): List<Pick> =
        field(json, "items").mapNotNull { t ->
            val id = t.str("id") ?: return@mapNotNull null
            Pick(id, t.str("summary") ?: id, t.str("kind") ?: "")
        }

    /** `atticus glossary list --json`: a term is given by its words. */
    fun terms(json: String): List<Pick> =
        field(json, "terms").mapNotNull { t ->
            val term = t.str("term") ?: return@mapNotNull null
            Pick(term, term, t.str("definition") ?: "")
        }

    /** `atticus findings <change> --json`: the open ones. */
    fun findings(json: String): List<Pick> =
        list(json).filter { (it.str("state") ?: "open") == "open" }.mapNotNull { f ->
            val id = f.str("id") ?: return@mapNotNull null
            Pick(id, f.str("summary") ?: id, f.str("severity") ?: "")
        }

    private fun yamlFiles(dir: Path): List<Path> =
        if (!Files.isDirectory(dir)) {
            emptyList()
        } else {
            Files.list(dir).use { s -> s.filter { Files.isRegularFile(it) && Regex("\\.ya?ml$").containsMatchIn(it.fileName.toString()) }.sorted().toList() }
        }

    private fun dirs(dir: Path): List<Path> =
        if (!Files.isDirectory(dir)) emptyList() else Files.list(dir).use { s -> s.filter { Files.isDirectory(it) }.sorted().toList() }

    /** A top-level `key: value` of a YAML file, quotes taken off. */
    private fun top(text: String, key: String): String? =
        Regex("^$key:\\s*(.+?)\\s*$", RegexOption.MULTILINE).find(text)?.groupValues?.get(1)?.trim('"', '\'')

    /** The catalog's records, of one kind or all: `catalog/<layer>/<kind>/<id>.yaml`. */
    fun records(root: Path, kind: String?): List<Pick> {
        val out = mutableListOf<Pick>()
        for (layer in dirs(root.resolve("catalog")))
            for (k in dirs(layer)) {
                if (kind != null && k.fileName.toString() != kind.lowercase()) continue
                for (f in yamlFiles(k)) {
                    val text = runCatching { Files.readString(f) }.getOrNull() ?: continue
                    val id = top(text, "id") ?: continue
                    val recordKind = top(text, "kind") ?: k.fileName.toString()
                    if (kind != null && recordKind != kind) continue
                    out += Pick(id, top(text, "name") ?: id, recordKind)
                }
            }
        return out.distinctBy { it.detail to it.value }.sortedWith(compareBy({ it.detail }, { it.label }))
    }

    /** The repos' flows: `specs/<repo>/<flow>.yaml`. */
    fun flows(root: Path): List<Pick> =
        dirs(root.resolve("specs")).flatMap { repo ->
            yamlFiles(repo).mapNotNull { f ->
                val text = runCatching { Files.readString(f) }.getOrNull() ?: return@mapNotNull null
                val id = top(text, "id") ?: return@mapNotNull null
                Pick(id, top(text, "name") ?: id, repo.fileName.toString())
            }
        }

    /** Onboarding proposals: `proposals/dialects/<name>.yaml` or `proposals/frameworks/<name>.yaml`. */
    fun proposals(root: Path, folder: String): List<Pick> =
        yamlFiles(root.resolve("proposals").resolve(folder)).map { f ->
            val name = f.fileName.toString().replace(Regex("\\.ya?ml$"), "")
            Pick(name, name, "")
        }

    private val REPO_HEADING = Regex("""^##\s+(.+?)\s*$""")
    private val TASK_LINE = Regex("""^\s*[-*]\s+\[([ xX]?)]\s+(\S+)\s+(.*)$""")
    private val STORY_NOTE = Regex("""\s*\((?:story|stories)\b[^)]*\)\s*$""")

    /** ADR 0113: a change's tasks from its tasks.md, each checkbox line under a repo's heading. */
    fun tasks(root: Path, change: String): List<Pick> {
        val file =
            listOf(root.resolve("openspec/changes/$change/tasks.md"), root.resolve(".atticus/openspec/changes/$change/tasks.md"))
                .firstOrNull { Files.isRegularFile(it) } ?: return emptyList()
        var repo = ""
        val out = mutableListOf<Pick>()
        for (line in Files.readAllLines(file)) {
            REPO_HEADING.find(line)?.let { repo = it.groupValues[1].replace("`", "").replace("*", "").trim().split(Regex("""\s+""")).first() }
            val m = TASK_LINE.find(line) ?: continue
            if (repo.isEmpty()) continue
            val title = m.groupValues[3].replace(STORY_NOTE, "").trim()
            out += Pick(m.groupValues[2], title, if (m.groupValues[1].isBlank()) repo else "$repo · done")
        }
        return out
    }

    /** A change's stories: `openspec/changes/<change>/stories/<id>.md`, titled by their first heading. */

    fun stories(root: Path, change: String): List<Pick> {
        val dir = listOf(root.resolve("openspec/changes/$change/stories"), root.resolve(".atticus/openspec/changes/$change/stories")).firstOrNull { Files.isDirectory(it) } ?: return emptyList()
        return Files.list(dir).use { s -> s.filter { it.fileName.toString().endsWith(".md") }.sorted().toList() }.map { f ->
            val id = f.fileName.toString().removeSuffix(".md")
            val head = Regex("^#\\s+(.+)$", RegexOption.MULTILINE).find(Files.readString(f))?.groupValues?.get(1)?.trim()
            Pick(id, head ?: id, id)
        }
    }
}
