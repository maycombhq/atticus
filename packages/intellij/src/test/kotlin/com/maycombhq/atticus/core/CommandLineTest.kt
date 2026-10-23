package com.maycombhq.atticus.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path

/**
 * How the plugin starts `atticus` (ADR 0090, 0099): never through a shell when it can be avoided,
 * so an argument with spaces or quotes reaches atticus as it is.
 */
class CommandLineTest {
    @TempDir
    lateinit var dir: Path

    private fun write(rel: String, text: String = ""): Path {
        val p = dir.resolve(rel)
        Files.createDirectories(p.parent)
        Files.writeString(p, text)
        return p
    }

    private fun windows(vararg pathDirs: Path) =
        CommandLine(windows = true, pathDirs = pathDirs.map { it.toString() }, pathExt = listOf(".COM", ".EXE", ".BAT", ".CMD"))

    @Test
    fun `reads the bin js out of npm's command shim and runs it with node`() {
        val js = write("npm/node_modules/@maycombhq/cli/dist/bin.js")
        write(
            "npm/atticus.cmd",
            "@ECHO off\r\nGOTO start\r\n:start\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\@maycombhq\\cli\\dist\\bin.js\" %*\r\n",
        )
        val l = windows(dir.resolve("empty"), dir.resolve("npm")).resolve("atticus", dir.toString())
        assertEquals(Launch("node", listOf(js.toString())), l)
    }

    @Test
    fun `skips npm's shell script for Git Bash beside the cmd shim, as Windows does`() {
        val js = write("npm/node_modules/@maycombhq/cli/dist/bin.js")
        // npm writes three: atticus (for sh), atticus.cmd and atticus.ps1.
        write("npm/atticus", "#!/bin/sh\nexec node \"\$basedir/node_modules/@maycombhq/cli/dist/bin.js\" \"\$@\"\n")
        write("npm/atticus.ps1", "#!/usr/bin/env pwsh\n")
        write("npm/atticus.cmd", "@ECHO off\r\n\"%_prog%\"  \"%dp0%\\node_modules\\@maycombhq\\cli\\dist\\bin.js\" %*\r\n")
        val l = windows(dir.resolve("npm")).resolve("atticus", dir.toString())
        assertEquals(Launch("node", listOf(js.toString())), l)
    }

    @Test
    fun `reads pnpm's shim, and uses the node beside the shim when there is one`() {
        val js = write("pn/node_modules/@maycombhq/cli/dist/bin.js")
        val node = write("pn/node.exe")
        write("pn/atticus.CMD", "@IF EXIST \"%~dp0\\node.exe\" (\r\n  \"%~dp0\\node.exe\"  \"%~dp0\\node_modules\\@maycombhq\\cli\\dist\\bin.js\" %*\r\n)\r\n")
        val l = windows(dir.resolve("pn")).resolve("atticus", dir.toString())
        assertEquals(Launch(node.toString(), listOf(js.toString())), l)
    }

    @Test
    fun `reads the offline bundle's shim, which names its bin js in full`() {
        val js = write("Atticus/1.0.0/dist/bin.js")
        write("Atticus/bin/atticus.cmd", "@node \"$js\" %*\r\n")
        val l = windows(dir.resolve("Atticus/bin")).resolve("atticus", dir.toString())
        assertEquals(Launch("node", listOf(js.toString())), l)
    }

    @Test
    fun `a shim it can't read goes through the shell, and only safe arguments are let through`() {
        val cmd = write("odd/atticus.bat", "@echo hi\r\n")
        val l = windows(dir.resolve("odd")).resolve("atticus", dir.toString())
        assertEquals(Launch(cmd.toString(), emptyList(), viaShell = true), l)
        assertNull(CommandLine.refusal(l, listOf("scan", "forge web")))
        assertTrue(CommandLine.refusal(l, listOf("change", "new", "Say \"hi\"")) != null)
        assertTrue(CommandLine.refusal(l, listOf("a&b")) != null)
        assertNull(CommandLine.refusal(Launch("node", listOf("x.js")), listOf("a&b \"c\"")))
    }

    @Test
    fun `an exe runs as it is, a js runs with node, a full path is used as given`() {
        val exe = write("bin/atticus.exe")
        assertEquals(Launch(exe.toString(), emptyList()), windows(dir.resolve("bin")).resolve("atticus", dir.toString()))
        assertEquals(Launch(exe.toString(), emptyList()), windows().resolve(exe.toString(), dir.toString()))
        val js = write("tools/bin.js")
        assertEquals(Launch("node", listOf(js.toString())), windows().resolve("tools/bin.js", dir.toString()))
        assertEquals(Launch("node", listOf(js.toString())), CommandLine(windows = false, pathDirs = emptyList()).resolve(js.toString(), dir.toString()))
    }

    @Test
    fun `on Linux and macOS atticus is run as it is, and an empty setting means atticus on PATH`() {
        val unix = CommandLine(windows = false, pathDirs = emptyList())
        assertEquals(Launch("atticus", emptyList()), unix.resolve("", "/m"))
        assertEquals(Launch("/opt/atticus/bin/atticus", emptyList()), unix.resolve("/opt/atticus/bin/atticus", "/m"))
    }

    @Test
    fun `not found on PATH is tried as it is, so starting it says it is missing`() {
        val l = windows(dir.resolve("nothing")).resolve("atticus", dir.toString())
        assertEquals(Launch("atticus", emptyList()), l)
        assertFalse(l.viaShell)
    }

    @Test
    fun `the command line as a person would type it`() {
        assertEquals("atticus change new \"Tag notes\" --type feature", CommandLine.text(listOf("change", "new", "Tag notes", "--type", "feature")))
        assertEquals("atticus scan --root C:/m", CommandLine.text(listOf("scan", "--root", "C:/m")))
        assertEquals("atticus say \"a \\\"b\\\"\"", CommandLine.text(listOf("say", "a \"b\"")))
    }
}
