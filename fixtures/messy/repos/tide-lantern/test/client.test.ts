import { lantern } from "../src/client";
// A test calling the client is not part of the framework's API.
lantern.call("nope", "GET", "/nope");
