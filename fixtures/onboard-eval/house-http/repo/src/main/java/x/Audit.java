package x;

class Audit {
  // bankHttp.exchange(Services.AUDIT, "GET", "/old"); an old call, commented out.
  void record(Event e) {
    bankHttp.exchange(Services.AUDIT, "POST", "/audit/events");
  }

  Balance balance(String id) {
    return bankHttp.exchange(Services.LEDGER, "GET", "/accounts/balance");
  }
}
