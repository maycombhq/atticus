plugins {
  alias(libs.plugins.spring.boot) apply false
  kotlin("jvm") version "2.2.0" apply false
}

allprojects {
  group = "forge.wallets"
  version = "3.1.0"
}
