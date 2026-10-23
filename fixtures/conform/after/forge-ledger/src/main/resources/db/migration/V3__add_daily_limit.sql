ALTER TABLE account ADD COLUMN daily_limit NUMERIC(18,2);

CREATE TABLE limit_override (
  id BIGINT PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES account(id),
  until_date DATE NOT NULL
);
