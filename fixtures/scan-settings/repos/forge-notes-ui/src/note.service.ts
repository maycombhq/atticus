import { HttpClient } from "@angular/common/http";
import { environment } from "./environment.js";

export interface Note {
  id: number;
  text: string;
}

/** The notes screen's service: every URL is built from the environment's base. */
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
    return this.http.post<Note>(`${environment.NOTES_API_URL}notes`, note);
  }
}
