package forge.studio;

import org.springframework.jdbc.core.JdbcTemplate;

public class NotesRepository {
  private final JdbcTemplate jdbc;

  NotesRepository(JdbcTemplate jdbc) {
    this.jdbc = jdbc;
  }

  Note save(Note note) {
    jdbc.update("insert into note (id, body, summary) values (?, ?, ?)", note.getId(), note.getBody(), note.getSummary());
    return note;
  }

  Note findById(String id) {
    return jdbc.queryForObject("select id, body, summary from note where id = ?", Note.MAPPER, id);
  }
}
