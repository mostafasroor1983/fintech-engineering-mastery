-- Payments are stored in minor units (bigint) with the currency next to them.
CREATE SEQUENCE payment_seq START WITH 1 INCREMENT BY 50;

CREATE TABLE payment (
    id                BIGINT       PRIMARY KEY,
    public_id         UUID         NOT NULL UNIQUE,
    merchant_id       VARCHAR(64)  NOT NULL,
    debtor_account    VARCHAR(34)  NOT NULL,
    creditor_account  VARCHAR(34)  NOT NULL,
    amount_minor      BIGINT       NOT NULL CHECK (amount_minor > 0),
    currency          CHAR(3)      NOT NULL,
    reference         VARCHAR(140),
    status            VARCHAR(32)  NOT NULL,
    version           BIGINT       NOT NULL,
    created_at        TIMESTAMPTZ  NOT NULL,
    updated_at        TIMESTAMPTZ  NOT NULL
);

-- One row per (merchant, key). The primary key is what makes concurrent duplicates safe.
CREATE TABLE idempotency_key (
    merchant_id     VARCHAR(64)  NOT NULL,
    idempotency_key VARCHAR(64)  NOT NULL,
    request_hash    CHAR(64)     NOT NULL,
    response_status INT,
    response_body   TEXT,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    PRIMARY KEY (merchant_id, idempotency_key)
);

-- Transactional outbox: written in the same transaction as the payment.
CREATE SEQUENCE outbox_seq START WITH 1 INCREMENT BY 1;
CREATE TABLE outbox_event (
    id             BIGINT       PRIMARY KEY DEFAULT nextval('outbox_seq'),
    event_id       UUID         NOT NULL UNIQUE,
    aggregate_id   VARCHAR(64)  NOT NULL,
    event_type     VARCHAR(64)  NOT NULL,
    payload        TEXT         NOT NULL,
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    published_at   TIMESTAMPTZ
);
CREATE INDEX outbox_unpublished ON outbox_event (id) WHERE published_at IS NULL;

-- Idempotent consumer: remembers which events each consumer already applied.
CREATE TABLE processed_event (
    consumer     VARCHAR(64)  NOT NULL,
    event_id     UUID         NOT NULL,
    processed_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
    PRIMARY KEY (consumer, event_id)
);

-- The side effect the consumer produces. No unique constraint on purpose:
-- if de-duplication breaks, the tests see two rows.
CREATE TABLE settlement_instruction (
    id          BIGSERIAL    PRIMARY KEY,
    payment_id  UUID         NOT NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
