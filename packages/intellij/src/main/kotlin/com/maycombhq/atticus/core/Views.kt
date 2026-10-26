package com.maycombhq.atticus.core

import java.nio.file.Files
import java.nio.file.Path

/**
 * The tool window's tabs (ADR 0105 addendum 2, 2026-10-26): what VS Code's sidebar offers, as
 * native trees beside the app, in the order of a working day. The names are in Copy.
 */
enum class Tabs(val tabName: String) {
    NEXT(Copy.NEXT_TAB),
    WAITING(Copy.WAITING_TAB),
    CHANGES(Copy.CHANGES_TAB),
    REPOS(Copy.REPOS_TAB),
    KNOWLEDGE(Copy.KNOWLEDGE_TAB),
    RUNS(Copy.RUNS_TAB),
    HISTORY(Copy.HISTORY_TAB),
    APP(Copy.APP_TAB),
    OUTPUT(Copy.OUTPUT_TAB),
    ;

    companion object {
        /** Every tab name, for the test that a placed tab is one that exists. */
        val NAMES: Set<String> = entries.map { it.tabName }.toSet()
    }
}

/** How the Waiting tree groups what waits on a person (ADR 0105 addendum, 2026-10-23). */
enum class Grouping { BY_CHANGE, BY_KIND }

/**
 * The filter a view's box holds (ADR 0105 addendum): words to match, matched against an item's
 * title, id, change and repo, case-insensitively. Every word must match something.
 */
object Filter {
    fun words(text: String): List<String> = text.trim().lowercase().split(Regex("\\s+")).filter { it.isNotEmpty() }

    /** Whether a row whose searchable text is [fields] matches every word of the filter. */
    fun matches(filter: String, fields: List<String?>): Boolean {
        val ws = words(filter)
        if (ws.isEmpty()) return true
        val hay = fields.filterNotNull().joinToString(" ").lowercase()
        return ws.all { hay.contains(it) }
    }
}

// ------------------------------------------------------------------ Repos

/** A repo of the manifests, with what a person says it is (ADR 0128). */
data class RepoRow(
    val id: String,
    val description: String?,
    /** The assistant drafted it and nobody has confirmed it (trust: suggested). */
    val suggested: Boolean,
) {
    /** The line beside the id: the description, marked when it is only a draft. */
    val detail: String
        get() =
            when {
                description == null -> Copy.REPO_NO_DESCRIPTION
                suggested -> Copy.repoDraftDescription(description)
                else -> description
            }
}

/** The repos' descriptions, read without a YAML parser from the manifests and `repo describe`. */
object Repos {
    /**
     * Each repo of every profile's manifest with its description and whether it is a draft. The
     * manifest's repo entries are `- id:` at the list's indent, and a description is the nested
     * `description:` block's `text:` and `trust:` under one of them.
     */
    fun rows(orgPack: Path): List<RepoRow> {
        val profiles = orgPack.resolve("profiles")
        if (!Files.isDirectory(profiles)) return emptyList()
        val manifests =
            Files.list(profiles).use { s -> s.map { it.resolve("repos.manifest.yaml") }.filter { Files.isRegularFile(it) }.sorted().toList() }
        val out = LinkedHashMap<String, RepoRow>()
        for (m in manifests) for (r in rowsOf(runCatching { Files.readAllLines(m) }.getOrElse { emptyList() })) out.putIfAbsent(r.id, r)
        return out.values.toList()
    }

    private val ID = Regex("""^ {0,4}-\s+id:\s*["']?([A-Za-z0-9][A-Za-z0-9._-]*)["']?\s*$""")
    private val TEXT = Regex("""^\s+text:\s*(.+?)\s*$""")
    private val TRUST = Regex("""^\s+trust:\s*["']?(suggested|verified)["']?\s*$""")
    private val DESCRIPTION = Regex("""^\s+description:\s*(.*)$""")

    /** The rows of one manifest's lines. Visible for testing. */
    fun rowsOf(lines: List<String>): List<RepoRow> {
        val out = mutableListOf<RepoRow>()
        var inRepos = false
        var id: String? = null
        var text: String? = null
        var suggested = false
        var inDescription = false
        fun flush() {
            id?.let { out += RepoRow(it, text, suggested && text != null) }
            id = null
            text = null
            suggested = false
            inDescription = false
        }
        for (line in lines) {
            if (Regex("^\\S").containsMatchIn(line)) {
                if (inRepos) flush()
                inRepos = line.startsWith("repos:")
                continue
            }
            if (!inRepos) continue
            val m = ID.find(line)
            if (m != null) {
                flush()
                id = m.groupValues[1]
                continue
            }
            if (id == null) continue
            val d = DESCRIPTION.find(line)
            if (d != null) {
                inDescription = true
                val inline = d.groupValues[1].trim().trim('"', '\'')
                if (inline.isNotEmpty()) {
                    text = inline
                    inDescription = false
                }
                continue
            }
            if (!inDescription) continue
            TEXT.find(line)?.let { text = it.groupValues[1].trim().trim('"', '\'') }
            TRUST.find(line)?.let { suggested = it.groupValues[1] == "suggested" }
        }
        if (inRepos) flush()
        return out
    }

    /** What `atticus repo describe --json` says: the repos with none, and the drafts waiting. */
    fun described(json: String): Pair<List<String>, Map<String, String>> {
        val root = runCatching { Json.objectIn(json) }.getOrNull().obj() ?: return emptyList<String>() to emptyMap()
        val missing = root.strs("missing").orEmpty()
        val drafts = root.objs("unconfirmed").mapNotNull { u -> u.str("id")?.let { it to (u.str("text") ?: "") } }.toMap()
        return missing to drafts
    }

    /** The manifests' rows with what `repo describe --json` says folded in; the manifest first. */
    fun merged(rows: List<RepoRow>, described: Pair<List<String>, Map<String, String>>): List<RepoRow> {
        val (missing, drafts) = described
        return rows.map { r ->
            when {
                drafts.containsKey(r.id) -> r.copy(description = drafts[r.id], suggested = true)
                r.id in missing -> r.copy(description = null, suggested = false)
                else -> r
            }
        }
    }
}

// ------------------------------------------------------------------ Knowledge sources

/** A wiki or docs source of `org-pack/sources.yaml` (C6). */
data class SourceRow(val id: String, val type: String?, val owner: String?) {
    val detail: String get() = listOfNotNull(type, owner?.let { Copy.sourceOwner(it) }).joinToString(" · ")
}

/**
 * The sources `org-pack/sources.yaml` lists, read without a YAML parser: each `id:` under `wikis:`,
 * whether the entry is a flow block or the one-line flow map the writer uses.
 */
object Sources {
    private val ID = Regex("""\bid:\s*["']?([A-Za-z0-9][A-Za-z0-9._-]*)["']?""")
    private val FIELD = Regex("""\b(type|owner):\s*["']?([A-Za-z0-9][A-Za-z0-9._/-]*)["']?""")

    fun rows(orgPack: Path): List<SourceRow> {
        val file = orgPack.resolve("sources.yaml")
        if (!Files.isRegularFile(file)) return emptyList()
        return rowsOf(runCatching { Files.readAllLines(file) }.getOrElse { emptyList() })
    }

    /** The rows of sources.yaml's lines. Visible for testing. */
    fun rowsOf(lines: List<String>): List<SourceRow> {
        val out = mutableListOf<SourceRow>()
        var inWikis = false
        var fields = mutableMapOf<String, String>()
        var id: String? = null
        fun flush() {
            id?.let { out += SourceRow(it, fields["type"], fields["owner"]) }
            id = null
            fields = mutableMapOf()
        }
        for (line in lines) {
            if (Regex("^\\S").containsMatchIn(line)) {
                flush()
                inWikis = line.startsWith("wikis:")
                continue
            }
            if (!inWikis) continue
            val starts = Regex("""^\s*-\s""").containsMatchIn(line)
            if (starts) flush()
            ID.find(line)?.let { if (id == null) id = it.groupValues[1] }
            for (m in FIELD.findAll(line)) fields.putIfAbsent(m.groupValues[1], m.groupValues[2])
        }
        flush()
        return out
    }
}

// ------------------------------------------------------------------ Changes

/** A change of the metarepo, with how it is going (`atticus change status <id> --json`). */
data class ChangeRow(
    val id: String,
    val title: String,
    val state: String,
    /** Where the stages' work is, in one sentence (B-change), when the status says. */
    val work: String?,
    val riskLevel: String?,
    val riskScore: Int?,
    /** The kinds of test the change requires. */
    val testKinds: List<String>,
    /** An OpenSpec store's change (ADR 0126): read-only, with the store's label. */
    val store: String? = null,
    val tasksDone: Int? = null,
    val tasksTotal: Int? = null,
) {
    /** The line beside the title: the state, the work, the risk and the test kinds. */
    val detail: String
        get() =
            listOfNotNull(
                store?.let { Copy.fromStore(it) },
                state.takeIf { it.isNotEmpty() },
                work,
                riskLevel?.let { Copy.riskLine(it, riskScore) },
                testKinds.takeIf { it.isNotEmpty() }?.let { Copy.testKinds(it) },
                if (tasksTotal != null) Copy.tasksLine(tasksDone ?: 0, tasksTotal) else null,
            ).joinToString(" · ")

    val words: List<String?> get() = listOf(id, title, state, work, store)
}

/** A change's progress, risk and tests, and the OpenSpec stores' read-only changes. */
object Changes {
    /** `atticus change list --json`: the metarepo's changes, then the stores' (ADR 0126). */
    fun rows(json: String): List<ChangeRow> {
        val list = runCatching { Json.objectIn(json) }.getOrNull() as? List<*> ?: return emptyList()
        return list.mapNotNull { it.obj() }.mapNotNull { c ->
            val id = c.str("id") ?: return@mapNotNull null
            val tasks = c["tasks"].obj()
            ChangeRow(
                id = id,
                title = c.str("title") ?: id,
                state = c.str("state") ?: "",
                work = null,
                riskLevel = null,
                riskScore = null,
                testKinds = emptyList(),
                store = c.str("store"),
                tasksDone = (tasks?.get("done") as? Number)?.toInt(),
                tasksTotal = (tasks?.get("total") as? Number)?.toInt(),
            )
        }
    }

    /**
     * `atticus change status <id> --json` folded into a row: the work line (B-change), the risk
     * and the kinds of test the change requires. A store's change has no status: it stays as it is.
     */
    fun withStatus(row: ChangeRow, json: String): ChangeRow {
        val root = runCatching { Json.objectIn(json) }.getOrNull().obj() ?: return row
        val risk = root["risk"].obj()
        val tests = root["tests"].obj()
        val kinds =
            (tests?.strs("required").orEmpty() + tests?.objs("added").orEmpty().flatMap { it.strs("kinds").orEmpty() }).distinct()
        return row.copy(
            state = root.str("state") ?: row.state,
            work = root["progress"].obj()?.str("summary") ?: row.work,
            riskLevel = risk?.str("level") ?: row.riskLevel,
            riskScore = (risk?.get("score") as? Number)?.toInt() ?: row.riskScore,
            testKinds = if (kinds.isNotEmpty()) kinds else row.testKinds,
        )
    }

    /** The OpenSpec artifact lines `atticus openspec check` prints, as rows of the Changes tree. */
    fun storeLines(printed: String): List<String> =
        printed.lines().map { it.trim() }.filter { it.startsWith("OpenSpec store ") }
}

// ------------------------------------------------------------------ A task's knowledge

/** One knowledge page that applies to a task (B-task-knowledge), as the task context gives it. */
data class TaskKnowledgeRow(
    val id: String,
    val knowledgeKind: String,
    val title: String,
    val why: String,
    /** Its page: `<source>/<page>#<section>`, when it has one. */
    val page: String?,
    /** Other pages that say the same, best first. */
    val alsoOn: List<String>,
    /** The question a person is asked about pages that disagree, when there is one. */
    val conflictQuestion: String?,
    val verified: Boolean,
    val score: Double,
) {
    val detail: String
        get() =
            listOfNotNull(
                knowledgeKind.takeIf { it.isNotEmpty() },
                page,
                alsoOn.takeIf { it.isNotEmpty() }?.let { Copy.alsoOn(it.size) },
                if (verified) Copy.KNOWLEDGE_VERIFIED else Copy.KNOWLEDGE_UNVERIFIED,
            ).joinToString(" · ")
}

object TaskKnowledge {
    private fun place(p: Map<*, *>?): String? {
        if (p == null) return null
        val source = p.str("source") ?: return null
        val page = p.str("page") ?: return source
        val section = p.str("section")
        return if (section.isNullOrEmpty()) "$source/$page" else "$source/$page#$section"
    }

    /**
     * `atticus task context <change> <task> --json`: the knowledge that applies, best first, each
     * with its page, the pages that also say it, and the question asked about pages that disagree.
     */
    fun rows(json: String): List<TaskKnowledgeRow> {
        val root = runCatching { Json.objectIn(json) }.getOrNull().obj() ?: return emptyList()
        return root.objs("knowledge").mapNotNull { k ->
            val id = k.str("id") ?: return@mapNotNull null
            val conflicts = k.objs("conflicts")
            TaskKnowledgeRow(
                id = id,
                knowledgeKind = k.str("knowledgeKind") ?: k.str("kind") ?: "",
                title = k.str("title") ?: id,
                why = k.str("why") ?: "",
                page = place(k["page"].obj()),
                alsoOn = k.objs("alsoOn").mapNotNull { place(it) },
                conflictQuestion = conflicts.firstNotNullOfOrNull { c -> c.str("question") ?: c["question"].obj()?.str("text") },
                verified = k["verified"] == true,
                score = (k["score"] as? Number)?.toDouble() ?: 0.0,
            )
        }.sortedByDescending { it.score }
    }
}

// ------------------------------------------------------------------ A call's path through gateways

/** One hop a call takes through a gateway (ADR 0124 addendum A-gateway2). */
data class HopRow(val route: String, val auth: String?, val scopes: List<String>, val facing: String?, val at: String?) {
    val detail: String
        get() =
            listOfNotNull(
                facing?.let { Copy.gatewayFacing(it) },
                auth?.let { Copy.gatewayAuth(it) },
                scopes.takeIf { it.isNotEmpty() }?.let { Copy.gatewayScopes(it) },
                at,
            ).joinToString(" · ")
}

/** A joined call-out and the gateways it goes through, as `atticus estate join --json` gives it. */
data class CallPathRow(
    val fromRepo: String,
    val toRepo: String,
    val method: String?,
    val path: String?,
    val hops: List<HopRow>,
    /** The scopes the caller's token must hold across the whole path. */
    val scopes: List<String>,
) {
    /** The path in one line: the caller, each gateway's route in order, then the service. */
    val label: String get() = (listOf(fromRepo) + hops.map { it.route } + listOf(toRepo)).joinToString(" → ")

    val detail: String
        get() =
            listOfNotNull(
                listOfNotNull(method, path).joinToString(" ").takeIf { it.isNotEmpty() },
                hops.takeIf { it.isNotEmpty() }?.let { Copy.throughGateways(it.size) },
                scopes.takeIf { it.isNotEmpty() }?.let { Copy.gatewayScopes(it) },
            ).joinToString(" · ")
}

object CallPaths {
    /** `atticus estate join --json`: each joined call-out, with its hops through the gateways. */
    fun rows(json: String): List<CallPathRow> {
        val root = runCatching { Json.objectIn(json) }.getOrNull().obj() ?: return emptyList()
        return root.objs("joins").mapNotNull { j ->
            val call = j["call"].obj() ?: return@mapNotNull null
            val entry = j["entry"].obj() ?: return@mapNotNull null
            CallPathRow(
                fromRepo = call.str("repo") ?: "",
                toRepo = entry.str("repo") ?: "",
                method = j.str("method"),
                path = j.str("path"),
                hops =
                    j.objs("gateway").map { h ->
                        HopRow(
                            route = h.str("route") ?: "",
                            auth = h.str("auth"),
                            scopes = h.strs("scopes").orEmpty(),
                            facing = h.str("facing"),
                            at = h["entry"].obj()?.str("at"),
                        )
                    },
                scopes = j.strs("scopes").orEmpty(),
            )
        }
    }
}

// ------------------------------------------------------------------ Needs and findings

/** What the organisation needs of a change (ADR 0101), as `atticus needs --all --json` lists it. */
data class NeedRow(val change: String, val item: String, val title: String, val status: String, val forWhat: String?, val handledBy: String?) {
    val detail: String
        get() =
            listOfNotNull(
                status,
                forWhat?.takeIf { it.isNotEmpty() && it != "change" }?.let { "for $it" },
                handledBy?.let { "handled by $it" },
                change,
            ).joinToString(" · ")

    val words: List<String?> get() = listOf(item, title, change, status, forWhat)
}

/** What `atticus finding <change> <id> <action>` takes, and what it needs with it. */
data class FindingAction(val action: String, val label: String, val needs: String?)

/** One open finding of a change (ADR 0094), as `atticus findings <change> --json` lists it. */
data class FindingRow(
    val change: String,
    val id: String,
    val summary: String,
    val severity: String,
    val kind: String,
    val waivable: Boolean,
    val layer: String? = null,
    val hasPatch: Boolean = false,
    val askedOf: String? = null,
) {
    val detail: String get() = listOfNotNull(severity.takeIf { it.isNotEmpty() }, kind.takeIf { it.isNotEmpty() }, change).joinToString(" · ")

    val words: List<String?> get() = listOf(id, summary, severity, kind, change)
}

object Needs {
    /** The open needs of every change, or of one when the command was given `--change`. */
    fun rows(json: String): List<NeedRow> {
        val list = runCatching { Json.objectIn(json) }.getOrNull() as? List<*> ?: return emptyList()
        return list.mapNotNull { it.obj() }.mapNotNull { n ->
            val item = n.str("item") ?: return@mapNotNull null
            NeedRow(
                change = n.str("change") ?: "",
                item = item,
                title = n.str("title") ?: item,
                status = n.str("status") ?: "open",
                forWhat = n.str("for"),
                handledBy = n.str("handledBy"),
            )
        }
    }

    fun open(rows: List<NeedRow>): List<NeedRow> = rows.filter { it.status == "open" }
}

object Findings {
    fun rows(change: String, json: String): List<FindingRow> {
        val list = runCatching { Json.objectIn(json) }.getOrNull() as? List<*> ?: return emptyList()
        return list.mapNotNull { it.obj() }.filter { (it.str("state") ?: "open") == "open" }.mapNotNull { f ->
            val id = f.str("id") ?: return@mapNotNull null
            FindingRow(
                change = f.str("change") ?: change,
                id = id,
                summary = f.str("summary") ?: id,
                severity = f.str("severity") ?: "",
                kind = f.str("kind") ?: "",
                waivable = f["waivable"] == true,
                layer = f.str("layer"),
                hasPatch = f["fix"].obj()?.str("patch") != null,
                askedOf = f["question"].obj()?.str("owner"),
            )
        }
    }

    /**
     * What can be done with a finding, as `atticus finding <change> <id> <action>` takes it
     * (apply | edit-and-apply | not-relevant | waive | ask), in the order the VS Code sidebar
     * offers them. A constitution rule's finding is never waived (safety rule 6) and neither is
     * one the critic didn't mark waivable, so Waive it is offered on neither.
     */
    fun actions(f: FindingRow): List<FindingAction> {
        if (f.kind == "knowledge-gap") {
            return listOf(
                f.askedOf?.let { FindingAction("ask", Copy.findingAsk(it), null) } ?: FindingAction("ask", Copy.FINDING_ASK_SOMEONE, "asked-of"),
                FindingAction("edit-and-apply", Copy.FINDING_WROTE_IT_IN, "reason"),
            )
        }
        return buildList {
            if (f.hasPatch) add(FindingAction("apply", Copy.FINDING_APPLY, null))
            add(FindingAction("edit-and-apply", Copy.FINDING_FIXED_BY_HAND, "reason"))
            add(FindingAction("not-relevant", Copy.FINDING_NOT_RELEVANT, "reason"))
            if (f.severity == "blocking" && f.waivable && f.layer != "constitution") add(FindingAction("waive", Copy.FINDING_WAIVE, "reason"))
            add(FindingAction("ask", Copy.FINDING_ASK_SOMEONE, "asked-of"))
        }
    }

    /** The command one of those actions runs, with what the person gave it. */
    fun argv(f: FindingRow, a: FindingAction, given: String?): List<String> =
        listOf("finding", f.change, f.id, a.action) +
            when {
                given.isNullOrBlank() -> emptyList()
                a.needs == "asked-of" -> listOf("--asked-of", given.trim())
                a.needs == "reason" -> listOf("--reason", given.trim())
                else -> emptyList()
            }
}

// ------------------------------------------------------------------ What waits on you, grouped

/** One thing that waits on a person (ADR 0105 addendum): what it is, and the change it belongs to. */
sealed interface WaitingItem {
    /** The change it belongs to, or null when it belongs to none. */
    val change: String?

    /** The heading it sits under when the tree groups by kind. */
    val kind: String

    data class Question(val question: OpenQuestion) : WaitingItem {
        override val change: String? = null
        override val kind = Copy.WAITING_QUESTIONS
    }

    data class Need(val need: NeedRow) : WaitingItem {
        override val change: String? get() = need.change.takeIf { it.isNotEmpty() }
        override val kind = Copy.WAITING_NEEDS
    }

    data class Finding(val finding: FindingRow) : WaitingItem {
        override val change: String? get() = finding.change.takeIf { it.isNotEmpty() }
        override val kind = Copy.WAITING_FINDINGS

        /** A blocking finding puts its change first. */
        val blocking: Boolean get() = finding.severity == "blocking"
    }

    data class Manual(val step: Pick, override val change: String?) : WaitingItem {
        override val kind = Copy.WAITING_MANUAL
    }

    data class Knowledge(val count: Int) : WaitingItem {
        override val change: String? = null
        override val kind = Copy.WAITING_KNOWLEDGE
    }
}

object WaitingRows {
    /**
     * What waits, grouped (ADR 0105 addendum, 2026-10-23). By change: each change with its open
     * needs, open findings and manual steps under it, in that order, changes with something
     * blocking first; then what belongs to no change, in its own group. By kind: a group per kind,
     * in the order of a working day. An empty group is left out.
     */
    fun groups(items: List<WaitingItem>, by: Grouping, titleOf: (String) -> String = { it }): List<Pair<String, List<WaitingItem>>> =
        if (by == Grouping.BY_KIND) byKind(items) else byChange(items, titleOf)

    private val KINDS = listOf(Copy.WAITING_QUESTIONS, Copy.WAITING_NEEDS, Copy.WAITING_FINDINGS, Copy.WAITING_MANUAL, Copy.WAITING_KNOWLEDGE)

    private fun byKind(items: List<WaitingItem>): List<Pair<String, List<WaitingItem>>> =
        KINDS.mapNotNull { k -> items.filter { it.kind == k }.takeIf { it.isNotEmpty() }?.let { "$k (${it.size})" to it } }

    private fun order(i: WaitingItem) = KINDS.indexOf(i.kind)

    private fun byChange(items: List<WaitingItem>, titleOf: (String) -> String): List<Pair<String, List<WaitingItem>>> {
        val ofChange = items.filter { it.change != null }.groupBy { it.change!! }
        val blocking = ofChange.filterValues { v -> v.any { it is WaitingItem.Finding && it.blocking } }.keys
        val changes =
            ofChange.keys.sortedWith(compareBy({ if (it in blocking) 0 else 1 }, { it })).map { c ->
                titleOf(c) to ofChange.getValue(c).sortedWith(compareBy({ order(it) }, { it.kind }))
            }
        val rest = items.filter { it.change == null }.sortedBy { order(it) }
        return changes + (if (rest.isEmpty()) emptyList() else listOf(Copy.WAITING_NO_CHANGE to rest))
    }
}

// ------------------------------------------------------------------ Model runs and prompt history

/** One model run (ADR 0106), as `atticus runs --json` lists it, newest first. */
data class RunRow(
    val runId: String,
    val change: String,
    val agent: String,
    val state: String,
    val attempt: Int,
    val answered: Boolean,
    val handedBack: Int,
    val startedAt: String?,
) {
    val detail: String
        get() =
            listOfNotNull(
                change.takeIf { it.isNotEmpty() },
                state.takeIf { it.isNotEmpty() },
                Copy.runRound(attempt),
                if (handedBack > 0) Copy.handedBack(handedBack) else null,
                if (!answered) Copy.RUN_NOT_ANSWERED else null,
                startedAt?.replace("T", " ")?.take(16),
            ).joinToString(" · ")

    val words: List<String?> get() = listOf(runId, change, agent, state)
}

object ModelRuns {
    fun rows(json: String): List<RunRow> {
        val root = runCatching { Json.objectIn(json) }.getOrNull().obj() ?: return emptyList()
        return root.objs("runs").mapNotNull { r ->
            val id = r.str("runId") ?: return@mapNotNull null
            RunRow(
                runId = id,
                change = r.str("change") ?: "",
                agent = r.str("agent") ?: "",
                state = r.str("state") ?: "",
                attempt = (r["attempt"] as? Number)?.toInt() ?: 1,
                answered = r["answered"] == true,
                handedBack = (r["handedBack"] as? Number)?.toInt() ?: 0,
                startedAt = r.str("startedAt"),
            )
        }
    }

    /** The app's Model runs screen, on one run. */
    fun hash(runId: String): String = "#/runs?run=" + java.net.URLEncoder.encode(runId, Charsets.UTF_8).replace("+", "%20")
}

/** One turn of the prompt history (ADR 0110): what was asked, and what came back. */
data class PromptRow(val at: String, val surface: String, val session: String, val change: String?, val prompt: String?, val response: String?) {
    val label: String get() = (prompt ?: response ?: "").lineSequence().firstOrNull()?.take(120).orEmpty()

    val detail: String
        get() =
            listOfNotNull(
                surface.takeIf { it.isNotEmpty() },
                change,
                at.replace("T", " ").take(16),
                if (prompt != null && response == null) Copy.NO_RESPONSE_YET else null,
            ).joinToString(" · ")

    val words: List<String?> get() = listOf(prompt, response, change, surface, session)
}

object History {
    /** `atticus history --json`: whether it is recording, and the turns, newest first. */
    fun recording(json: String): Boolean = runCatching { Json.objectIn(json) }.getOrNull().obj()?.get("recording") == true

    fun rows(json: String): List<PromptRow> {
        val root = runCatching { Json.objectIn(json) }.getOrNull().obj() ?: return emptyList()
        return root.objs("turns").map { t ->
            PromptRow(
                at = t.str("at") ?: "",
                surface = t.str("surface") ?: "",
                session = t.str("session") ?: "",
                change = t.str("change"),
                prompt = t["prompt"].obj()?.str("text"),
                response = t["response"].obj()?.str("text"),
            )
        }
    }
}
