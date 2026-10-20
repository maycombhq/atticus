package harbor.kit.web;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;
import org.springframework.core.annotation.AliasFor;
import org.springframework.web.bind.annotation.GetMapping;

/** A read operation: always a GET. */
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
@GetMapping
public @interface Fetch {
  @AliasFor(annotation = GetMapping.class, attribute = "path")
  String value() default "";
}
