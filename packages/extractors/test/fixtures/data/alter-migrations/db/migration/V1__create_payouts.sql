-- Hand-written fixture: the tables later migrations change.
CREATE TABLE payout_batch (
  id BIGINT PRIMARY KEY
);

CREATE TABLE payout (
  id BIGINT PRIMARY KEY,
  amount NUMERIC(10,2) NOT NULL,
  memo VARCHAR(80),
  legacy_code CHAR(4),
  status VARCHAR(10) DEFAULT 'new'
);

CREATE TABLE payout_audit (
  id BIGINT PRIMARY KEY,
  note TEXT
);

CREATE INDEX ix_payout_memo ON payout (memo);
