package harbor.kit.http;

import java.util.Properties;

/** Looks a system's base URL up in harbor-systems.properties. */
public class SystemDirectory {
  private final Properties urls;

  public SystemDirectory(Properties urls) {
    this.urls = urls;
  }

  public String url(String system) {
    return urls.getProperty("harbor.systems." + system + ".url");
  }
}
