CREATE SEQUENCE recon_seq START WITH 1 INCREMENT BY 1;

-- One row per received file. sha256 makes re-delivery of the same bytes harmless.
CREATE TABLE statement_file (
    id              BIGINT       PRIMARY KEY DEFAULT nextval('recon_seq'),
    sha256          CHAR(64)     NOT NULL UNIQUE,
    statement_id    VARCHAR(64)  NOT NULL UNIQUE,      -- bank's <Stmt><Id>
    account_iban    VARCHAR(34)  NOT NULL,
    currency        CHAR(3)      NOT NULL,
    statement_date  DATE         NOT NULL,
    opening_minor   BIGINT       NOT NULL,
    closing_minor   BIGINT       NOT NULL,
    received_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE statement_line (
    id               BIGINT       PRIMARY KEY DEFAULT nextval('recon_seq'),
    file_id          BIGINT       NOT NULL REFERENCES statement_file (id),
    bank_ref         VARCHAR(64)  NOT NULL,           -- <AcctSvcrRef>
    end_to_end_id    VARCHAR(64),                     -- <EndToEndId>, may be missing
    amount_minor     BIGINT       NOT NULL CHECK (amount_minor > 0),
    currency         CHAR(3)      NOT NULL,
    direction        VARCHAR(4)   NOT NULL CHECK (direction IN ('CRDT', 'DBIT')),
    value_date       DATE         NOT NULL,
    remittance_info  VARCHAR(140)
);

-- What our own ledger expects to see on the bank account (fed by the payment/wallet services).
CREATE TABLE ledger_item (
    id              BIGINT       PRIMARY KEY DEFAULT nextval('recon_seq'),
    account_iban    VARCHAR(34)  NOT NULL,
    end_to_end_id   VARCHAR(64)  NOT NULL UNIQUE,
    amount_minor    BIGINT       NOT NULL CHECK (amount_minor > 0),
    currency        CHAR(3)      NOT NULL,
    direction       VARCHAR(4)   NOT NULL CHECK (direction IN ('CRDT', 'DBIT')),
    value_date      DATE         NOT NULL,
    matched         BOOLEAN      NOT NULL DEFAULT FALSE
);

CREATE TABLE match (
    id                BIGINT       PRIMARY KEY DEFAULT nextval('recon_seq'),
    statement_line_id BIGINT       NOT NULL UNIQUE REFERENCES statement_line (id),
    ledger_item_id    BIGINT       NOT NULL UNIQUE REFERENCES ledger_item (id),
    rule              VARCHAR(32)  NOT NULL,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE recon_break (
    id                BIGINT       PRIMARY KEY DEFAULT nextval('recon_seq'),
    file_id           BIGINT       NOT NULL REFERENCES statement_file (id),  -- the run that raised it
    type              VARCHAR(32)  NOT NULL,
    status            VARCHAR(16)  NOT NULL,
    statement_line_id BIGINT       REFERENCES statement_line (id),
    ledger_item_id    BIGINT       REFERENCES ledger_item (id),
    amount_minor      BIGINT       NOT NULL,
    currency          CHAR(3)      NOT NULL,
    detail            VARCHAR(200) NOT NULL,
    assignee          VARCHAR(64),
    resolution        VARCHAR(32),
    version           BIGINT       NOT NULL DEFAULT 0,  -- optimistic locking for the workflow
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Append-only history of every workflow action (who, what, when, why).
CREATE TABLE break_event (
    id         BIGINT       PRIMARY KEY DEFAULT nextval('recon_seq'),
    break_id   BIGINT       NOT NULL REFERENCES recon_break (id),
    action     VARCHAR(32)  NOT NULL,
    actor      VARCHAR(64)  NOT NULL,
    comment    VARCHAR(500),
    created_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);
