alter table notification_channels rename column webhook_ciphertext to target_ciphertext;
alter table notification_channels add column transport text not null default 'webhook'
  check (transport in ('webhook', 'long-connection'));
alter table notification_channels add column bot_key text;
alter table notification_channels add constraint notification_channels_bot_key_check
  check ((transport = 'webhook' and bot_key is null) or (transport = 'long-connection' and bot_key is not null));

alter table notification_deliveries rename column webhook_ciphertext to target_ciphertext;
alter table notification_deliveries add column transport text not null default 'webhook'
  check (transport in ('webhook', 'long-connection'));
alter table notification_deliveries add column bot_key text;
alter table notification_deliveries add constraint notification_deliveries_bot_key_check
  check ((transport = 'webhook' and bot_key is null) or (transport = 'long-connection' and bot_key is not null));

create table notification_bot_leases (
  bot_key text primary key,
  holder text not null,
  lease_until timestamptz not null
);
