@change-add-transfer-limit @story-s1-daily-transfer-limit
Feature: Refuse transfers over the daily limit
  As a Portal customer
  I want transfers that would take me over my daily limit refused
  So that a stolen login can't drain my account in one day.
  Traces to specs/transfer-limits/spec.md:3.

  # specs/transfer-limits/spec.md:6 (Transfer over the limit)
  @criterion-1 @e2e @regression
  Scenario: Transfer over the limit
    Given an account with a limit of 1000 that has sent 900 today
    When it asks to send 200
    Then the transfer is refused with LIMIT_EXCEEDED (HTTP 422) and nothing is posted

  # specs/transfer-limits/spec.md:10 (Transfer within the limit)
  @criterion-2 @e2e @regression
  Scenario: Transfer within the limit
    Given an account with a limit of 1000 that has sent 900 today
    When it asks to send 100
    Then the transfer is accepted
