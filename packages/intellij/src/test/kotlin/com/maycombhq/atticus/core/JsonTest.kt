package com.maycombhq.atticus.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

/** The small JSON reader the plugin uses for `atticus … --json` (no library needed). */
class JsonTest {
    @Test
    fun `reads objects, lists, strings, numbers, true, false and null`() {
        val v = Json.parse("""{"a": [1, 2.5, -3e2], "b": "x\"y\\z\né", "c": true, "d": false, "e": null}""")
        assertEquals(
            mapOf(
                "a" to listOf(1L, 2.5, -300.0),
                "b" to "x\"y\\z\né",
                "c" to true,
                "d" to false,
                "e" to null,
            ),
            v,
        )
    }

    @Test
    fun `keeps the order of an object's keys`() {
        val v = Json.parse("""{"z": 1, "a": 2, "m": 3}""") as Map<*, *>
        assertEquals(listOf("z", "a", "m"), v.keys.toList())
    }

    @Test
    fun `fails on text that isn't JSON`() {
        assertThrows<IllegalArgumentException> { Json.parse("{\"a\": }") }
        assertThrows<IllegalArgumentException> { Json.parse("[1, 2") }
        assertThrows<IllegalArgumentException> { Json.parse("{} extra") }
    }

    @Test
    fun `finds the one object a command printed among other lines`() {
        assertEquals(mapOf("ok" to true), Json.objectIn("Reading…\n{\"ok\": true}\nDone."))
        assertNull(Json.objectIn("No JSON here"))
        assertNull(Json.objectIn(""))
    }
}
