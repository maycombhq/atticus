-- Several actions in one statement, then a rename and drops.
ALTER TABLE payout
  ADD COLUMN payee_ref VARCHAR(40),
  ADD COLUMN batch_id BIGINT REFERENCES payout_batch(id),
  DROP COLUMN IF EXISTS status;
ALTER TABLE payout ALTER COLUMN memo DROP NOT NULL;
ALTER TABLE payout RENAME COLUMN payee_ref TO payee_reference;
DROP INDEX ix_payout_memo;
DROP TABLE payout_audit;
