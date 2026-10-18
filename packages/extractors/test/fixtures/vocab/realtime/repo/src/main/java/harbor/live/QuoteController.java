package harbor.live;

@Controller
@RequestMapping("/api")
public class QuoteController {

  @MessageMapping("/quotes.subscribe")
  public void subscribe(String symbol) {}

  @GetMapping(value = "/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
  public Flux<String> events() { return null; }

  @GetMapping("/plain")
  public String plain() { return ""; }
}
