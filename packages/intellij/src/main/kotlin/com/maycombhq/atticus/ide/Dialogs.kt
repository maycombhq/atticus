package com.maycombhq.atticus.ide

import com.intellij.openapi.fileChooser.FileChooser
import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.ui.components.JBTextField
import com.intellij.ui.dsl.builder.AlignX
import com.intellij.ui.dsl.builder.panel
import com.intellij.ui.dsl.builder.selected
import com.intellij.util.ui.JBUI
import com.maycombhq.atticus.core.CatalogFlag
import com.maycombhq.atticus.core.Copy
import java.awt.Dimension
import java.awt.Font
import java.nio.file.Path
import javax.swing.Action
import javax.swing.JComponent

/** The options a person may add to a command: one check box each, with its value when it takes one. */
class OptionsDialog(project: Project, private val commandId: String, private val options: List<CatalogFlag>) : DialogWrapper(project) {
    private val boxes = mutableListOf<Pair<CatalogFlag, Pair<JBCheckBox, JBTextField?>>>()

    init {
        title = "atticus $commandId: ${Copy.OPTIONS_TITLE}"
        init()
    }

    override fun createCenterPanel(): JComponent =
        panel {
            for (f in options) {
                row {
                    val box = checkBox(f.name)
                    f.summary?.let { box.comment(it) }
                    val field =
                        if (f.value != null) {
                            textField().enabledIf(box.selected).applyToComponent { emptyText.text = "for example ${f.value}" }.component
                        } else {
                            null
                        }
                    boxes += f to (box.component to field)
                }
            }
        }

    /** Option → its value, or null for a switch. */
    fun chosen(): LinkedHashMap<String, String?> {
        val out = LinkedHashMap<String, String?>()
        for ((f, c) in boxes) {
            val (box, field) = c
            if (!box.isSelected) continue
            if (field == null) {
                out[f.name] = null
            } else {
                field.text.trim().takeIf { it.isNotEmpty() }?.let { out[f.name] = it }
            }
        }
        return out
    }
}

/** A shared write: what the dry run said, and the person's yes before it runs for real. */
class ApproveDialog(project: Project, private val command: String, private val dry: Ran) : DialogWrapper(project) {
    init {
        title = Copy.APPROVE_TITLE
        if (dry.ok) {
            setOKButtonText(Copy.APPROVE)
            setCancelButtonText(Copy.CANCEL)
        } else {
            setCancelButtonText(Copy.CLOSE)
        }
        init()
    }

    override fun createActions(): Array<Action> = if (dry.ok) arrayOf(okAction, cancelAction) else arrayOf(cancelAction)

    override fun createCenterPanel(): JComponent {
        val area =
            JBTextArea(dry.lines.takeLast(200).joinToString("\n").ifEmpty { "(nothing)" }).apply {
                isEditable = false
                font = Font(Font.MONOSPACED, Font.PLAIN, font.size)
                border = JBUI.Borders.empty(6)
            }
        val scroll = JBScrollPane(area).apply { preferredSize = Dimension(JBUI.scale(640), JBUI.scale(280)) }
        return panel {
            row { text(if (dry.ok) Copy.approveWhat(command) else Copy.DRY_RUN_FAILED, maxLineLength = 90) }
            row { label(Copy.DRY_RUN_SAYS) }
            row { cell(scroll).align(AlignX.FILL) }
        }
    }
}

/** A file or folder: typed, or picked with Choose…; a folder that doesn't exist yet can be typed. */
class PathDialog(
    private val project: Project,
    dialogTitle: String,
    private val prompt: String,
    private val folder: Boolean,
    initial: String,
) : DialogWrapper(project) {
    private val field = JBTextField(initial)

    init {
        title = dialogTitle
        init()
    }

    override fun getPreferredFocusedComponent(): JComponent = field

    override fun createCenterPanel(): JComponent =
        panel {
            row { label(prompt) }
            row {
                cell(field).align(AlignX.FILL).resizableColumn()
                button("Choose…") {
                    val d =
                        if (folder) {
                            FileChooserDescriptorFactory.createSingleFolderDescriptor()
                        } else {
                            FileChooserDescriptorFactory.createSingleFileOrFolderDescriptor()
                        }
                    val start = runCatching { LocalFileSystem.getInstance().findFileByNioFile(Path.of(field.text.trim())) }.getOrNull()
                    FileChooser.chooseFile(d, project, start)?.let { field.text = it.toNioPath().toString() }
                }
            }
        }.apply { preferredSize = Dimension(JBUI.scale(560), preferredSize.height) }

    fun path(): String = field.text.trim()
}
