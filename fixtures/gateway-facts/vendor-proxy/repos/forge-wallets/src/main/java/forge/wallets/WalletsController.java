package forge.wallets;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/wallets")
public class WalletsController {
  private final NorthwindWalletsClient northwind;

  public WalletsController(NorthwindWalletsClient northwind) { this.northwind = northwind; }

  @GetMapping
  public WalletPage search(@RequestParam String owner) { return northwind.search(owner); }

  @PostMapping
  public Wallet create(@RequestBody NewWallet body) { return northwind.create(body); }

  @GetMapping("/{walletGuid}")
  public Wallet get(@PathVariable String walletGuid) { return northwind.get(walletGuid); }
}
