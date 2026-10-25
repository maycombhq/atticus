package forge.orders.ai;

import java.time.Duration;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

/**
 * Calls Northwind Models for the assistant's text and keeps the month's spend: it reserves the
 * spend before the call and settles it with what the call cost.
 */
@Component
public class AssistantClient {
  private final RestClient http;
  private final SpendLedger spend;

  public AssistantClient(RestClient http, SpendLedger spend) {
    this.http = http;
    this.spend = spend;
  }

  /** What the model wrote, with what it cites, and what the call cost. */
  public record Completion(String text, List<String> citations, long costCents) {}

  /** Reserves the spend, calls the model and settles the spend. */
  public Completion complete(String prompt, int maxCents) {
    String requestId = UUID.randomUUID().toString();
    // the month's budget: reserve before the call
    boolean reserved = spend.reserve(requestId, maxCents);
    if (!reserved)
      throw new BudgetSpentException("the assistant's budget is spent");
    Completion done;
    try {
      done =
          http
              .post()
              .uri("/v1/completions")
              .body(new Request(prompt))
              .retrieve()
              .body(Completion.class);
    } catch (RuntimeException e) {
      throw e;
    }
    spend.settle(requestId, done.costCents());
    return done;
  }

  record Request(String prompt) {}

  /** Northwind Models answers within ten seconds, or the assistant is busy. */
  static final Duration TIMEOUT = Duration.ofSeconds(10);
}
