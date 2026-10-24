create table entry (
  id bigserial primary key,
  account_id bigint not null references account(id),
  amount numeric(18,2) not null,
  created_at timestamp not null default now()
);
