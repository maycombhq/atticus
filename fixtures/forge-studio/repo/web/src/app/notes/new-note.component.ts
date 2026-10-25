import { Component } from '@angular/core';
import { Router } from '@angular/router';
import { NotesService } from './notes.service';

@Component({ selector: 'studio-new-note', templateUrl: './new-note.component.html' })
export class NewNoteComponent {
  body = '';

  constructor(private notes: NotesService, private router: Router) {}

  save() {
    this.notes.create({ body: this.body }).subscribe(n => this.router.navigate(['/notes', n.id]));
  }
}
