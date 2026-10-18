-- Runs after V3 (versions compare as numbers). SQL Server, MySQL and Oracle forms.
ALTER TABLE payout ALTER COLUMN currency VARCHAR(3) NULL;
ALTER TABLE payout MODIFY COLUMN payee_reference VARCHAR(60) NOT NULL;
ALTER TABLE payout ADD (fee NUMERIC(8,2), fee_currency CHAR(3) NOT NULL);
