package forge.notes;

import forge.anvil.Anvil;
import forge.anvil.AnvilService;

@AnvilService("/notes")
public class NoteRoutes {

  @Anvil.Get("")
  public NoteList list() {
    return store.all();
  }

  @Anvil.Get("/{id}")
  public Note one(String id) {
    return store.get(id);
  }

  @Anvil.Post("")
  public Note add(Note note) {
    return store.add(note);
  }
}
