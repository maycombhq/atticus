CREATE TABLE products (
    sku          VARCHAR(32)  NOT NULL PRIMARY KEY,
    name         VARCHAR(200) NOT NULL,
    description  TEXT,
    price_cents  INTEGER      NOT NULL
);
