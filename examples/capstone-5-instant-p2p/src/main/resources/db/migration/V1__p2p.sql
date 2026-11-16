CREATE SEQUENCE p2p_seq START WITH 1 INCREMENT BY 1;

CREATE TABLE account (
    id             UUID         PRIMARY KEY,
    tenant_id      VARCHAR(64)  NOT NULL,
    owner_user_id  VARCHAR(64)  NOT NULL,
    currency       CHAR(3)      NOT NULL,
    balance_minor  BIGINT       NOT NULL CHECK (balance_minor >= 0)
);

CREATE TABLE transfer (
    id               UUID         PRIMARY KEY,
    tenant_id        VARCHAR(64)  NOT NULL,
    idempotency_key  VARCHAR(64)  NOT NULL,
    request_hash     CHAR(64)     NOT NULL,
    initiated_by     VARCHAR(64)  NOT NULL,
    from_account     UUID         NOT NULL REFERENCES account (id),
    to_account       UUID         NOT NULL REFERENCES account (id),
    amount_minor     BIGINT       NOT NULL CHECK (amount_minor > 0),
    currency         CHAR(3)      NOT NULL,
    status           VARCHAR(16)  NOT NULL,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, idempotency_key)
);

-- Both sides of every transfer (debit and credit) for the audit trail. Append-only by convention here;
-- capstone 2 shows trigger-enforced immutability and a full double-entry ledger.
CREATE TABLE account_movement (
    id            BIGINT       PRIMARY KEY DEFAULT nextval('p2p_seq'),
    transfer_id   UUID         NOT NULL REFERENCES transfer (id),
    account_id    UUID         NOT NULL REFERENCES account (id),
    amount_minor  BIGINT       NOT NULL,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE webhook_endpoint (
    id         UUID          PRIMARY KEY,
    tenant_id  VARCHAR(64)   NOT NULL UNIQUE,
    url        VARCHAR(2048) NOT NULL,
    secret     VARCHAR(128)  NOT NULL      -- demo only: production keeps this in a secrets manager / encrypted column
);

CREATE TABLE webhook_delivery (
    id               UUID          PRIMARY KEY,
    tenant_id        VARCHAR(64)   NOT NULL,
    event_type       VARCHAR(64)   NOT NULL,
    payload          TEXT          NOT NULL,
    status           VARCHAR(16)   NOT NULL,        -- PENDING, DELIVERED, DEAD
    attempts         INT           NOT NULL DEFAULT 0,
    next_attempt_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
    lease_until      TIMESTAMPTZ,
    last_error       VARCHAR(200),
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX webhook_due ON webhook_delivery (next_attempt_at) WHERE status = 'PENDING';
