-- phase: expand
-- OpenVibe.Help: the receipts of the ADR-033 account export and deletion deliveries this service applied
-- (openvibe-sdk/account-data's ACCOUNT_DATA_SCHEMA), so a redelivered export or deletion changes nothing.
-- The row holds an export_id or deletion_id, the subject and the counts sent to Network; it is not a secret.

CREATE TABLE IF NOT EXISTS account_data_events (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    subject TEXT NOT NULL,
    outcome JSONB,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at TIMESTAMPTZ
);

-- ADR-033: a deletion anonymizes the author of a staff reply left in someone else's ticket, and
-- openvibe-sdk/account-data does that by setting the subject column to NULL. help_messages.author is that
-- subject column (server/identity/account-data.js), so it can no longer be NOT NULL. The reply's body stays:
-- the ticket's owner still has to read their own conversation (migrations/0002_tickets.sql).
ALTER TABLE help_messages ALTER COLUMN author DROP NOT NULL;
