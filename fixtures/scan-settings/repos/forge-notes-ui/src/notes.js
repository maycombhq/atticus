// The notes screen: lists notes and adds one.
export async function listNotes() {
  const r = await fetch("https://notes.forge.internal/notes-api/notes");
  return r.json();
}

export async function addNote(text) {
  const r = await fetch("https://notes.forge.internal/notes-api/notes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  return r.json();
}
