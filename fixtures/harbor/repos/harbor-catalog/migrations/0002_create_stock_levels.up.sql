CREATE TABLE stock_levels (
    sku      VARCHAR(32) NOT NULL PRIMARY KEY REFERENCES products (sku),
    on_hand  INTEGER     NOT NULL DEFAULT 0
);
