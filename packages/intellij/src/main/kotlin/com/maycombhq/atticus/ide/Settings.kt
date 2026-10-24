package com.maycombhq.atticus.ide

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.components.BaseState
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.SimplePersistentStateComponent
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.service
import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.openapi.options.BoundConfigurable
import com.intellij.openapi.ui.DialogPanel
import com.intellij.openapi.ui.TextFieldWithBrowseButton
import com.intellij.ui.components.JBLabel
import com.intellij.ui.dsl.builder.AlignX
import com.intellij.ui.dsl.builder.bindSelected
import com.intellij.ui.dsl.builder.bindText
import com.intellij.ui.dsl.builder.panel
import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.execution.process.CapturingProcessHandler
import com.maycombhq.atticus.core.Copy
import java.nio.charset.StandardCharsets

/** The plugin's settings (Settings → Tools → Atticus), kept for the IDE, not per project. */
@Service(Service.Level.APP)
@State(name = "AtticusSettings", storages = [Storage("atticus.xml")])
class AtticusSettings : SimplePersistentStateComponent<AtticusSettings.Values>(Values()) {
    class Values : BaseState() {
        /** Empty: atticus on PATH. */
        var atticusPath by string("")
        var showDeveloperCommands by property(false)

        /** The person said not to be told again that the command line is missing (WP6.2). */
        var hideCliMissing by property(false)
    }

    companion object {
        fun get(): AtticusSettings = service()
    }
}

class AtticusConfigurable : BoundConfigurable("Atticus") {
    override fun createPanel(): DialogPanel {
        val s = AtticusSettings.get().state
        val path =
            TextFieldWithBrowseButton().apply {
                addBrowseFolderListener(null, FileChooserDescriptorFactory.createSingleFileDescriptor())
            }
        val result = JBLabel()
        return panel {
            row(Copy.SETTINGS_PATH) {
                cell(path)
                    .align(AlignX.FILL)
                    .resizableColumn()
                    .bindText({ s.atticusPath ?: "" }, { s.atticusPath = it.trim() })
                    .comment(Copy.SETTINGS_PATH_HINT)
                // WP6.2: try the path as typed, before it is saved.
                button(Copy.SETTINGS_CHECK) { check(path.text.trim(), result) }
            }
            row { cell(result) }
            row {
                checkBox(Copy.SETTINGS_DEVELOPER).bindSelected({ s.showDeveloperCommands }, { s.showDeveloperCommands = it })
            }
            row {
                checkBox(Copy.SETTINGS_CLI_NOTICE).bindSelected({ !s.hideCliMissing }, { s.hideCliMissing = !it })
            }
        }
    }

    private fun check(path: String, result: JBLabel) {
        result.text = Copy.CHECKING
        ApplicationManager.getApplication().executeOnPooledThread {
            val cwd = System.getProperty("user.home")
            val text =
                runCatching {
                    val l = AtticusCli.machineFor(path, cwd)
                    val out = CapturingProcessHandler(GeneralCommandLine(l.argv(listOf("--version"))).withCharset(StandardCharsets.UTF_8)).runProcess(60_000)
                    if (out.exitCode == 0) Copy.settingsChecked(out.stdout.trim().lines().firstOrNull().orEmpty()) else Copy.settingsCheckFailed(out.stderr.trim().lines().firstOrNull() ?: "exit ${out.exitCode}")
                }.getOrElse { Copy.settingsCheckFailed(it.message ?: "") }
            ApplicationManager.getApplication().invokeLater({ result.text = text }, ModalityState.any())
        }
    }
}
