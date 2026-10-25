# Relative calls (ADR 0124 addendum C-join, the join fallback)

The invented forge-notes repo holds a single-page app (component `forge-notes-web`) and the API
it calls (component `forge-notes`, named after the repo). The app's calls are relative
(`fetch("/api/notes/" + id)`), so the reader guessed their target as `notes-service`, a name
that is no component of the catalog. forge-archive is a second repo with two components.

What `joinEstate` should do with each call-out of `forge-notes-web.open-note`:

1. `GET /api/notes/{id}`: forge-notes (the caller's own repo) and forge-archive both serve it;
   the caller's own repo comes first, so it joins `forge-notes.get-note`, inferred.
2. `GET /api/tags`: nothing in forge-notes serves it; one component of the estate does, so it
   joins `forge-archive.list-tags`, inferred.
3. `GET /api/archive/{id}`: two components of forge-archive serve it, so it isn't joined: a
   person is asked which.
4. A loose end (`unresolved.c-save-note`, a call that named no target): `POST /api/notes` is
   served only by forge-notes, so it joins `forge-notes.create-note`, inferred.

`expected/estate.yaml` is what `atticus estate join` writes, by hand before the code.
