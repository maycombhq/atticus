package com.maycombhq.atticus.core

/**
 * A small JSON reader for what `atticus … --json` prints. Objects are maps that keep their key
 * order, lists are lists, whole numbers are Long and the rest Double. No library is needed, so
 * the plugin's logic is tested without the IDE.
 */
object Json {
    fun parse(text: String): Any? {
        val r = Reader(text)
        r.space()
        val v = r.value()
        r.space()
        if (!r.done()) r.fail("more after the end")
        return v
    }

    /** The one JSON object (or list) a command printed, or null when it printed none. */
    fun objectIn(stdout: String): Any? {
        val text = stdout.trim()
        if (text.isEmpty()) return null
        runCatching { return parse(text) }
        for ((open, close) in listOf('{' to '}', '[' to ']')) {
            val a = text.indexOf(open)
            val b = text.lastIndexOf(close)
            if (a in 0 until b) runCatching { return parse(text.substring(a, b + 1)) }
        }
        return null
    }

    private class Reader(val s: String) {
        var i = 0

        fun done() = i >= s.length

        fun fail(why: String): Nothing = throw IllegalArgumentException("Not JSON at $i: $why")

        fun space() {
            while (i < s.length && s[i].isWhitespace()) i++
        }

        fun value(): Any? {
            if (done()) fail("ended early")
            return when (val c = s[i]) {
                '{' -> obj()
                '[' -> list()
                '"' -> string()
                't' -> word("true", true)
                'f' -> word("false", false)
                'n' -> word("null", null)
                else -> if (c == '-' || c.isDigit()) number() else fail("unexpected '$c'")
            }
        }

        fun word(w: String, v: Any?): Any? {
            if (!s.startsWith(w, i)) fail("expected $w")
            i += w.length
            return v
        }

        fun obj(): Map<String, Any?> {
            val out = LinkedHashMap<String, Any?>()
            i++
            space()
            if (i < s.length && s[i] == '}') {
                i++
                return out
            }
            while (true) {
                space()
                if (done() || s[i] != '"') fail("expected a key")
                val k = string()
                space()
                if (done() || s[i] != ':') fail("expected ':'")
                i++
                space()
                out[k] = value()
                space()
                if (done()) fail("ended in an object")
                when (s[i++]) {
                    ',' -> continue
                    '}' -> return out
                    else -> fail("expected ',' or '}'")
                }
            }
        }

        fun list(): List<Any?> {
            val out = ArrayList<Any?>()
            i++
            space()
            if (i < s.length && s[i] == ']') {
                i++
                return out
            }
            while (true) {
                space()
                out.add(value())
                space()
                if (done()) fail("ended in a list")
                when (s[i++]) {
                    ',' -> continue
                    ']' -> return out
                    else -> fail("expected ',' or ']'")
                }
            }
        }

        fun string(): String {
            val b = StringBuilder()
            i++
            while (true) {
                if (done()) fail("ended in a string")
                val c = s[i++]
                when (c) {
                    '"' -> return b.toString()
                    '\\' -> {
                        if (done()) fail("ended in a string")
                        when (val e = s[i++]) {
                            '"', '\\', '/' -> b.append(e)
                            'b' -> b.append('\b')
                            'f' -> b.append('\u000C')
                            'n' -> b.append('\n')
                            'r' -> b.append('\r')
                            't' -> b.append('\t')
                            'u' -> {
                                if (i + 4 > s.length) fail("short \\u")
                                b.append(s.substring(i, i + 4).toIntOrNull(16)?.toChar() ?: fail("bad \\u"))
                                i += 4
                            }
                            else -> fail("bad escape \\$e")
                        }
                    }
                    else -> b.append(c)
                }
            }
        }

        fun number(): Any {
            val start = i
            if (s[i] == '-') i++
            while (i < s.length && (s[i].isDigit() || s[i] in ".eE+-")) i++
            val t = s.substring(start, i)
            val whole = t.none { it in ".eE" }
            return (if (whole) t.toLongOrNull() else t.toDoubleOrNull()) ?: fail("bad number $t")
        }
    }
}

/** Reading fields of a parsed JSON object without casts everywhere. */
internal fun Any?.obj(): Map<*, *>? = this as? Map<*, *>

internal fun Map<*, *>.str(key: String): String? = this[key] as? String

internal fun Map<*, *>.bool(key: String): Boolean = this[key] == true

internal fun Map<*, *>.objs(key: String): List<Map<*, *>> = (this[key] as? List<*>)?.mapNotNull { it.obj() } ?: emptyList()

internal fun Map<*, *>.strs(key: String): List<String>? = (this[key] as? List<*>)?.mapNotNull { it as? String }
