-- AGENT-SEC-A7: die Standardrechte, damit die Disziplin nicht mehr noetig ist.
--
-- Die Migrationen dieses Projekts widerrufen vorbildlich: durchgehend
-- `from public, anon, authenticated`, bei Tabellen wie Funktionen, alle drei
-- benannt. Gemessen war vor dieser Migration nichts offen - 0 lesbare
-- Tabellen, 0 schreibbare, 0 aufrufbare Funktionen.
--
-- GESCHUETZT WAR DAS ABER NUR DURCH DISZIPLIN. Die Standardrechte des Schemas
-- `public` geben in einem Supabase-Projekt jeder NEUEN Tabelle, Funktion und
-- Sequenz volle Rechte fuer `anon` und `authenticated`. Wer die Widerruf-Zeile
-- ein einziges Mal vergisst, haengt das neue Objekt ans Internet: PostgREST
-- veroeffentlicht jede Funktion im Schema als `/rest/v1/rpc/<name>`.
--
-- ZWEI FALLEN, DIE DABEI ZUSAMMENWIRKEN.
--
-- Erstens: `revoke ... from public` genuegt NICHT. `PUBLIC` ist die
-- Sammelrolle; `anon` und `authenticated` bekommen ihre Rechte AUSDRUECKLICH
-- aus den Standardrechten, und ein Widerruf gegen die Sammelrolle beruehrt
-- eine ausdrueckliche Vergabe nicht. Es sieht abgesichert aus und ist es
-- nicht. Deshalb nennen alle Widerrufe hier alle drei Rollen einzeln.
--
-- Zweitens: RLS schuetzt Funktionen nicht. `SECURITY DEFINER` laeuft mit den
-- Rechten des Eigentuemers und umgeht RLS - eine zugeschlossene Tabelle sagt
-- nichts darueber, ob die Funktion darueber offen steht. Alle drei Funktionen
-- dieses Projekts sind SECURITY DEFINER.
--
-- Der erste Block unten ist idempotent und war beim Anwenden wirkungslos; er
-- raeumt nur auf, falls doch irgendwo ein Recht steht. Der eigentliche Punkt
-- sind die Standardrechte im zweiten Block.
--
-- GEGENPROBE, die keine Vermutung zulaesst: den anon-Key gegen
-- `https://<ref>.supabase.co/rest/v1/<tabelle>` und `.../rpc/<funktion>`
-- halten. Es muss `42501 permission denied` kommen. Eine leere Antwort ist
-- KEIN Beleg - die kommt auch, wenn RLS greift und das Recht trotzdem
-- vergeben ist.
--
-- service_role behaelt alles; Bot und API arbeiten damit, und kein
-- Client-Schluessel erreicht das ausgelieferte Frontend.
--
-- Die Standardrechte von `supabase_admin` liessen sich nicht aendern, dafuer
-- fehlen dieser Verbindung die Rechte. Praktisch folgenlos: Standardrechte
-- gelten nur fuer Objekte, die der jeweilige Vergeber ANLEGT, und jede
-- Migration dieses Projekts laeuft als `postgres`. Die Ausnahme bleibt laut
-- stehen statt still uebersprungen zu werden. Keine Geviertstriche.
do $$
declare
  t record;
  f record;
begin
  for t in
    select c.relname from pg_class c join pg_namespace s on s.oid = c.relnamespace
    where s.nspname = 'public' and c.relkind = 'r'
  loop
    execute format('revoke all on table public.%I from anon, authenticated', t.relname);
  end loop;
  for f in
    select p.oid::regprocedure as sig from pg_proc p join pg_namespace s on s.oid = p.pronamespace
    where s.nspname = 'public'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
  end loop;
end
$$;

do $$
declare
  r text;
begin
  foreach r in array array['postgres', 'supabase_admin'] loop
    begin
      execute format('alter default privileges for role %I in schema public revoke all on tables from anon, authenticated', r);
      execute format('alter default privileges for role %I in schema public revoke all on functions from anon, authenticated', r);
      execute format('alter default privileges for role %I in schema public revoke all on sequences from anon, authenticated', r);
      raise notice 'AGENT-SEC-A7: Standardrechte von % bereinigt', r;
    exception when insufficient_privilege then
      raise warning 'AGENT-SEC-A7: Standardrechte von % NICHT aenderbar (fehlende Rechte)', r;
    end;
  end loop;
end
$$;
