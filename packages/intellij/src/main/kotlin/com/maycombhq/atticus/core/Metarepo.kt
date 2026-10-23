package com.maycombhq.atticus.core

import java.nio.file.Files
import java.nio.file.Path

data class Change(val id: String, val title: String, val state: String)

data class Question(val id: String, val repo: String, val question: String)

/** The metarepo on disk: its org pack, its repos and changes, and the app's address (ADR 0099). */
object Metarepo {
    /** The org pack that makes [dir] a metarepo (`org-pack/`, or `.atticus/org-pack/` in an adopted repo). */
    fun orgPack(dir: Path): Path? =
        listOf(dir.resolve("org-pack"), dir.resolve(".atticus").resolve("org-pack")).firstOrNull { Files.isDirectory(it) }

    /** The repo ids in every profile's `repos.manifest.yaml`, in order, once each; read without a YAML parser. */
    fun repos(orgPack: Path): List<String> {
        val profiles = orgPack.resolve("profiles")
        if (!Files.isDirectory(profiles)) return emptyList()
        val out = LinkedHashSet<String>()
        val manifests = Files.list(profiles).use { s -> s.map { it.resolve("repos.manifest.yaml") }.filter { Files.isRegularFile(it) }.sorted().toList() }
        val id = Regex("""^ {0,4}-\s+id:\s*["']?([A-Za-z0-9][A-Za-z0-9._-]*)["']?\s*$""")
        for (m in manifests) {
            var inRepos = false
            for (line in Files.readAllLines(m)) {
                if (Regex("^\\S").containsMatchIn(line)) inRepos = line.startsWith("repos:")
                if (inRepos) id.find(line)?.let { out += it.groupValues[1] }
            }
        }
        return out.toList()
    }

    /** The changes `atticus change list --json` printed. */
    fun changes(json: String): List<Change> {
        val list = runCatching { Json.objectIn(json) }.getOrNull() as? List<*> ?: return emptyList()
        return list.mapNotNull { it.obj() }.mapNotNull { c ->
            val id = c.str("id") ?: return@mapNotNull null
            Change(id, c.str("title") ?: id, c.str("state") ?: "")
        }
    }

    /** The open questions `atticus questions list --state open --json` printed. */
    fun questions(json: String): List<Question> {
        val root = runCatching { Json.objectIn(json) }.getOrNull().obj() ?: return emptyList()
        return root.objs("questions").mapNotNull { q ->
            val id = q.str("id") ?: return@mapNotNull null
            Question(id, q.str("repo") ?: "", q.str("question") ?: id)
        }
    }

    /** The org pack's platforms: one folder each under `profiles/`. */
    fun platforms(orgPack: Path): List<String> {
        val profiles = orgPack.resolve("profiles")
        if (!Files.isDirectory(profiles)) return emptyList()
        return Files.list(profiles).use { s -> s.filter { Files.isDirectory(it) }.map { it.fileName.toString() }.sorted().toList() }
    }

    /** The app's Prompt history screen (ADR 0110): what people asked their assistant here, and what it answered. */
    const val PROMPT_HISTORY_SCREEN = "#/history"

    /** A screen of the app (`#/home`, `#/runs?run=…`) at the address it printed; the app as it is for anything else. */
    fun screenUrl(base: String, screen: String?): String {
        val b = base.trimEnd('/')
        return if (screen != null && Regex("^#/[\\w/?=&.%-]*$").matches(screen)) "$b/$screen" else b
    }

    /** The address `atticus ui` prints once it is ready; only an address on this machine. */
    fun appUrl(output: String): String? = Regex("Atticus is running at (http://127\\.0\\.0\\.1:\\d+)").find(output)?.groupValues?.get(1)
}
