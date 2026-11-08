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

    /**
     * Where the metarepo keeps OpenSpec and the catalog: `layout.openspec` and `layout.catalog` of
     * `org-pack/sources.yaml` (a repo adopted in place may move them), else `openspec` and `catalog`.
     */
    data class Layout(val openspec: String, val catalog: String)

    fun layout(root: Path): Layout {
        val pack = orgPack(root) ?: return Layout("openspec", "catalog")
        val lines = readLines(pack.resolve("sources.yaml"))
        var inLayout = false
        var openspec = "openspec"
        var catalog = "catalog"
        val entry = Regex("""^\s+(openspec|catalog):\s*["']?([^"'#\s]+)["']?\s*(#.*)?$""")
        for (line in lines) {
            if (Regex("^\\S").containsMatchIn(line)) inLayout = line.startsWith("layout:")
            else if (inLayout) entry.find(line)?.let {
                if (it.groupValues[1] == "openspec") openspec = it.groupValues[2] else catalog = it.groupValues[2]
            }
        }
        return Layout(openspec.trimEnd('/'), catalog.trimEnd('/'))
    }

    /**
     * A file's lines, or none: one saved in another encoding (ANSI from an older Notepad) is read
     * as Windows-1252 rather than throwing from the action; a missing or unreadable one is empty.
     */
    fun readLines(file: Path): List<String> = readText(file)?.lines() ?: emptyList()

    fun readText(file: Path): String? =
        runCatching { Files.readString(file) }.getOrNull()
            ?: runCatching { String(Files.readAllBytes(file), java.nio.charset.Charset.forName("windows-1252")) }.getOrNull()

    /** The repo ids in every profile's `repos.manifest.yaml`, in order, once each; read without a YAML parser. */
    fun repos(orgPack: Path): List<String> {
        val profiles = orgPack.resolve("profiles")
        if (!Files.isDirectory(profiles)) return emptyList()
        val out = LinkedHashSet<String>()
        val manifests = Files.list(profiles).use { s -> s.map { it.resolve("repos.manifest.yaml") }.filter { Files.isRegularFile(it) }.sorted().toList() }
        val id = Regex("""^ {0,4}-\s+id:\s*["']?([A-Za-z0-9][A-Za-z0-9._-]*)["']?\s*$""")
        for (m in manifests) {
            var inRepos = false
            for (line in readLines(m)) {
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

    /**
     * The metarepo `atticus sandbox create <dir>` made: the folder its "Its metarepo is …" line
     * names, else `<dir>/metarepo` (the sandbox folder itself holds the repos beside it).
     */
    fun sandboxMetarepo(printed: String, dir: String): String =
        Regex("Its metarepo is (.+?)\\. Run commands there").find(printed)?.groupValues?.get(1)?.trim()
            ?: Path.of(dir, "metarepo").toString()

    /** The address `atticus ui` prints once it is ready; only an address on this machine. */
    fun appUrl(output: String): String? = Regex("Atticus is running at (http://127\\.0\\.0\\.1:\\d+)").find(output)?.groupValues?.get(1)
}
