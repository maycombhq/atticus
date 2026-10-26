package com.maycombhq.atticus.core

/**
 * Per-step models in IntelliJ (ADR 0121 addendum). Copilot in IntelliJ offers plugins no model,
 * so the plugin can't choose Copilot's model: where a step is handed to Copilot Chat, the person
 * picks the model the step expects in Copilot's own picker, and the plugin says which. Where the
 * command line runs the step on runtime.yaml's provider (model mode), the person's settings reach
 * it as ATTICUS_MODEL_<KIND>, which it takes over runtime.yaml's `models.<kind>`.
 *
 * A kind's model is the first of: the person's setting for it (Settings → Tools → Atticus), and
 * runtime.yaml's `models.<kind>` (`atticus next --json` gives it as `orgModels`). With neither,
 * the step runs on Copilot's own choice, as before.
 */
enum class StepClass(val id: String) {
    READ("read"),
    DRAFT("draft"),
    CRITIC("critic"),
    KNOWLEDGE("knowledge"),
    QUICK("quick"),
    ;

    /** The environment variable the command line reads the person's setting for this kind by. */
    val env: String get() = "ATTICUS_MODEL_${id.uppercase()}"

    companion object {
        fun of(id: String?): StepClass? = entries.firstOrNull { it.id == id }
    }
}

/** Where a step's expected model came from. */
enum class ModelFrom { SETTING, RUNTIME_YAML }

data class ExpectedModel(val stepClass: StepClass, val model: String, val from: ModelFrom)

object StepModels {
    /**
     * The kind of step an AI step command runs its drafts as (the command line's
     * stepClassOfCommand): what the hand-off text names before the step runs. A stage's critic
     * lenses are critic steps whatever the step; the command line says each run's own kind.
     */
    fun classOf(argv: List<String>): StepClass? {
        val words = argv.filter { !it.startsWith("-") }
        val group = words.getOrNull(0)
        val command = words.getOrNull(1)
        return when {
            group == "map" -> StepClass.READ
            group == "critic" -> StepClass.CRITIC
            group == "task" && command != null && command != "context" -> StepClass.DRAFT
            else -> COMMANDS["$group $command"]
        }
    }

    private val COMMANDS =
        mapOf(
            "scan verify" to StepClass.READ,
            "scan survey" to StepClass.DRAFT,
            "spec draft" to StepClass.DRAFT,
            "change feature" to StepClass.DRAFT,
            "change architecture" to StepClass.DRAFT,
            "change small" to StepClass.DRAFT,
            "change draft" to StepClass.DRAFT,
            "plan stories" to StepClass.DRAFT,
            "knowledge scan" to StepClass.KNOWLEDGE,
            "knowledge find" to StepClass.KNOWLEDGE,
            "knowledge ask" to StepClass.KNOWLEDGE,
            "change needs" to StepClass.KNOWLEDGE,
        )

    /**
     * The model a kind of step expects: the person's setting, else runtime.yaml's; null when
     * neither names one. `atticus` in a setting means runtime.yaml's.
     */
    fun expected(c: StepClass, settings: Map<StepClass, String>, orgModels: Map<String, String>): ExpectedModel? {
        val own = settings[c]?.trim().orEmpty()
        if (own.isNotEmpty() && own != "atticus") return ExpectedModel(c, own, ModelFrom.SETTING)
        val org = orgModels[c.id]?.trim().orEmpty()
        return if (org.isNotEmpty()) ExpectedModel(c, org, ModelFrom.RUNTIME_YAML) else null
    }

    /** The person's settings as the command line reads them: one variable per kind that is set. */
    fun env(settings: Map<StepClass, String>): Map<String, String> =
        settings
            .mapValues { it.value.trim() }
            .filterValues { it.isNotEmpty() && it != "atticus" }
            .mapKeys { it.key.env }
}
