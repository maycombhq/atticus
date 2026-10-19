import { defineRoute, router } from "@tide/lantern/server";
import { statementFor, raise } from "./handlers";

// Lantern's BFF routes: no Express here, Lantern registers them.
defineRoute({ method: "GET", path: "/statements/:id", handler: statementFor });
router.route("POST", "/limits", raise);
