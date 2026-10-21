import { http, HttpResponse } from "msw";
import { env } from "@/config/env";

// A fake server for tests: these declare responses, they don't make calls.
export const handlers = [
  http.get(`${env.API_URL}/notes/:noteId/comments`, () => HttpResponse.json([])),
  http.post("/notes/:noteId/comments", () => HttpResponse.json({})),
];
