package com.maycombhq.atticus.ide

import com.intellij.openapi.fileChooser.FileChooser
import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.ui.ValidationInfo
import com.intellij.openapi.util.text.StringUtil
import com.intellij.ui.CollectionListModel
import com.intellij.ui.DocumentAdapter
import com.intellij.ui.DoubleClickListener
import com.intellij.ui.SearchTextField
import com.intellij.ui.components.JBList
import com.intellij.ui.components.JBRadioButton
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
import com.maycombhq.atticus.core.OpenQuestion
import java.awt.Dimension
import java.awt.Font
import java.awt.event.KeyAdapter
import java.awt.event.KeyEvent
import java.awt.event.MouseEvent
import java.nio.file.Path
import javax.swing.Action
import javax.swing.ButtonGroup
import javax.swing.ListSelectionModel
import javax.swing.event.DocumentEvent
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

/**
 * One value from a list, found by typing (WP6: a searchable list, not a combo box). With
 * [typed], what was typed counts when nothing in the list matches.
 */
class PickDialog(
    project: Project,
    dialogTitle: String,
    private val message: String,
    private val items: List<String>,
    private val typed: Boolean = true,
) : DialogWrapper(project) {
    private val search = SearchTextField(false)
    private val model = CollectionListModel(items)
    private val list = JBList(model).apply { selectionMode = ListSelectionModel.SINGLE_SELECTION }

    init {
        title = dialogTitle
        if (items.isNotEmpty()) list.selectedIndex = 0
        search.addDocumentListener(
            object : DocumentAdapter() {
                override fun textChanged(e: DocumentEvent) {
                    val q = search.text.trim()
                    model.replaceAll(items.filter { it.contains(q, ignoreCase = true) })
                    if (model.size > 0) list.selectedIndex = 0
                }
            },
        )
        object : DoubleClickListener() {
            override fun onDoubleClick(event: MouseEvent): Boolean {
                if (list.selectedValue == null) return false
                doOKAction()
                return true
            }
        }.installOn(list)
        // Up and down in the search box move in the list, as in a speed search.
        search.textEditor.addKeyListener(
            object : KeyAdapter() {
                override fun keyPressed(e: KeyEvent) {
                    val i = list.selectedIndex
                    when (e.keyCode) {
                        KeyEvent.VK_DOWN -> if (i < model.size - 1) list.selectedIndex = i + 1
                        KeyEvent.VK_UP -> if (i > 0) list.selectedIndex = i - 1
                        else -> return
                    }
                    list.ensureIndexIsVisible(list.selectedIndex)
                    e.consume()
                }
            },
        )
        init()
    }

    override fun getPreferredFocusedComponent(): JComponent = search

    override fun createCenterPanel(): JComponent =
        panel {
            row { label(message) }
            row { cell(search).align(AlignX.FILL) }
            row {
                cell(JBScrollPane(list).apply { preferredSize = Dimension(JBUI.scale(560), JBUI.scale(300)) }).align(AlignX.FILL)
            }
        }

    /** The value picked, or what was typed when nothing matches and typing is allowed. */
    fun value(): String? = list.selectedValue ?: search.text.trim().takeIf { typed && it.isNotEmpty() }
}

/**
 * A question, answered here (WP6.2): its choices with what each means, or the person's own
 * words, beside the lines it read. Nothing is answered for the person.
 */
class AnswerDialog(project: Project, private val q: OpenQuestion) : DialogWrapper(project) {
    private val group = ButtonGroup()
    private val choices = q.options.map { JBRadioButton(it.label) }
    private val own = JBRadioButton(Copy.ANSWER_OWN_WORDS)
    private val words = JBTextArea(3, 60).apply { lineWrap = true; wrapStyleWord = true }

    init {
        title = Copy.ANSWER_TITLE
        (choices + own).forEach { group.add(it) }
        if (choices.isEmpty()) own.isSelected = true
        words.addFocusListener(
            object : java.awt.event.FocusAdapter() {
                override fun focusGained(e: java.awt.event.FocusEvent) {
                    own.isSelected = true
                }
            },
        )
        init()
    }

    override fun createCenterPanel(): JComponent =
        panel {
            row { text("<b>${StringUtil.escapeXmlEntities(q.question)}</b>", maxLineLength = 90) }
            row { comment(q.repo) }
            for ((i, b) in choices.withIndex()) {
                row { cell(b).comment(q.options[i].means.takeIf { it.isNotBlank() }) }
            }
            row { cell(own) }
            row { cell(JBScrollPane(words)).align(AlignX.FILL) }
            if (q.evidence.isNotEmpty()) {
                row { label(Copy.ANSWER_IT_READ) }
                for (e in q.evidence.take(8)) row { comment(StringUtil.escapeXmlEntities(e)) }
            }
        }

    override fun doValidate(): ValidationInfo? =
        when {
            choices.none { it.isSelected } && !own.isSelected -> ValidationInfo(Copy.ANSWER_PICK)
            own.isSelected && words.text.isBlank() -> ValidationInfo(Copy.ANSWER_PICK, words)
            else -> null
        }

    /** The option picked, from 1; null for own words. */
    fun option(): Int? = choices.indexOfFirst { it.isSelected }.takeIf { it >= 0 }?.plus(1)

    fun text(): String? = if (own.isSelected) words.text.trim() else null
}
