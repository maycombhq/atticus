package forge.accounts.api;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestControllerAdvice;

@RestControllerAdvice
public class AccountErrors {
  @ExceptionHandler(AccountNotFound.class)
  @ResponseStatus(HttpStatus.NOT_FOUND) // 404
  void notFound() {}

  @ExceptionHandler(AccountFrozen.class)
  @ResponseStatus(HttpStatus.LOCKED) // 423
  void frozen() {}
}
