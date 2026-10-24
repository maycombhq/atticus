ALTER TABLE board_pin ADD COLUMN size VARCHAR(8);
ALTER TABLE board_pin ADD CONSTRAINT board_pin_size CHECK (size IN ('s', 'm', 'l'));
ALTER TABLE board_pin ADD COLUMN layout ENUM('grid', 'list') NOT NULL;
ALTER TABLE board_pin ADD COLUMN priority INT CHECK (priority IN (1, 2, 3));
