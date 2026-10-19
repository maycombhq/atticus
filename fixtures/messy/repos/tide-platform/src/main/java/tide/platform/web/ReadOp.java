package tide.platform.web;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;
import org.springframework.core.annotation.AliasFor;

/** A read operation: an @Op that is always a GET (a house annotation built on another). */
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
@Op(verb = "GET")
public @interface ReadOp {
  @AliasFor(annotation = Op.class, attribute = "path")
  String value() default "";
}
