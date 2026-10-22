package com.maycombhq.atticus.ide

import com.intellij.openapi.components.BaseState
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.SimplePersistentStateComponent
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.service
import com.intellij.openapi.options.BoundConfigurable
import com.intellij.openapi.ui.DialogPanel
import com.intellij.ui.dsl.builder.AlignX
import com.intellij.ui.dsl.builder.bindSelected
import com.intellij.ui.dsl.builder.bindText
import com.intellij.ui.dsl.builder.panel
import com.maycombhq.atticus.core.Copy

/** The plugin's settings (Settings → Tools → Atticus), kept for the IDE, not per project. */
@Service(Service.Level.APP)
@State(name = "AtticusSettings", storages = [Storage("atticus.xml")])
class AtticusSettings : SimplePersistentStateComponent<AtticusSettings.Values>(Values()) {
    class Values : BaseState() {
        /** Empty: atticus on PATH. */
        var atticusPath by string("")
        var showDeveloperCommands by property(false)
    }

    companion object {
        fun get(): AtticusSettings = service()
    }
}

class AtticusConfigurable : BoundConfigurable("Atticus") {
    override fun createPanel(): DialogPanel {
        val s = AtticusSettings.get().state
        return panel {
            row(Copy.SETTINGS_PATH) {
                textField()
                    .align(AlignX.FILL)
                    .bindText({ s.atticusPath ?: "" }, { s.atticusPath = it.trim() })
                    .comment(Copy.SETTINGS_PATH_HINT)
            }
            row {
                checkBox(Copy.SETTINGS_DEVELOPER).bindSelected({ s.showDeveloperCommands }, { s.showDeveloperCommands = it })
            }
        }
    }
}
