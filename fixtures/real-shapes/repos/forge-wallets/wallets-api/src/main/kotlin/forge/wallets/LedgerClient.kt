package forge.wallets

import org.springframework.beans.factory.annotation.Value
import org.springframework.stereotype.Component
import org.springframework.web.reactive.function.client.WebClient

@Component
class LedgerClient(
  @Value("\${forge.gateway.base-url}") baseUrl: String,
) {
  private val web = WebClient.builder().baseUrl(baseUrl).build()

  fun account(id: String): Account? =
    web.get().uri("/forge/ledger/v1/accounts/{id}", id).retrieve().bodyToMono(Account::class.java).block()
}
