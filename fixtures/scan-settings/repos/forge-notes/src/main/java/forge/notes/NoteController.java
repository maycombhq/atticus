package forge.notes;

import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/notes")
public class NoteController {

  @GetMapping
  public List<Note> list() {
    return List.of();
  }

  @GetMapping("/{id}")
  public Note one(@PathVariable long id) {
    return new Note(id, "");
  }

  @PostMapping
  public Note add(@RequestBody Note note) {
    return note;
  }

  public record Note(long id, String text) {}
}
