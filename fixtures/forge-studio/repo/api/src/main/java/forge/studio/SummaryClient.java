package forge.studio;

import org.springframework.web.client.RestTemplate;

public class SummaryClient {
  private final RestTemplate rest = new RestTemplate();

  String summarise(String body) {
    return rest.postForObject("https://llm.vendor.example/v1/messages", body, String.class);
  }
}
