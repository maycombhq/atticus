package forge.studio;

public class Note {
  private String id;
  private String body;
  private String summary;

  public String getId() { return id; }
  public String getBody() { return body; }
  public String getSummary() { return summary; }
  public void setSummary(String summary) { this.summary = summary; }
}
