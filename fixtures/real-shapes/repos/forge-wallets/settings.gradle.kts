@file:Suppress("UnstableApiUsage")

pluginManagement {
  repositories {
    mavenCentral()
    gradlePluginPortal()
  }
}

rootProject.name = "forge-wallets"

dependencyResolutionManagement {
  repositories {
    mavenCentral()
  }
}

include(":wallets-api")
project(":wallets-api").name = "forge-wallets-api"
