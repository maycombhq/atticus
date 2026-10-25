package forge.studio;

import org.springframework.web.bind.annotation.*;

@RestController
public class NotesController {
  private final NotesRepository notes;
  private final SummaryClient summaries;

  NotesController(NotesRepository notes, SummaryClient summaries) {
    this.notes = notes;
    this.summaries = summaries;
  }

  @PostMapping("/api/notes")
  public Note create(@RequestBody Note note) {
    note.setSummary(summaries.summarise(note.getBody()));
    return notes.save(note);
  }

  @GetMapping("/api/notes/{id}")
  public Note get(@PathVariable String id) {
    return notes.findById(id);
  }
}
