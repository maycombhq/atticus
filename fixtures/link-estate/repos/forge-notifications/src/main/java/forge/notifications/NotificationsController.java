package forge.notifications;

import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class NotificationsController {
  private final NotificationsService service;

  public NotificationsController(NotificationsService service) {
    this.service = service;
  }

  @PostMapping("/notifications")
  public void notify(@RequestBody NotificationRequest req) {
    service.send(req);
  }

  @PostMapping("/events")
  public void event(@RequestBody DeliveryEvent event) {
    service.delivered(event);
  }
}
