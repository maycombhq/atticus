// The notes web app: no Java, so the Anvil plugins don't apply to it.
export async function note(id) {
  const res = await fetch(`https://notes.forge.internal/notes/${id}`);
  return res.json();
}
