package forge.instruments;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/{moduleName:.+}/{moduleApiVersion:.+}/instruments")
public class InstrumentsController {
  @GetMapping("/ping")
  public String ping() { return "ok"; }

  @PostMapping
  public Instrument create(@RequestBody Instrument body) { return body; }

  @GetMapping("/{instrumentId}")
  public Instrument retrieve(@PathVariable String instrumentId) { return null; }

  @PostMapping("/{instrumentId}/status")
  public Instrument status(@PathVariable String instrumentId, @RequestBody Status body) { return null; }
}
