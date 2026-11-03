package forge.gate.api;

import forge.gate.client.TidewaterClient;
import forge.gate.model.TransferRequest;
import forge.gate.model.TransferResponse;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/transfers")
public class TransferController {
  private final TidewaterClient tidewater;

  public TransferController(TidewaterClient tidewater) {
    this.tidewater = tidewater;
  }

  @PostMapping
  public TransferResponse create(@RequestBody TransferRequest transfer) {
    return tidewater.post(transfer);
  }
}
