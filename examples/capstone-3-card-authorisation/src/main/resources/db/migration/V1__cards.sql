-- We store a card TOKEN, never the PAN. Keeping PANs out of this service keeps it out of most PCI DSS scope.
CREATE SEQUENCE card_auth_seq START WITH 1 INCREMENT BY 50;
CREATE TABLE card_authorisation (
    id                 BIGINT       PRIMARY KEY,
    public_id          UUID         NOT NULL UNIQUE,
    card_token         VARCHAR(64)  NOT NULL,
    merchant_id        VARCHAR(64)  NOT NULL,
    currency           CHAR(3)      NOT NULL,
    authorised_minor   BIGINT       NOT NULL CHECK (authorised_minor > 0),
    captured_minor     BIGINT       NOT NULL DEFAULT 0,
    refunded_minor     BIGINT       NOT NULL DEFAULT 0,
    charged_back_minor BIGINT       NOT NULL DEFAULT 0,
    status             VARCHAR(32)  NOT NULL,
    decision_reason    VARCHAR(64)  NOT NULL,
    fraud_score        INT,
    expires_at         TIMESTAMPTZ  NOT NULL,
    version            BIGINT       NOT NULL,
    created_at         TIMESTAMPTZ  NOT NULL,
    CONSTRAINT capture_within_auth CHECK (captured_minor <= authorised_minor),
    CONSTRAINT refund_within_capture CHECK (refunded_minor + charged_back_minor <= captured_minor)
);

-- Append-only audit of every operation. operation_id makes each command idempotent.
CREATE TABLE card_operation (
    operation_id  VARCHAR(64)  PRIMARY KEY,
    auth_id       BIGINT       NOT NULL REFERENCES card_authorisation (id),
    type          VARCHAR(32)  NOT NULL,
    amount_minor  BIGINT       NOT NULL,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);
