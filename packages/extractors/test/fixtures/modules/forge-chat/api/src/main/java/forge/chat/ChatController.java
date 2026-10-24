package forge.chat;

import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/chats")
public class ChatController {
  @GetMapping("/{id}/messages")
  public String messages(@PathVariable String id) {
    return "[]";
  }

  @DeleteMapping("/{id}/messages/{messageId}")
  public void delete(@PathVariable String id, @PathVariable String messageId) {}
}
