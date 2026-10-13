// Task 1.01: read-only numbers from production. A measurement tool, not
// product code. Run from the repo root:
//
//   DATABASE_URL="$(heroku config:get DATABASE_URL -a secretary-kiron)" \
//     OWNER_EMAIL=<the account's email> node docs/jarvis/baseline/prod-readonly.mjs
//
// The session is opened with default_transaction_read_only=on, so the server
// refuses every write on it, and the script proves that before it reads
// anything: a CREATE TEMP TABLE must fail with SQLSTATE 25006. It prints
// names, counts, tokens and dollars only: no message text, no task titles, no
// email addresses, no connection string.
import pg from "pg";

const SINCE = process.env.SINCE ?? "2026-10-07";
const TZ = "America/Los_Angeles";
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

const client = new pg.Client({
  connectionString: url,
  ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false },
  options: "-c default_transaction_read_only=on -c statement_timeout=30000",
});

const section = (name, rows) => {
  console.log(`== ${name} (${rows.length})`);
  for (const r of rows) console.log(JSON.stringify(r));
};
const q = async (name, text, params = []) => section(name, (await client.query(text, params)).rows);

await client.connect();
try {
  // 1. Proof the session cannot write.
  const ro = await client.query("show default_transaction_read_only");
  await client.query("begin");
  const inTx = await client.query("show transaction_read_only");
  let refused = "NOT REFUSED";
  try {
    await client.query("create temp table baseline_write_probe (x int)");
  } catch (e) {
    refused = `${e.code} ${e.message}`;
  }
  await client.query("rollback");
  section("read_only_proof", [
    {
      default_transaction_read_only: ro.rows[0].default_transaction_read_only,
      transaction_read_only: inTx.rows[0].transaction_read_only,
      write_probe: refused,
    },
  ]);
  if (!refused.startsWith("25006")) throw new Error("the session is not read-only; stopping");

  await client.query("begin transaction read only");

  const users = await client.query('select id, email from "user"');
  const owner = users.rows.find((u) => u.email === process.env.OWNER_EMAIL);
  section("users", [{ users: users.rows.length, owner_found: Boolean(owner) }]);
  if (!owner) throw new Error("OWNER_EMAIL matches no user");
  const uid = owner.id;

  await q("now", "select to_char(now() at time zone $1, 'YYYY-MM-DD HH24:MI') as now_pt", [TZ]);

  const day = `to_char(created_at at time zone '${TZ}', 'MM-DD')`;
  const since = `created_at >= ($2::date::timestamp at time zone '${TZ}')`;

  await q(
    "total_since",
    `select count(*)::int as rows, round(sum(cost_usd), 2) as usd,
            count(*) filter (where cost_usd is null)::int as unpriced_rows,
            count(*) filter (where cost_estimated)::int as estimated_rows
       from usage where user_id = $1 and ${since}`,
    [uid, SINCE]
  );
  await q(
    "all_users_since",
    `select count(*)::int as rows, round(sum(cost_usd), 2) as usd, count(distinct user_id)::int as users
       from usage where created_at >= ($1::date::timestamp at time zone '${TZ}')`,
    [SINCE]
  );
  await q(
    "by_kind_model_since",
    `select kind, model, count(*)::int as rows, round(sum(cost_usd), 2) as usd,
            sum(input_tokens)::int as in_tok, sum(cached_input_tokens)::int as cached_tok,
            sum(output_tokens)::int as out_tok
       from usage where user_id = $1 and ${since}
      group by 1, 2 order by sum(cost_usd) desc nulls last`,
    [uid, SINCE]
  );
  await q(
    "by_day_kind_model",
    `select ${day} as day, kind, model, count(*)::int as rows, round(sum(cost_usd), 2) as usd,
            sum(input_tokens)::int as in_tok, sum(cached_input_tokens)::int as cached_tok,
            sum(output_tokens)::int as out_tok
       from usage where user_id = $1 and ${since}
      group by 1, 2, 3 order by 1, sum(cost_usd) desc nulls last`,
    [uid, SINCE]
  );
  // Every day in the window: what it spent, what the user said, and what new
  // data arrived (rows created that day: a message from the user or the
  // mailbox, a task, an event, a document, a remembered fact, an upload).
  // A day is IDLE when none arrived.
  const byDay = `
     with days as (
       select generate_series($2::date, (now() at time zone '${TZ}')::date, '1 day')::date as d
     ), spend as (
       select (created_at at time zone '${TZ}')::date as d, round(sum(cost_usd), 2) as usd,
              count(*)::int as rows,
              round(coalesce(sum(cost_usd) filter (where kind = 'understanding'), 0), 2) as understanding_usd,
              round(coalesce(sum(cost_usd) filter (where kind in ('chat','voice','transcribe','speech')), 0), 2) as own_turn_usd
         from usage where user_id = $1 and ${since} group by 1
     ), said as (
       select (created_at at time zone '${TZ}')::date as d,
              count(*) filter (where role = 'user')::int as user_messages,
              count(*) filter (where role = 'user' and origin = 'app')::int as typed_or_spoken
         from messages where user_id = $1 and ${since} group by 1
     ), made as (
       select d, sum(n)::int as other_new_rows from (
         select (created_at at time zone '${TZ}')::date as d, count(*) as n from tasks where user_id = $1 and ${since} group by 1
         union all select (created_at at time zone '${TZ}')::date, count(*) from events where user_id = $1 and ${since} group by 1
         union all select (created_at at time zone '${TZ}')::date, count(*) from documents where user_id = $1 and ${since} group by 1
         union all select (created_at at time zone '${TZ}')::date, count(*) from memories where user_id = $1 and ${since} group by 1
         union all select (created_at at time zone '${TZ}')::date, count(*) from attachments where user_id = $1 and ${since} group by 1
       ) x group by d
     ), joined as (
       select days.d, coalesce(spend.usd, 0) as usd,
              coalesce(spend.understanding_usd, 0) as understanding_usd,
              coalesce(spend.own_turn_usd, 0) as own_turn_usd,
              coalesce(spend.rows, 0) as usage_rows,
              coalesce(said.user_messages, 0) as user_messages,
              coalesce(said.typed_or_spoken, 0) as typed_or_spoken,
              coalesce(made.other_new_rows, 0) as other_new_rows
         from days left join spend using (d) left join said using (d) left join made using (d)
     )`;
  await q(
    "by_day_spend_and_new_data",
    `${byDay}
     select to_char(d, 'MM-DD') as day, usd, understanding_usd, own_turn_usd, usage_rows,
            user_messages, typed_or_spoken, other_new_rows,
            (user_messages = 0 and other_new_rows = 0) as idle
       from joined order by d`,
    [uid, SINCE]
  );
  await q(
    "spend_on_idle_and_silent_days",
    `${byDay}
     select count(*)::int as days,
            count(*) filter (where user_messages = 0 and other_new_rows = 0)::int as idle_days,
            round(coalesce(sum(usd) filter (where user_messages = 0 and other_new_rows = 0), 0), 2) as usd_on_idle_days,
            count(*) filter (where typed_or_spoken = 0)::int as days_with_nothing_typed_or_spoken,
            round(coalesce(sum(usd) filter (where typed_or_spoken = 0), 0), 2) as usd_on_those_days,
            round(sum(usd), 2) as usd_all_days
       from joined`,
    [uid, SINCE]
  );
  // One usage row of kind chat is one user turn (every tool round summed);
  // one voice row is one call.
  for (const [name, window, params] of [
    ["since", since, [uid, SINCE]],
    ["last_37_days", "created_at >= now() - interval '37 days' and $2::text is not null", [uid, SINCE]],
  ]) {
    await q(
      `chat_voice_per_row_${name}`,
      `select kind, model, count(*)::int as rows,
              round(avg(input_tokens))::int as in_avg, min(input_tokens) as in_min, max(input_tokens) as in_max,
              count(cached_input_tokens)::int as rows_with_cached_recorded,
              count(*) filter (where cached_input_tokens > 0)::int as rows_with_cache_hit,
              round(avg(cached_input_tokens))::int as cached_avg,
              round(avg(output_tokens))::int as out_avg,
              round(avg(seconds))::int as seconds_avg,
              round(avg(audio_input_tokens))::int as audio_in_avg,
              round(avg(audio_output_tokens))::int as audio_out_avg,
              round(avg(cost_usd), 4) as usd_avg, round(sum(cost_usd), 2) as usd
         from usage where user_id = $1 and kind in ('chat', 'voice') and ${window}
        group by 1, 2 order by 1, count(*) desc`,
      params
    );
  }
  await q(
    "chat_voice_rows_since",
    `select to_char(created_at at time zone '${TZ}', 'MM-DD HH24:MI') as at, kind, model, seconds,
            input_tokens as in_tok, cached_input_tokens as cached_tok, output_tokens as out_tok,
            audio_input_tokens as audio_in, audio_output_tokens as audio_out, round(cost_usd, 4) as usd
       from usage where user_id = $1 and kind in ('chat', 'voice') and ${since} order by created_at`,
    [uid, SINCE]
  );
  // The chat model's cache column over time: null means "not recorded", 0 means "recorded, no hit".
  await q(
    "chat_cache_column_by_model_and_week",
    `select model, to_char(date_trunc('week', created_at at time zone '${TZ}'), 'MM-DD') as week_of,
            count(*)::int as rows, count(*) filter (where cached_input_tokens is null)::int as cached_null,
            count(*) filter (where cached_input_tokens = 0)::int as cached_zero,
            count(*) filter (where cached_input_tokens > 0)::int as cached_hit,
            sum(input_tokens)::int as in_tok, sum(cached_input_tokens)::int as cached_tok
       from usage where user_id = $1 and kind = 'chat' and created_at >= now() - interval '45 days'
      group by 1, 2 order by 2, 1`,
    [uid]
  );
  // Chat back to 09-06 (three days before prompt caching landed, commit 72f04b7).
  const CHAT_SINCE = process.env.CHAT_SINCE ?? "2026-09-06";
  await q(
    "chat_by_day_model",
    `select ${day} as day, model, count(*)::int as turns, sum(input_tokens)::int as in_tok,
            sum(cached_input_tokens)::int as cached_tok,
            count(*) filter (where cached_input_tokens is null)::int as cached_not_recorded,
            sum(output_tokens)::int as out_tok, round(sum(cost_usd), 2) as usd
       from usage where user_id = $1 and kind = 'chat' and ${since}
      group by 1, 2 order by 1, 2`,
    [uid, CHAT_SINCE]
  );
  // Every chat turn in that window; input over the size of one request is the rounds it took.
  await q(
    "chat_turns",
    `select to_char(created_at at time zone '${TZ}', 'MM-DD HH24:MI') as at, model,
            input_tokens as in_tok, cached_input_tokens as cached_tok, output_tokens as out_tok,
            round(cost_usd, 4) as usd
       from usage where user_id = $1 and kind = 'chat' and ${since} order by created_at`,
    [uid, CHAT_SINCE]
  );
  // Which models the composer chip and Settings hold now (names, not keys).
  await q(
    "model_settings",
    `select coalesce(persona->>'chatModel', '(default)') as chat_model,
            coalesce(persona->>'chatEffort', '(default)') as chat_effort,
            coalesce(persona->>'brainModel', '(default)') as brain_model,
            coalesce(persona->>'brainEffort', '(default)') as brain_effort,
            (select count(*) from connected_accounts where user_id = $1)::int as connected_accounts
       from "user" where id = $1`,
    [uid]
  );
  // What the background reading did with the money.
  await q(
    "understanding_runs_since",
    `select status, coalesce(reason, '') as reason, model, count(*)::int as runs,
            sum(input_tokens)::int as in_tok, sum(output_tokens)::int as out_tok
       from understanding_runs
      where user_id = $1 and started_at >= ($2::date::timestamp at time zone '${TZ}')
      group by 1, 2, 3 order by count(*) desc`,
    [uid, SINCE]
  );
  await q(
    "records_written_since",
    `select count(*)::int as records, count(*) filter (
              where updated_at >= ($2::date::timestamp at time zone '${TZ}'))::int as updated_since
       from records where user_id = $1`,
    [uid, SINCE]
  );
  // Size of what a chat turn replays: the newest text conversation's stored turns.
  await q(
    "conversations_recent",
    `select c.mode, to_char(max(m.created_at) at time zone '${TZ}', 'MM-DD HH24:MI') as last_message,
            count(*)::int as messages, count(*) filter (where m.role <> 'tool')::int as replayable,
            sum(length(m.content)) filter (where m.role <> 'tool')::int as replayable_chars
       from conversations c join messages m on m.conversation_id = c.id
      where c.user_id = $1 group by c.id, c.mode order by max(m.created_at) desc limit 8`,
    [uid]
  );

  // 7. The user's own data: names and counts only.
  await q(
    "projects",
    `select p.name, p.kind, p.status, (p.parent_id is not null) as nested,
            count(t.id)::int as tasks,
            count(t.id) filter (where t.status in ('inbox','todo','in_progress','blocked'))::int as open_tasks
       from projects p left join tasks t on t.project_id = p.id
      where p.user_id = $1 group by p.id order by p.kind, p.status, p.name`,
    [uid]
  );
  await q(
    "counts",
    `select (select count(*) from projects where user_id = $1)::int as projects,
            (select count(*) from projects where user_id = $1 and kind = 'list')::int as lists,
            (select count(*) from tasks where user_id = $1)::int as tasks,
            (select count(*) from events where user_id = $1)::int as events,
            (select count(*) from documents where user_id = $1)::int as documents,
            (select count(*) from memories where user_id = $1)::int as memories,
            (select count(*) from workspaces where user_id = $1)::int as workspaces,
            (select count(*) from canvas_snapshots where user_id = $1)::int as canvas_snapshots`,
    [uid]
  );
  // Words that would mark AV or equipment work, counted, never printed.
  await q(
    "keyword_counts",
    `select w as word,
            (select count(*) from projects where user_id = $1 and name ~* ('\\m' || w))::int as project_names,
            (select count(*) from tasks where user_id = $1 and title ~* ('\\m' || w))::int as task_titles,
            (select count(*) from events where user_id = $1 and title ~* ('\\m' || w))::int as event_titles,
            (select count(*) from documents where user_id = $1 and title ~* ('\\m' || w))::int as document_titles
       from unnest(array['av','a/v','audio','video','equipment','gear','sdi','cable','camera',
                         'projector','event','setup','checklist','shopping','findit']) as w`,
    [uid]
  );
  await q(
    "workspace_board",
    `select jsonb_array_length(coalesce(board->'widgets', '[]'::jsonb)) as widgets,
            to_char(updated_at at time zone '${TZ}', 'MM-DD HH24:MI') as updated
       from workspaces where user_id = $1`,
    [uid]
  );
  await client.query("rollback");
} finally {
  await client.end();
}
