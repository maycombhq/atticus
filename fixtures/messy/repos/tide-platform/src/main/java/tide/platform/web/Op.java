package tide.platform.web;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;
import org.springframework.core.annotation.AliasFor;
import org.springframework.web.bind.annotation.RequestMapping;

/** One operation of an internal API. */
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
@RequestMapping
public @interface Op {
  @AliasFor(annotation = RequestMapping.class, attribute = "method")
  String verb();

  @AliasFor(annotation = RequestMapping.class, attribute = "path")
  String path() default "";
}
