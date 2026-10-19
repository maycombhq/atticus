package org.springframework.core.annotation;

import java.lang.annotation.Annotation;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/** A stand-in with the same name, so the fixture starter compiles without Spring's JARs. */
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
public @interface AliasFor {
  String value() default "";

  String attribute() default "";

  Class<? extends Annotation> annotation() default Annotation.class;
}
