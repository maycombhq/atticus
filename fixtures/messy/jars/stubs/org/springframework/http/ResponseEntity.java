package org.springframework.http;

/** A stand-in with the same name, so the fixture starter compiles without Spring's JARs. */
public class ResponseEntity<T> {
  public T getBody() {
    return null;
  }
}
