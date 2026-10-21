package forge.payments;

@RestController
@RequestMapping("/payments")
public class SettlementController {
  private final MerchantRepository merchants;
  private final SettlementRepository settlements;
  private final LedgerClient ledger;
  private final NotifyClient notify;

  @PostMapping("/settlements")
  public ResponseEntity<Void> settle(@Valid @RequestBody SettlementRequest body) {
    Merchant merchant = merchants.findByRef(body.merchantRef()).orElseThrow(UnknownMerchant::new);
    LedgerEntryRequest entry = new LedgerEntryRequest(merchant.accountId(), body.amount(), body.currency());
    ledger.post(entry);
    notify.send(new Notice(merchant.contactEmail(), body.amount()));
    Settlement saved = settlements.save(new Settlement(merchant.id(), body.amount(), body.currency()));
    return ResponseEntity.accepted().build();
  }
}
