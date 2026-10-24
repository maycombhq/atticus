package forge.boards;

/** A board of pins. Old boards go to BoardArchiver one day; nothing declares it yet. */
public class PinBoard {
  private final BoardService service;

  public PinBoard(BoardService service) {
    this.service = service;
  }
}
