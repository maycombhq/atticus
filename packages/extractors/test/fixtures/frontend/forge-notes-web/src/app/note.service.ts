import { HttpClient } from "@angular/common/http";
import { environment } from "../../environments/environment";

export interface Note {
  id: number;
  text: string;
}

/** Notes, from the notes service: every URL is built from the environment's base. */
export class NoteService {
  private entityUrl = environment.NOTES_API_URL + "notes";

  constructor(private http: HttpClient) {}

  getNotes() {
    return this.http.get<Note[]>(this.entityUrl);
  }

  getNote(id: number) {
    return this.http.get<Note>(this.entityUrl + "/" + id);
  }

  addNote(note: Note) {
    return this.http.post<Note>(this.entityUrl, note);
  }

  tagsOf(id: number) {
    return this.http.get<string[]>(`${environment.NOTES_API_URL}notes/${id}/tags`);
  }

  // A path with no host: an interceptor puts the base in front.
  allTags() {
    return this.http.get<string[]>("/tags");
  }

  // Built from written parts: a name between them is a parameter; a choice ends the path.
  byAuthor(name: string) {
    return this.http.get<Note[]>("/authors/" + name + "/notes");
  }

  listed(pinned: boolean) {
    return this.http.get<Note[]>("/listed" + (pinned ? "/pinned" : ""));
  }
}
