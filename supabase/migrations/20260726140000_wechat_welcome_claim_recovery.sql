alter table public.wechat_web_claims
  add column if not exists token_ciphertext text;

alter table public.wechat_web_claims
  add constraint wechat_web_claims_token_ciphertext_check
  check (
    token_ciphertext is null
    or char_length(token_ciphertext) between 32 and 16384
  );

comment on column public.wechat_web_claims.token_ciphertext is
  'Encrypted one-time claim token retained only so the first authenticated WeChat inbound handshake can recover the registration link.';
