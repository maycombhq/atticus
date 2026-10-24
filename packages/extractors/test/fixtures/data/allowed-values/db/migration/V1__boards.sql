-- Forge Boards (invented): pins on a board, and the values each kind of column allows.
CREATE TYPE pin_colour AS ENUM ('red', 'amber', 'green');

CREATE TABLE board_pin (
  id BIGINT PRIMARY KEY,
  board_id BIGINT NOT NULL,
  kind VARCHAR(16) NOT NULL DEFAULT 'note',
  colour pin_colour NOT NULL,
  state VARCHAR(10) NOT NULL CHECK (state IN ('open', 'closed')),
  body TEXT,
  CONSTRAINT board_pin_kind CHECK (kind IN ('note','link','image','system'))
);
