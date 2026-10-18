package forge.reports;

import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
public class StatementJob {

  @Scheduled(cron = "${reports.statement.cron}")
  public void exportDaily() { }

  @Scheduled(cron = "0 */15 * * * *", zone = "Europe/London")
  public void refreshCache() { }

  @Scheduled(fixedDelayString = "PT30S")
  public void pollInbox() { }

  public void notScheduled() { }
}
