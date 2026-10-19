package org.springframework.http;

/** A stand-in with the same name, so the fixture starter compiles without Spring's JARs. */
public final class HttpMethod {
  public static HttpMethod valueOf(String name) {
    return new HttpMethod();
  }
}
