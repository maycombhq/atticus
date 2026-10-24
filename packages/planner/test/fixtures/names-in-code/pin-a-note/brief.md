# Pin a note to a board

A member pins a note with PUT /api/boards/{boardId}/notes/{noteId}/pin and unpins it with
DELETE /api/boards/{boardId}/pin. The pin is kept in board_pin (V7__boards.sql). Notes on
pinned boards are screened by Northwind Pay.
