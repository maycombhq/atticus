package forge.desk.parcels.model.response;

public class Stamp {
  public enum DepotEnum { NORTH, SOUTH, EAST }

  private DepotEnum depot = null;

  private String stampedAt;

  private String clerk;

  private String lane;
}
