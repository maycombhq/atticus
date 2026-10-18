CREATE TABLE account (
  id BIGINT PRIMARY KEY,
  created_at TIMESTAMP NOT NULL,
  owner_name VARCHAR(80) NOT NULL,
  balance NUMERIC(19,2),
  frozen BOOLEAN NOT NULL
);

CREATE INDEX ix_account_owner ON account (owner_name);
