// A sample a developer wrote to try the API by hand.
export async function demo() {
  const r = await fetch("https://tasks.forge.internal/tasks-api/tasks");
  return r.json();
}
