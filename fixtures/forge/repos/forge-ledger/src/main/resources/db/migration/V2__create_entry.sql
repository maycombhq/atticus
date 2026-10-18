CREATE TABLE entry (
  id BIGINT PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES account(id),
  amount NUMERIC(18,2) NOT NULL,
  posted_at TIMESTAMP NOT NULL
);
CREATE INDEX idx_entry_account ON entry(account_id);
