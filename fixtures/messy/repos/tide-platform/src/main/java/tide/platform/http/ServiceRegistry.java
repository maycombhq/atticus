package tide.platform.http;

/** Finds a service's base URL from its id (in real life, from config or a registry). */
public interface ServiceRegistry {
  String url(String service);
}
