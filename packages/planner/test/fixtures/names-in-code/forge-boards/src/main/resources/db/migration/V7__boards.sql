CREATE TABLE board_pin (
  id BIGINT PRIMARY KEY,
  kind VARCHAR(16) NOT NULL,
  CONSTRAINT board_pin_kind CHECK (kind IN ('note', 'link'))
);
