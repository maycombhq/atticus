package forge.ledger;

final class TransferLimits {
  private TransferLimits() {}

  static void check(TransferRequest request) {
    if (request.amount().compareTo(request.account().dailyLimit()) > 0)
      throw new LimitExceeded(request.account().id());
  }
}
