package forge.tasks;

import forge.web.ForgeRoute;

/** Archived tasks, served through the Forge web framework's own routing. */
public class ArchiveHandler {

  @ForgeRoute(method = "GET", path = "/tasks/archive")
  public String archived() {
    return "[]";
  }
}
