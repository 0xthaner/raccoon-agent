create or replace function public.consume_wallet_link(link_code text, linked_wallet text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  linked_chat_id text;
begin
  update public.pending_links
     set used_at = now()
   where code = link_code
     and used_at is null
     and expires_at > now()
  returning chat_id into linked_chat_id;

  if linked_chat_id is null then
    return null;
  end if;

  insert into public.wallet_links (chat_id, wallet, linked_at, alerts_enabled)
  values (linked_chat_id, lower(linked_wallet), now(), true)
  on conflict (chat_id) do update
    set wallet = excluded.wallet,
        linked_at = excluded.linked_at,
        alerts_enabled = true;

  return linked_chat_id;
end;
$$;

revoke all on function public.consume_wallet_link(text, text) from public, anon, authenticated;
grant execute on function public.consume_wallet_link(text, text) to service_role;
