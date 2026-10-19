package org.springframework.web.client;

import org.springframework.http.HttpMethod;
import org.springframework.http.ResponseEntity;

/** A stand-in with the same name, so the fixture starter compiles without Spring's JARs. */
public class RestTemplate {
  public <T> ResponseEntity<T> exchange(String url, HttpMethod method, Object entity, Class<T> type) {
    return null;
  }

  public <T> T getForObject(String url, Class<T> type) {
    return null;
  }
}
