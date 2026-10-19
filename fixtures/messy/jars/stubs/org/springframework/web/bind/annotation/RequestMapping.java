package org.springframework.web.bind.annotation;

import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;

/** A stand-in with the same name, so the fixture starter compiles without Spring's JARs. */
@Retention(RetentionPolicy.RUNTIME)
public @interface RequestMapping {
  String[] value() default {};

  String[] path() default {};

  String[] method() default {};
}
