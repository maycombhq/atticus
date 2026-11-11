plugins {
  kotlin("jvm")
  alias(libs.plugins.spring.boot)
}

dependencies {
  implementation(libs.forge.ledger.api)
  implementation(libs.northwind.pay.client)
  implementation(libs.spring.boot.starter.webflux)
  implementation("forge.rates:rates-core:0.4.0")
  testImplementation(libs.junit.jupiter)
  testImplementation("org.springframework.boot:spring-boot-starter-test") {
    exclude(group = "org.mockito")
  }
}
