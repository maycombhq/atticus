package com.maycombhq.atticus.core

/**
 * The command line's own list of its commands, from `atticus commands --json` (ADR 0096): built
 * from its help text, so a new command is offered as soon as `atticus` has it.
 */
data class CatalogArg(
    val name: String,
    /** repo, change, flow, system, question, finding, record, path, choice or text. */
    val kind: String,
    val optional: Boolean,
    val many: Boolean,
    val choices: List<String>? = null,
)

data class CatalogFlag(
    val name: String,
    /** What the option takes, when it takes a value. */
    val value: String? = null,
    val required: Boolean,
    val summary: String? = null,
)

/** How a command runs: an AI step, a write to a shared system, a server, or the rest. */
enum class Runs {
    AI,
    SHARED,
    SERVE,
    LOCAL,
    ;

    companion object {
        fun of(s: String?): Runs =
            when (s) {
                "ai" -> AI
                "shared" -> SHARED
                "serve" -> SERVE
                else -> LOCAL
            }
    }
}

data class CatalogCommand(
    val id: String,
    val words: List<String>,
    val usage: String,
    val summary: String,
    val args: List<CatalogArg>,
    val flags: List<CatalogFlag>,
    val area: String,
    val runs: Runs,
    /** The option that makes a shared write happen (`--approve`, `--send`). */
    val approve: String? = null,
)

data class Area(val id: String, val title: String)

data class Catalog(val areas: List<Area>, val commands: List<CatalogCommand>) {
    companion object {
        /** Read `atticus commands --json`; fails when what it printed isn't that. */
        fun parse(json: String): Catalog {
            val root = Json.objectIn(json).obj() ?: throw IllegalArgumentException("atticus commands --json printed no JSON")
            val areas = root.objs("areas").map { Area(it.str("id") ?: "", it.str("title") ?: it.str("id") ?: "") }
            val commands =
                root.objs("commands").mapNotNull { c ->
                    val id = c.str("id") ?: return@mapNotNull null
                    CatalogCommand(
                        id = id,
                        words = c.strs("words") ?: id.split(' '),
                        usage = c.str("usage") ?: "atticus $id",
                        summary = c.str("summary") ?: "",
                        args =
                            c.objs("args").map {
                                CatalogArg(
                                    name = it.str("name") ?: "",
                                    kind = it.str("kind") ?: "text",
                                    optional = it.bool("optional"),
                                    many = it.bool("many"),
                                    choices = it.strs("choices"),
                                )
                            },
                        flags =
                            c.objs("flags").map {
                                CatalogFlag(
                                    name = it.str("name") ?: "",
                                    value = it.str("value"),
                                    required = it.bool("required"),
                                    summary = it.str("summary"),
                                )
                            },
                        area = c.str("area") ?: "",
                        runs = Runs.of(c.str("runs")),
                        approve = c.str("approve"),
                    )
                }
            return Catalog(areas, commands)
        }
    }
}
