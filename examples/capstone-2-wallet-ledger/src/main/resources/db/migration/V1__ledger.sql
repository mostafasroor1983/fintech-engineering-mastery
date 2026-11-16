-- Double-entry ledger. Balances are cached on the account for fast reads; the postings are the truth.
CREATE SEQUENCE account_seq START WITH 1 INCREMENT BY 50;
CREATE TABLE account (
    id              BIGINT       PRIMARY KEY,
    public_id       UUID         NOT NULL UNIQUE,
    owner_id        VARCHAR(64)  NOT NULL,
    type            VARCHAR(32)  NOT NULL,          -- CUSTOMER_WALLET, FX_POSITION, FUNDING
    currency        CHAR(3)      NOT NULL,
    balance_minor   BIGINT       NOT NULL DEFAULT 0,
    allow_negative  BOOLEAN      NOT NULL DEFAULT FALSE,
    version         BIGINT       NOT NULL,
    created_at      TIMESTAMPTZ  NOT NULL,
    CONSTRAINT no_overdraft CHECK (allow_negative OR balance_minor >= 0)
);
CREATE UNIQUE INDEX one_wallet_per_owner_currency ON account (owner_id, currency, type);

CREATE SEQUENCE journal_entry_seq START WITH 1 INCREMENT BY 1;
CREATE TABLE journal_entry (
    id               BIGINT       PRIMARY KEY DEFAULT nextval('journal_entry_seq'),
    public_id        UUID         NOT NULL UNIQUE,
    idempotency_key  VARCHAR(64)  NOT NULL UNIQUE,  -- a retried request finds the entry it already created
    request_hash     CHAR(64)     NOT NULL,
    kind             VARCHAR(32)  NOT NULL,          -- DEPOSIT, TRANSFER, FX_TRANSFER
    description      VARCHAR(140),
    fx_quote_id      UUID,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE SEQUENCE posting_seq START WITH 1 INCREMENT BY 1;
CREATE TABLE posting (
    id            BIGINT       PRIMARY KEY DEFAULT nextval('posting_seq'),
    entry_id      BIGINT       NOT NULL REFERENCES journal_entry (id),
    account_id    BIGINT       NOT NULL REFERENCES account (id),
    amount_minor  BIGINT       NOT NULL CHECK (amount_minor <> 0),   -- + credit to account, - debit
    currency      CHAR(3)      NOT NULL
);
CREATE INDEX posting_by_account ON posting (account_id);
CREATE INDEX posting_by_entry ON posting (entry_id);

-- Invariant 1: inside every journal entry, postings sum to zero PER CURRENCY.
-- Checked at COMMIT (deferred), so the application can insert the legs one by one.
CREATE FUNCTION check_entry_balanced() RETURNS trigger AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM posting WHERE entry_id = NEW.entry_id
        GROUP BY currency HAVING sum(amount_minor) <> 0
    ) THEN
        RAISE EXCEPTION 'journal entry % is not balanced', NEW.entry_id USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER entry_balanced
    AFTER INSERT ON posting
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION check_entry_balanced();

-- Invariant 2: a posting's currency must equal its account's currency.
CREATE FUNCTION check_posting_currency() RETURNS trigger AS $$
BEGIN
    IF NEW.currency <> (SELECT currency FROM account WHERE id = NEW.account_id) THEN
        RAISE EXCEPTION 'posting currency % does not match account', NEW.currency USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER posting_currency BEFORE INSERT ON posting
    FOR EACH ROW EXECUTE FUNCTION check_posting_currency();

-- Invariant 3: the ledger is append-only. Mistakes are fixed with a reversing entry, never an UPDATE.
CREATE FUNCTION reject_mutation() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER posting_append_only BEFORE UPDATE OR DELETE ON posting
    FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER journal_append_only BEFORE UPDATE OR DELETE ON journal_entry
    FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- FX quotes are single-use and expire.
CREATE TABLE fx_quote (
    id            UUID          PRIMARY KEY,
    sell_currency CHAR(3)       NOT NULL,
    buy_currency  CHAR(3)       NOT NULL,
    rate          NUMERIC(18,8) NOT NULL CHECK (rate > 0),
    sell_minor    BIGINT        NOT NULL CHECK (sell_minor > 0),
    buy_minor     BIGINT        NOT NULL CHECK (buy_minor > 0),
    expires_at    TIMESTAMPTZ   NOT NULL,
    used_at       TIMESTAMPTZ
);
