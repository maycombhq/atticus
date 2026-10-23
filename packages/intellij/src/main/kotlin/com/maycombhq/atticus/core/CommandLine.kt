package com.maycombhq.atticus.core

import java.io.File
import java.nio.file.Files
import java.nio.file.Path

/** How to start atticus: the program, the arguments before atticus's own, and whether Windows' shell runs it. */
data class Launch(val exe: String, val prefix: List<String>, val viaShell: Boolean = false) {
    /** The whole command: the program, then [prefix], then atticus's arguments. */
    fun argv(args: List<String>): List<String> = listOf(exe) + prefix + args
}

/**
 * Running the `atticus` command line without a shell where it can be avoided (ADR 0090, 0099),
 * so arguments with spaces or quotes reach it as they are. On Windows the `atticus.cmd` that npm,
 * pnpm or the offline bundle writes is read for the `bin.js` it starts, and that runs with `node`.
 */
class CommandLine(
    private val windows: Boolean,
    private val pathDirs: List<String>,
    private val pathExt: List<String> = listOf(".EXE", ".CMD", ".BAT"),
) {
    companion object {
        /** For this machine: its PATH and PATHEXT. */
        fun forThisMachine(): CommandLine {
            val win = System.getProperty("os.name").startsWith("Windows")
            val env = System.getenv()
            val path = env["PATH"] ?: env["Path"] ?: ""
            val ext = (env["PATHEXT"] ?: ".EXE;.CMD;.BAT").split(';').filter { it.isNotBlank() }
            return CommandLine(win, path.split(File.pathSeparatorChar).filter { it.isNotBlank() }, ext)
        }

        /** Characters cmd.exe reads as its own; an argument with one can't go through the shell safely. */
        private val SHELL_UNSAFE = Regex("[\"%^&|<>!\r\n]")

        /** Why these arguments can't be run this way, or null when they can. */
        fun refusal(l: Launch, args: List<String>): String? =
            if (l.viaShell && args.any { SHELL_UNSAFE.containsMatchIn(it) }) {
                "Couldn't run this through the Windows shell safely: an argument has one of \" % ^ & | < > !. " +
                    "Set the path to atticus (Settings → Tools → Atticus) to its bin.js, for example " +
                    "C:\\…\\node_modules\\@maycombhq\\cli\\dist\\bin.js."
            } else {
                null
            }

        private fun quote(a: String) = if (Regex("^[\\w./:@=+-]+$").matches(a)) a else "\"" + a.replace(Regex("([\"\\\\$`])"), "\\\\$1") + "\""

        /** The command line as a person would type it, for the log. */
        fun text(args: List<String>): String = "atticus " + args.joinToString(" ") { quote(it) }

        private val RELATIVE_JS = Regex("\"%~?dp0%?\\\\([^\"]*?\\.[cm]?js)\"", RegexOption.IGNORE_CASE)
        private val ABSOLUTE_JS = Regex("\"((?:[A-Za-z]:\\\\|/)[^\"]*?\\.[cm]?js)\"", RegexOption.IGNORE_CASE)
    }

    private fun isFile(p: Path) = runCatching { Files.isRegularFile(p) }.getOrDefault(false)

    /** The `.js` a Windows command shim starts, when the shim is npm's, pnpm's or the offline bundle's. */
    fun shimTarget(cmdFile: Path): Path? {
        val text = runCatching { Files.readString(cmdFile) }.getOrNull() ?: return null
        val rel = RELATIVE_JS.find(text)?.groupValues?.get(1)
        val js =
            if (rel != null) {
                cmdFile.parent.resolve(rel.replace('\\', File.separatorChar)).normalize()
            } else {
                ABSOLUTE_JS.find(text)?.groupValues?.get(1)?.let { runCatching { Path.of(it) }.getOrNull() }
            }
        return js?.takeIf { isFile(it) }
    }

    private fun onPath(name: String): Path? {
        // Windows runs only a name with an extension (PATHEXT): npm's extension-less `atticus` beside
        // atticus.cmd is a shell script for Git Bash, not something to start.
        val exts = if (!windows || name.contains('.')) listOf("") + pathExt else pathExt
        for (d in pathDirs) {
            for (e in exts) {
                val f = runCatching { Path.of(d, name + e) }.getOrNull() ?: continue
                // The name as it is on disk: Windows finds atticus.EXE for atticus.exe.
                if (isFile(f)) return runCatching { f.toRealPath() }.getOrDefault(f)
            }
        }
        return null
    }

    /** How to start atticus, from the setting (empty: atticus on PATH), for a command run in [cwd]. */
    fun resolve(setting: String, cwd: String, node: String = "node"): Launch {
        val p = setting.trim().ifEmpty { "atticus" }
        val hasDir = p.contains('/') || p.contains('\\')
        val full = { runCatching { Path.of(cwd).resolve(p).normalize() }.getOrNull() }
        if (Regex("\\.[cm]?js$", RegexOption.IGNORE_CASE).containsMatchIn(p)) {
            return Launch(node, listOf((full() ?: Path.of(p)).toString()))
        }
        if (!windows) return Launch(if (hasDir && !p.startsWith("/")) (full()?.toString() ?: p) else p, emptyList())
        val found = if (hasDir) full()?.takeIf { isFile(it) } else onPath(p)
        val name = found?.fileName?.toString()?.lowercase() ?: return Launch(p, emptyList())
        if (name.endsWith(".cmd") || name.endsWith(".bat")) {
            val js = shimTarget(found) ?: return Launch(found.toString(), emptyList(), viaShell = true)
            val beside = found.parent.resolve("node.exe")
            return Launch(if (isFile(beside)) beside.toString() else node, listOf(js.toString()))
        }
        return Launch(found.toString(), emptyList())
    }
}
