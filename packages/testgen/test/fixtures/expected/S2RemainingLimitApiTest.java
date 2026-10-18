package atticus.add_transfer_limit;

import static io.restassured.RestAssured.given;
import static org.hamcrest.Matchers.*;

import io.restassured.http.ContentType;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** API tests for story s2-remaining-limit (change add-transfer-limit) on ledger-api. Base URL: ATTICUS_BASE_URL. */
class S2RemainingLimitApiTest {
  private static final String BASE_URL = env("ATTICUS_BASE_URL", "http://localhost:8080");

  @Test
  @DisplayName("GET /accounts/{id}/limit accepts a valid request")
  void getAccountsIdLimitAcceptsAValidRequest() {
    given()
        .baseUri(BASE_URL)
        .auth().oauth2(env("ATTICUS_TOKEN"))
        .pathParam("id", 1)
        .when()
        .get("/accounts/{id}/limit")
        .then()
        .statusCode(200)
        .body("$", hasKey("limit"))
        .body("$", hasKey("remaining"));
  }

  @Test
  @DisplayName("GET /accounts/{id}/limit refuses a path id that is not a number")
  void getAccountsIdLimitRefusesAPathIdThatIsNotANumber() {
    given()
        .baseUri(BASE_URL)
        .auth().oauth2(env("ATTICUS_TOKEN"))
        .pathParam("id", "abc")
        .when()
        .get("/accounts/{id}/limit")
        .then()
        .statusCode(allOf(greaterThanOrEqualTo(400), lessThan(500)));
  }

  @Test
  @DisplayName("GET /accounts/{id}/limit refuses a path id below 1")
  void getAccountsIdLimitRefusesAPathIdBelow1() {
    given()
        .baseUri(BASE_URL)
        .auth().oauth2(env("ATTICUS_TOKEN"))
        .pathParam("id", 0)
        .when()
        .get("/accounts/{id}/limit")
        .then()
        .statusCode(allOf(greaterThanOrEqualTo(400), lessThan(500)));
  }

  @Test
  @DisplayName("GET /accounts/{id}/limit answers 404: Unknown account")
  void getAccountsIdLimitAnswers404UnknownAccount() {
    // The spec documents 404: Unknown account. The request needs data in that state.
    given()
        .baseUri(BASE_URL)
        .auth().oauth2(env("ATTICUS_TOKEN"))
        .pathParam("id", 1)
        .when()
        .get("/accounts/{id}/limit")
        .then()
        .statusCode(404);
  }

  @Test
  @DisplayName("GET /accounts/{id}/limit refuses a request without credentials")
  void getAccountsIdLimitRefusesARequestWithoutCredentials() {
    given()
        .baseUri(BASE_URL)
        .pathParam("id", 1)
        .when()
        .get("/accounts/{id}/limit")
        .then()
        .statusCode(401);
  }

  @Test
  @DisplayName("GET /accounts/{id}/limit refuses a token without scope ledger.read")
  void getAccountsIdLimitRefusesATokenWithoutScopeLedgerRead() {
    Assumptions.assumeFalse(env("ATTICUS_TOKEN_WITHOUT_LEDGER_READ").isEmpty(), "Set ATTICUS_TOKEN_WITHOUT_LEDGER_READ to a token without ledger.read.");
    given()
        .baseUri(BASE_URL)
        .auth().oauth2(env("ATTICUS_TOKEN_WITHOUT_LEDGER_READ"))
        .pathParam("id", 1)
        .when()
        .get("/accounts/{id}/limit")
        .then()
        .statusCode(403);
  }

  private static String env(String name) {
    return env(name, "");
  }

  private static String env(String name, String fallback) {
    String v = System.getenv(name);
    return v == null || v.isEmpty() ? fallback : v;
  }
}
