CREATE TABLE merchants (
  id BIGINT PRIMARY KEY,
  merchant_ref VARCHAR(20) NOT NULL,
  account_id VARCHAR(34) NOT NULL,
  contact_email VARCHAR(120)
);
CREATE TABLE settlements (
  id BIGINT PRIMARY KEY,
  merchant_id BIGINT NOT NULL,
  amount BIGINT NOT NULL,
  currency CHAR(3) NOT NULL
);
