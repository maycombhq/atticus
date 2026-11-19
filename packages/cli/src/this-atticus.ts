import { atticusHooks } from "@maycombhq/scanner";
import { VERSION } from "./version.js";

/**
 * ADR 0202 point 7: the scanner is told this Atticus's version, so the Atticus a newer
 * build.json names is used only when it is newer than this one. Loaded once, for its effect, by
 * `main` before a command runs.
 */
atticusHooks.version = VERSION;
