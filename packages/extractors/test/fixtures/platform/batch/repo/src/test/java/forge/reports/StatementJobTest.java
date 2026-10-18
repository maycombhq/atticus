package forge.reports;

import org.springframework.scheduling.annotation.Scheduled;

class StatementJobTest {
  @Scheduled(cron = "* * * * * *")
  void fake() { }
}
