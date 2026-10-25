import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { environment } from '../../environments/environment';
import { Note } from './note';

@Injectable({ providedIn: 'root' })
export class NotesService {
  constructor(private http: HttpClient) {}

  create(note: Note) {
    return this.http.post<Note>(`${environment.apiBase}/api/notes`, note);
  }
}
