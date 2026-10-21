package forge.tasks;

import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/tasks")
public class TaskController {

  @GetMapping
  public List<Task> list() {
    return List.of();
  }

  @PostMapping
  public Task add(@RequestBody Task task) {
    return task;
  }

  public record Task(long id, String title) {}
}
