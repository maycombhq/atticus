package forge.reports;

import org.quartz.CronScheduleBuilder;
import org.quartz.JobDetail;
import org.quartz.Trigger;
import org.quartz.TriggerBuilder;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.quartz.CronTriggerFactoryBean;

@Configuration
public class QuartzConfig {

  @Bean
  public Trigger reconcileTrigger(JobDetail reconcileJob) {
    return TriggerBuilder.newTrigger()
        .forJob(reconcileJob)
        .withIdentity("reconcile-trigger")
        .withSchedule(CronScheduleBuilder.cronSchedule("0 0 6 ? * MON-FRI"))
        .build();
  }

  @Bean
  public CronTriggerFactoryBean purgeTrigger() {
    CronTriggerFactoryBean factory = new CronTriggerFactoryBean();
    factory.setCronExpression("0 0 1 1 * ?");
    return factory;
  }
}
