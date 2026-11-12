package forge.portal;

import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.*;

@FeignClient(name = "ledger", url = "${gateway.url}/ledger/v1")
public interface LedgerClient {
  @GetMapping("/accounts/{id}/balance")
  Balance getBalance(@PathVariable("id") String id);

  @PostMapping("/transfers")
  TransferResult createTransfer(@RequestBody TransferRequest request);
}
