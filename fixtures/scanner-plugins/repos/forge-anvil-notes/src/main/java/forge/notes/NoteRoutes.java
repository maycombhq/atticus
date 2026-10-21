package forge.notes;

import forge.anvil.Anvil;
import forge.anvil.AnvilService;

@AnvilService("/notes")
public class NoteRoutes {

  @Anvil.Get("/{id}")
  public Note one(String id) {
    return store.get(id);
  }

  @Anvil.Delete("/{id}")
  public void remove(String id) {
    store.remove(id);
  }
}
