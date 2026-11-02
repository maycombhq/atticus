package forge.accounts.api;

/** The envelope every forge-accounts response shares. */
public class Response<T> {
  private T data;
  private String traceId;

  public static <T> Response<T> of(T data) {
    Response<T> r = new Response<>();
    r.data = data;
    return r;
  }
}
