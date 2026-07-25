import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { adventurexWelcomeContent } from "@tomeet/contracts";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema auth;
    create table auth.users (
      id uuid primary key,
      email text,
      raw_user_meta_data jsonb
    );
    insert into auth.users (id, email, raw_user_meta_data)
    values (
      '25000000-0000-4000-8000-000000000001',
      'existing@example.com',
      '{"display_name":"已有 Auth 用户"}'::jsonb
    );
    create schema storage;
    create table storage.buckets (
      id text primary key,
      name text not null,
      public boolean not null,
      file_size_limit bigint,
      allowed_mime_types text[]
    );
  `);
  const migrationsDirectory = resolve(process.cwd(), "../../supabase/migrations");
  const migrationFiles = (await readdir(migrationsDirectory))
    .filter((fileName) => fileName.endsWith(".sql"))
    .sort();
  for (const fileName of migrationFiles) {
    const migration = (await readFile(resolve(migrationsDirectory, fileName), "utf8"))
      .replace("create extension if not exists pgcrypto;", "");
    await db.exec(migration);
  }
}, 30_000);

afterAll(async () => {
  await db.close();
});

describe("Supabase migration", () => {
  it("creates all core tables", async () => {
    const result = await db.query<{ table_name: string }>(`
      select table_name from information_schema.tables
      where table_schema = 'public'
        and table_name in ('users','messages','user_models','match_requests','match_rooms','room_members','match_invites','offline_games','post_event_feedback','llm_jobs')
    `);
    expect(result.rows).toHaveLength(10);
    const memoryTables = await db.query<{ table_name: string }>(`
      select table_name from information_schema.tables
      where table_schema = 'public'
        and table_name in ('user_memories', 'user_memory_profiles')
    `);
    expect(memoryTables.rows).toHaveLength(2);
  });

  it("consolidates duplicate operational records while preserving compatibility views", async () => {
    const relations = await db.query<{ relname: string; relkind: string }>(`
      select relname, relkind
      from pg_class
      where oid in (
        'public.users'::regclass,
        'public.user_models'::regclass,
        'public.adventurex_onboarding_states'::regclass,
        'public.channel_message_deliveries'::regclass,
        'public.wechat_message_receipts'::regclass,
        'public.wechat_outbound_messages'::regclass
      )
      order by relname
    `);
    expect(Object.fromEntries(relations.rows.map((row) => [row.relname, row.relkind])))
      .toEqual({
        adventurex_onboarding_states: "v",
        channel_message_deliveries: "r",
        user_models: "v",
        users: "r",
        wechat_message_receipts: "v",
        wechat_outbound_messages: "v"
      });

    const columns = await db.query<{ table_name: string; column_name: string }>(`
      select table_name, column_name
      from information_schema.columns
      where table_schema = 'public'
        and (
          (table_name = 'users' and column_name in (
            'vibe_narrative',
            'user_model_version',
            'adventurex_stage',
            'adventurex_welcome_sent_at'
          ))
          or (table_name = 'messages' and column_name in (
            'source_channel',
            'reply_to_message_id'
          ))
        )
    `);
    expect(new Set(columns.rows.map((row) => `${row.table_name}.${row.column_name}`)))
      .toEqual(new Set([
        "users.vibe_narrative",
        "users.user_model_version",
        "users.adventurex_stage",
        "users.adventurex_welcome_sent_at",
        "messages.source_channel",
        "messages.reply_to_message_id"
      ]));
  });

  it("backfills existing iLink connections into the shared channel identity map", async () => {
    const legacyDb = new PGlite();
    try {
      await legacyDb.exec(`
        create role anon;
        create role authenticated;
        create role service_role bypassrls;
        create schema auth;
        create table auth.users (
          id uuid primary key,
          email text,
          raw_user_meta_data jsonb
        );
        create schema storage;
        create table storage.buckets (
          id text primary key,
          name text not null,
          public boolean not null,
          file_size_limit bigint,
          allowed_mime_types text[]
        );
      `);
      const migrationsDirectory = resolve(process.cwd(), "../../supabase/migrations");
      const migrationFiles = (await readdir(migrationsDirectory))
        .filter((fileName) => fileName.endsWith(".sql"))
        .sort();
      const consolidationMigration = "20260725220000_shared_channel_data_model.sql";
      for (const fileName of migrationFiles.filter((name) => name < consolidationMigration)) {
        const migration = (await readFile(resolve(migrationsDirectory, fileName), "utf8"))
          .replace("create extension if not exists pgcrypto;", "");
        await legacyDb.exec(migration);
      }

      const userId = "26000000-0000-4000-8000-000000000001";
      await legacyDb.query("select ensure_tomeet_user($1::uuid, 'Existing iLink User')", [userId]);
      await legacyDb.query(`
        insert into wechat_ilink_connections (
          user_id, ilink_bot_id, owner_ilink_user_id, bot_token_ciphertext, base_url
        ) values (
          $1::uuid, 'existing-ilink-bot', 'existing-ilink-owner', repeat('z',32),
          'https://ilink.example.com'
        )
      `, [userId]);

      const migration = (await readFile(
        resolve(migrationsDirectory, consolidationMigration),
        "utf8"
      )).replace("create extension if not exists pgcrypto;", "");
      await legacyDb.exec(migration);
      const identity = await legacyDb.query<{ provider: string; external_user_id: string; user_id: string }>(`
        select provider, external_user_id, user_id
        from channel_identities
        where provider = 'wechat' and external_user_id = 'existing-ilink-owner'
      `);
      expect(identity.rows).toEqual([{
        provider: "wechat",
        external_user_id: "existing-ilink-owner",
        user_id: userId
      }]);
    } finally {
      await legacyDb.close();
    }
  }, 30_000);

  it("keeps WeChat identities server-managed and one-to-one", async () => {
    const table = await db.query<{ relrowsecurity: boolean }>(`
      select relrowsecurity
      from pg_class
      where oid = 'public.channel_identities'::regclass
    `);
    expect(table.rows[0]?.relrowsecurity).toBe(true);

    const clientGrants = await db.query<{ grantee: string }>(`
      select grantee
      from information_schema.role_table_grants
      where table_schema = 'public'
        and table_name = 'channel_identities'
        and grantee in ('anon', 'authenticated')
    `);
    expect(clientGrants.rows).toHaveLength(0);
    const clientFunctionGrants = await db.query<{
      anon_activate: boolean;
      authenticated_claim: boolean;
    }>(`
      select
        has_function_privilege(
          'anon',
          'public.activate_wechat_ilink_session(uuid,uuid,text,text,text,text)',
          'execute'
        ) as anon_activate,
        has_function_privilege(
          'authenticated',
          'public.claim_wechat_ilink_connections(text,integer,integer)',
          'execute'
        ) as authenticated_claim
    `);
    expect(clientFunctionGrants.rows[0]).toEqual({
      anon_activate: false,
      authenticated_claim: false
    });

    const firstUserId = "23000000-0000-4000-8000-000000000001";
    const secondUserId = "23000000-0000-4000-8000-000000000002";
    await db.query("select ensure_tomeet_user($1::uuid, 'First Channel User')", [firstUserId]);
    await db.query("select ensure_tomeet_user($1::uuid, 'Second Channel User')", [secondUserId]);
    await db.query(`
      insert into public.channel_identities (provider, external_user_id, user_id)
      values ('wechat', 'wxid_first', $1::uuid)
    `, [firstUserId]);

    await expect(db.query(`
      insert into public.channel_identities (provider, external_user_id, user_id)
      values ('wechat', 'wxid_first', $1::uuid)
    `, [secondUserId])).rejects.toThrow();
    await expect(db.query(`
      insert into public.channel_identities (provider, external_user_id, user_id)
      values ('wechat', 'wxid_second', $1::uuid)
    `, [firstUserId])).rejects.toThrow();
  });

  it("atomically provisions encrypted iLink connections with server-only access", async () => {
    const tables = await db.query<{ relname: string; relrowsecurity: boolean }>(`
      select relname, relrowsecurity
      from pg_class
      where oid in (
        'public.wechat_connection_sessions'::regclass,
        'public.wechat_ilink_connections'::regclass,
        'public.channel_message_deliveries'::regclass
      )
      order by relname
    `);
    expect(tables.rows).toHaveLength(3);
    expect(tables.rows.every((row) => row.relrowsecurity)).toBe(true);
    const plaintextQrColumns = await db.query<{ column_name: string }>(`
      select column_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'wechat_connection_sessions'
        and column_name = 'qr_code_content'
    `);
    expect(plaintextQrColumns.rows).toHaveLength(0);

    const clientGrants = await db.query<{ grantee: string }>(`
      select grantee
      from information_schema.role_table_grants
      where table_schema = 'public'
        and table_name in (
          'wechat_connection_sessions',
          'wechat_ilink_connections',
          'channel_message_deliveries'
        )
        and grantee in ('PUBLIC', 'anon', 'authenticated')
    `);
    expect(clientGrants.rows).toHaveLength(0);

    const sessionId = "24000000-0000-4000-8000-000000000001";
    const newUserId = "24000000-0000-4000-8000-000000000002";
    await db.query(`
      insert into public.wechat_connection_sessions (
        id,
        session_token_hash,
        qr_token_ciphertext,
        expires_at
      ) values (
        $1::uuid,
        repeat('a', 64),
        repeat('b', 64),
        now() + interval '5 minutes'
      )
    `, [sessionId]);
    const activation = await db.query<{
      activate_wechat_ilink_session: {
        session: { status: string; user_id: string };
        connection: { status: string; user_id: string };
      };
    }>(`
      select public.activate_wechat_ilink_session(
        $1::uuid,
        $2::uuid,
        'ilink-owner-migration',
        'ilink-bot-migration',
        repeat('c', 64),
        'https://ilink.example.com'
      )
    `, [sessionId, newUserId]);
    expect(activation.rows[0]?.activate_wechat_ilink_session.session).toMatchObject({
      status: "active",
      user_id: newUserId
    });
    expect(activation.rows[0]?.activate_wechat_ilink_session.connection).toMatchObject({
      status: "active",
      user_id: newUserId
    });

    const profileParts = await db.query<{ count: number }>(`
      select (
        (select count(*) from public.users where id = $1::uuid)
        + (select count(*) from public.conversations where user_id = $1::uuid)
        + (select count(*) from public.user_models where user_id = $1::uuid)
        + (select count(*) from public.user_memory_profiles where user_id = $1::uuid)
      )::integer as count
    `, [newUserId]);
    expect(profileParts.rows[0]?.count).toBe(4);

    const reconnectSessionId = "24000000-0000-4000-8000-000000000003";
    const unusedNewUserId = "24000000-0000-4000-8000-000000000004";
    await db.query(`
      insert into public.wechat_connection_sessions (
        id,
        session_token_hash,
        qr_token_ciphertext,
        expires_at
      ) values (
        $1::uuid,
        repeat('d', 64),
        repeat('e', 64),
        now() + interval '5 minutes'
      )
    `, [reconnectSessionId]);
    const reconnect = await db.query<{
      activate_wechat_ilink_session: {
        session: { user_id: string };
        connection: { user_id: string; bot_token_ciphertext: string };
      };
    }>(`
      select public.activate_wechat_ilink_session(
        $1::uuid,
        $2::uuid,
        'ilink-owner-migration',
        'ilink-bot-rotated',
        repeat('f', 64),
        'https://ilink-rotated.example.com'
      )
    `, [reconnectSessionId, unusedNewUserId]);
    expect(reconnect.rows[0]?.activate_wechat_ilink_session.session.user_id)
      .toBe(newUserId);
    expect(reconnect.rows[0]?.activate_wechat_ilink_session.connection).toMatchObject({
      user_id: newUserId,
      bot_token_ciphertext: "f".repeat(64)
    });
    const connectionCount = await db.query<{ count: number }>(`
      select count(*)::integer as count
      from public.wechat_ilink_connections
      where owner_ilink_user_id = 'ilink-owner-migration'
    `);
    expect(connectionCount.rows[0]?.count).toBe(1);

    const conflictingUserId = "24000000-0000-4000-8000-000000000005";
    const conflictingSessionId = "24000000-0000-4000-8000-000000000006";
    await db.query("select ensure_tomeet_user($1::uuid, 'Conflicting WeChat User')", [
      conflictingUserId
    ]);
    await db.query(`
      insert into public.wechat_connection_sessions (
        id,
        session_token_hash,
        qr_token_ciphertext,
        expires_at,
        requested_user_id
      ) values (
        $1::uuid,
        repeat('1', 64),
        repeat('2', 64),
        now() + interval '5 minutes',
        $2::uuid
      )
    `, [conflictingSessionId, conflictingUserId]);
    await expect(db.query(`
      select public.activate_wechat_ilink_session(
        $1::uuid,
        $2::uuid,
        'ilink-owner-migration',
        'ilink-bot-conflict',
        repeat('3', 64),
        'https://ilink.example.com'
      )
    `, [conflictingSessionId, unusedNewUserId])).rejects.toThrow();

    const claimed = await db.query<{
      claim_wechat_ilink_connections: Array<{ id: string; lease_owner: string }>;
    }>("select public.claim_wechat_ilink_connections('migration-worker', 4, 90)");
    expect(claimed.rows[0]?.claim_wechat_ilink_connections).toHaveLength(1);
    expect(claimed.rows[0]?.claim_wechat_ilink_connections[0]?.lease_owner)
      .toBe("migration-worker");
    const connectionId = claimed.rows[0]!.claim_wechat_ilink_connections[0]!.id;
    await db.query(
      "select public.fail_wechat_ilink_connection($1::uuid, 'migration-worker', 'reauth', true)",
      [connectionId]
    );
    const reauth = await db.query<{ status: string; lease_owner: string | null }>(`
      select status, lease_owner
      from public.wechat_ilink_connections
      where id = $1::uuid
    `, [connectionId]);
    expect(reauth.rows[0]).toEqual({
      status: "reauth_required",
      lease_owner: null
    });

    const firstReceipt = await db.query<{ begin_wechat_message: boolean }>(
      "select public.begin_wechat_message($1::uuid, 'msg-1')",
      [connectionId]
    );
    const duplicateReceipt = await db.query<{ begin_wechat_message: boolean }>(
      "select public.begin_wechat_message($1::uuid, 'msg-1')",
      [connectionId]
    );
    expect(firstReceipt.rows[0]?.begin_wechat_message).toBe(true);
    expect(duplicateReceipt.rows[0]?.begin_wechat_message).toBe(false);
  });

  it("backfills and synchronizes Supabase Auth users", async () => {
    const existingUserId = "25000000-0000-4000-8000-000000000001";
    const existing = await db.query<{ display_name: string }>(
      "select display_name from public.users where id = $1::uuid",
      [existingUserId]
    );
    expect(existing.rows[0]?.display_name).toBe("已有 Auth 用户");

    const newUserId = "25000000-0000-4000-8000-000000000002";
    await db.query(`
      insert into auth.users (id, email, raw_user_meta_data)
      values ($1::uuid, 'new@example.com', '{"full_name":"新注册用户"}'::jsonb)
    `, [newUserId]);

    const created = await db.query<{
      display_name: string;
      conversation_count: number;
      model_count: number;
      profile_count: number;
    }>(`
      select
        u.display_name,
        (select count(*)::integer from conversations where user_id = u.id) as conversation_count,
        (select count(*)::integer from user_models where user_id = u.id) as model_count,
        (select count(*)::integer from user_memory_profiles where user_id = u.id) as profile_count
      from users u
      where u.id = $1::uuid
    `, [newUserId]);
    expect(created.rows[0]).toEqual({
      display_name: "新注册用户",
      conversation_count: 1,
      model_count: 1,
      profile_count: 1
    });

    await db.query(`
      update auth.users
      set raw_user_meta_data = '{"display_name":"更新后的名字"}'::jsonb
      where id = $1::uuid
    `, [newUserId]);
    const updated = await db.query<{ display_name: string }>(
      "select display_name from public.users where id = $1::uuid",
      [newUserId]
    );
    expect(updated.rows[0]?.display_name).toBe("更新后的名字");

    await db.query("delete from auth.users where id = $1::uuid", [newUserId]);
    const deleted = await db.query<{ count: number }>(
      "select count(*)::integer as count from public.users where id = $1::uuid",
      [newUserId]
    );
    expect(deleted.rows[0]?.count).toBe(0);
  });

  it("executes idempotent request and skip-locked job RPCs", async () => {
    const userId = "20000000-0000-4000-8000-000000000001";
    await db.query("select ensure_tomeet_user($1::uuid, '迁移测试用户')", [userId]);
    const first = await db.query<{ create_match_request: Record<string, unknown> }>(
      "select create_match_request($1::uuid, $2::jsonb)",
      [userId, JSON.stringify({ rawText: "想认识新朋友" })]
    );
    const second = await db.query<{ create_match_request: Record<string, unknown> }>(
      "select create_match_request($1::uuid, $2::jsonb)",
      [userId, JSON.stringify({ rawText: "重复请求" })]
    );
    expect(first.rows[0]?.create_match_request.id).toBe(second.rows[0]?.create_match_request.id);

    await db.query("select enqueue_llm_job('matchmaking', '{}'::jsonb, 'migration-job', 3)");
    const claimed = await db.query<{ claim_llm_job: Record<string, unknown> }>("select claim_llm_job('worker-1')");
    expect(claimed.rows[0]?.claim_llm_job.status).toBe("processing");
    const empty = await db.query<{ claim_llm_job: Record<string, unknown> | null }>("select claim_llm_job('worker-2')");
    expect(empty.rows[0]?.claim_llm_job).toBeNull();
  });

  it("adds persistent conversation summary progress", async () => {
    const result = await db.query<{ column_name: string }>(`
      select column_name from information_schema.columns
      where table_schema = 'public'
        and table_name = 'conversations'
        and column_name = 'summarized_message_count'
    `);
    expect(result.rows).toHaveLength(1);
    const vibeColumn = await db.query<{ column_name: string }>(`
      select column_name from information_schema.columns
      where table_schema = 'public'
        and table_name = 'user_models'
        and column_name = 'vibe_narrative'
    `);
    expect(vibeColumn.rows).toHaveLength(1);
  });

  it("stores, supersedes, and forgets only owned memory rows", async () => {
    const userId = "21000000-0000-4000-8000-000000000001";
    const sourceId = "22000000-0000-4000-8000-000000000001";
    await db.query("select ensure_tomeet_user($1::uuid, '记忆测试用户')", [userId]);
    const first = await db.query<{
      apply_user_memory_changes: { memories: Array<{ id: string }> };
    }>(`
      select apply_user_memory_changes(
        $1::uuid,
        'message',
        $2,
        'explicit',
        $3::jsonb,
        '{}'::uuid[]
      )
    `, [
      userId,
      sourceId,
      JSON.stringify([{
        kind: "preference",
        stableKey: "coffee_place",
        content: "用户明确喜欢安静的咖啡馆",
        expiresAt: null
      }])
    ]);
    const firstId = first.rows[0]!.apply_user_memory_changes.memories[0]!.id;

    const corrected = await db.query<{
      apply_user_memory_changes: { memories: Array<{ id: string }> };
    }>(`
      select apply_user_memory_changes(
        $1::uuid,
        'message',
        $2,
        'explicit',
        $3::jsonb,
        '{}'::uuid[]
      )
    `, [
      userId,
      sourceId,
      JSON.stringify([{
        kind: "preference",
        stableKey: "coffee_place",
        content: "用户明确更喜欢有自然光的咖啡馆",
        expiresAt: null
      }])
    ]);
    const correctedId = corrected.rows[0]!.apply_user_memory_changes.memories[0]!.id;
    expect(correctedId).not.toBe(firstId);
    const statuses = await db.query<{ id: string; status: string; superseded_by: string | null }>(
      "select id, status, superseded_by from user_memories where user_id = $1::uuid order by created_at",
      [userId]
    );
    expect(statuses.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: firstId, status: "superseded", superseded_by: correctedId }),
      expect.objectContaining({ id: correctedId, status: "active" })
    ]));

    await db.query(`
      select apply_user_memory_changes(
        $1::uuid,
        'message',
        $2,
        'explicit',
        '[]'::jsonb,
        array[$3::uuid]
      )
    `, [userId, sourceId, correctedId]);
    const forgotten = await db.query<{ status: string }>(
      "select status from user_memories where id = $1::uuid",
      [correctedId]
    );
    expect(forgotten.rows[0]?.status).toBe("forgotten");
    const profile = await db.query<{ stale: boolean }>(
      "select stale from user_memory_profiles where user_id = $1::uuid",
      [userId]
    );
    expect(profile.rows[0]?.stale).toBe(true);
  });

  it("serializes jobs per user partition while allowing other users to proceed", async () => {
    await db.query(
      "select enqueue_llm_job('agent_reply', '{}'::jsonb, 'fifo-a-1', 3, 'user:a')"
    );
    await db.query(
      "select enqueue_llm_job('memory_extract', '{}'::jsonb, 'fifo-a-2', 3, 'user:a')"
    );
    await db.query(
      "select enqueue_llm_job('agent_reply', '{}'::jsonb, 'fifo-b-1', 3, 'user:b')"
    );
    const first = await db.query<{ claim_llm_job: { id: string; partition_key: string } }>(
      "select claim_llm_job('fifo-worker-1')"
    );
    expect(first.rows[0]?.claim_llm_job.partition_key).toBe("user:a");
    const second = await db.query<{ claim_llm_job: { id: string; partition_key: string } }>(
      "select claim_llm_job('fifo-worker-2')"
    );
    expect(second.rows[0]?.claim_llm_job.partition_key).toBe("user:b");
    await db.query("select complete_llm_job($1::uuid, '{}'::jsonb)", [
      first.rows[0]!.claim_llm_job.id
    ]);
    const third = await db.query<{ claim_llm_job: { partition_key: string } }>(
      "select claim_llm_job('fifo-worker-3')"
    );
    expect(third.rows[0]?.claim_llm_job.partition_key).toBe("user:a");
  });

  it("supports the AdventureX welcome, sourced hooks, choices, and atomic settlement", async () => {
    const userIds = [
      "71000000-0000-4000-8000-000000000001",
      "71000000-0000-4000-8000-000000000002",
      "71000000-0000-4000-8000-000000000003"
    ];
    for (const [index, userId] of userIds.entries()) {
      await db.query("select ensure_tomeet_user($1::uuid, $2)", [userId, `AdventureX用户${index + 1}`]);
    }
    await db.query("select start_adventurex_onboarding($1::uuid)", [userIds[0]]);
    await db.query("select start_adventurex_onboarding($1::uuid)", [userIds[0]]);
    const welcome = await db.query<{ count: number; content: string }>(`
      select count(*)::integer as count, min(content) as content from messages
      where user_id = $1::uuid and idempotency_key = 'adventurex-welcome:zh:' || $1::text
    `, [userIds[0]]);
    expect(welcome.rows[0]?.count).toBe(1);
    expect(welcome.rows[0]?.content).toBe(adventurexWelcomeContent("zh"));
    const updatedOnboarding = await db.query<{
      preferred_language: string;
      boundary_prompted_at: string | null;
    }>(`
      select preferred_language, boundary_prompted_at
      from jsonb_populate_record(
        null::adventurex_onboarding_states,
        update_adventurex_onboarding_state($1::uuid,null,null,'en',true)
      )
    `, [userIds[0]]);
    expect(updatedOnboarding.rows[0]?.preferred_language).toBe("en");
    expect(updatedOnboarding.rows[0]?.boundary_prompted_at).not.toBeNull();

    const englishUserId = "71000000-0000-4000-8000-000000000004";
    await db.query("select ensure_tomeet_user($1::uuid, 'English User')", [englishUserId]);
    await db.query("select start_adventurex_onboarding($1::uuid,'en')", [englishUserId]);
    await db.query("select start_adventurex_onboarding($1::uuid,'en')", [englishUserId]);
    const englishWelcome = await db.query<{ count: number; content: string; preferred_language: string }>(`
      select count(m.*)::integer as count, min(m.content) as content, min(s.preferred_language) as preferred_language
      from adventurex_onboarding_states s
      left join messages m on m.user_id = s.user_id
        and m.idempotency_key = 'adventurex-welcome:en:' || s.user_id::text
      where s.user_id = $1::uuid
    `, [englishUserId]);
    expect(englishWelcome.rows[0]).toEqual({
      count: 1,
      content: adventurexWelcomeContent("en"),
      preferred_language: "en"
    });

    const existingConversationUserId = "71000000-0000-4000-8000-000000000005";
    await db.query("select ensure_tomeet_user($1::uuid, 'Existing Conversation')", [existingConversationUserId]);
    await db.query("select append_agent_message($1::uuid,'user','已经聊过','existing-conversation')", [existingConversationUserId]);
    const existingStart = await db.query<{ start_adventurex_onboarding: { message: unknown } }>(
      "select start_adventurex_onboarding($1::uuid,'zh')",
      [existingConversationUserId]
    );
    expect(existingStart.rows[0]?.start_adventurex_onboarding.message).toBeNull();

    const requestIds: string[] = [];
    for (const [index, userId] of userIds.entries()) {
      const message = await db.query<{ append_agent_message: { id: string } }>(
        "select append_agent_message($1::uuid,'user',$2,$3)",
        [userId, `我明确完成过第${index + 1}个项目`, `hook-source-${index}`]
      );
      await db.query("select * from save_social_hooks($1::uuid,$2::jsonb)", [
        userId,
        JSON.stringify([{
          hookText: `明确完成过第${index + 1}个项目`,
          evidenceMessageIds: [message.rows[0]!.append_agent_message.id]
        }])
      ]);
      const request = await db.query<{ create_match_request: { id: string } }>(
        "select create_match_request($1::uuid,$2::jsonb)",
        [userId, JSON.stringify({ rawText: "想参加现场活动" })]
      );
      requestIds.push(request.rows[0]!.create_match_request.id);
    }
    await db.query("select set_match_request_interest($1::uuid,'waiting',true,false)", [requestIds[0]]);
    const round = await db.query<{ create_or_get_match_round: { id: string } }>(
      "select create_or_get_match_round('adventurex-migration-round',now())"
    );
    const roundId = round.rows[0]!.create_or_get_match_round.id;
    for (const requestId of requestIds) {
      await db.query("select add_request_to_match_round($1::uuid,$2::uuid)", [roundId, requestId]);
    }
    const proposal = {
      drafts: [{
        tempDraftId: "draft-a",
        offlineGameId: "game-story-table",
        targetPlayers: 3,
        candidateRequestIds: requestIds,
        rationale: "每个人都能轮流进入故事交换"
      }],
      userOptions: requestIds.map((requestId) => ({ requestId, tempDraftIds: ["draft-a"] }))
    };
    const offers = requestIds.map((requestId) => ({
      requestId,
      sourceType: "draft",
      tempDraftId: "draft-a",
      sourceVersion: 0,
      optionNumber: 1,
      offlineGameId: "game-story-table",
      previewText: "**1｜故事交换桌**\n你可能遇见做过现场项目的人。",
      hooks: []
    }));
    await db.query("select * from save_match_round_proposals($1::uuid,$2::jsonb,$3::jsonb,now()+interval '90 seconds')", [
      roundId,
      JSON.stringify(proposal),
      JSON.stringify(offers)
    ]);
    for (const requestId of requestIds) {
      await db.query("select * from save_match_choices($1::uuid,1::smallint,array[1]::smallint[],'{}'::uuid[],'1'::text)", [requestId]);
    }
    const state = await db.query<{ get_match_round_settlement_state: { drafts: Array<{ id: string }> } }>(
      "select get_match_round_settlement_state($1::uuid)",
      [roundId]
    );
    const draftId = state.rows[0]!.get_match_round_settlement_state.drafts[0]!.id;
    const settled = await db.query<{ settle_match_round: string }>(
      "select * from settle_match_round($1::uuid,$2::jsonb)",
      [roundId, JSON.stringify([{
        draftId,
        offlineGameId: "game-story-table",
        requestIds,
        memberIds: userIds,
        targetPlayers: 3,
        summary: "AdventureX migration settle"
      }])]
    );
    expect(settled.rows).toHaveLength(1);
    const room = await db.query<{ get_match_room: { recruitmentStatus: string; members: unknown[] } }>(
      "select get_match_room($1::uuid)",
      [settled.rows[0]!.settle_match_round]
    );
    expect(room.rows[0]?.get_match_room.recruitmentStatus).toBe("full");
    expect(room.rows[0]?.get_match_room.members).toHaveLength(3);

    const roomId = settled.rows[0]!.settle_match_round;
    await expect(db.query(
      "select withdraw_room_member_with_reason($1::uuid,$2::uuid,null)",
      [roomId, userIds[0]]
    )).rejects.toThrow("理由");
    await db.query(
      "select withdraw_room_member_with_reason($1::uuid,$2::uuid,$3)",
      [roomId, userIds[0], "临时有事"]
    );
    const authorizedExit = await db.query<{
      withdrawal_reason: string;
      status: string;
      phase: string;
      proactive_push_enabled: boolean;
      room_id: string | null;
      active_round_id: string | null;
      options_expires_at: string | null;
    }>(`
      select rm.withdrawal_reason, mr.status, mr.phase, mr.proactive_push_enabled,
        mr.room_id, mr.active_round_id, mr.options_expires_at
      from room_members rm
      join match_requests mr on mr.user_id = rm.user_id
      where rm.room_id = $1::uuid and rm.user_id = $2::uuid
      order by mr.created_at desc
      limit 1
    `, [roomId, userIds[0]]);
    expect(authorizedExit.rows[0]).toEqual({
      withdrawal_reason: "临时有事",
      status: "matching",
      phase: "watching",
      proactive_push_enabled: true,
      room_id: null,
      active_round_id: null,
      options_expires_at: null
    });
    const repeatedRoom = await db.query<{ count: number }>(`
      select count(*)::integer as count
      from list_suitable_open_rooms($1::uuid,10) room
      where room->>'roomId' = $2
    `, [userIds[0], roomId]);
    expect(repeatedRoom.rows[0]?.count).toBe(0);

    await db.query(
      "select withdraw_room_member_with_reason($1::uuid,$2::uuid,$3)",
      [roomId, userIds[1], "想先休息一下"]
    );
    const ordinaryExit = await db.query<{ status: string; phase: string }>(
      "select status,phase from match_requests where id=$1::uuid",
      [requestIds[1]]
    );
    expect(ordinaryExit.rows[0]).toEqual({ status: "cancelled", phase: "waiting" });
    const eventPayloads = await db.query<{ payload: Record<string, unknown> }>(
      "select payload from room_change_events where room_id=$1::uuid and change_type='member_withdrawn'",
      [roomId]
    );
    expect(JSON.stringify(eventPayloads.rows)).not.toContain("临时有事");

    const functionGrants = await db.query<{ old_execute: boolean; new_execute: boolean }>(`
      select
        has_function_privilege('service_role','public.withdraw_room_member(uuid,uuid)','execute') as old_execute,
        has_function_privilege('service_role','public.withdraw_room_member_with_reason(uuid,uuid,text)','execute') as new_execute
    `);
    expect(functionGrants.rows[0]).toEqual({ old_execute: false, new_execute: true });
  });

  it("expires unmatched AdventureX requests and rematches only after explicit user action", async () => {
    const userId = "72000000-0000-4000-8000-000000000001";
    await db.query("select ensure_tomeet_user($1::uuid, '超时用户')", [userId]);
    const request = await db.query<{ create_match_request: { id: string } }>(
      "select create_match_request($1::uuid,$2::jsonb)",
      [userId, JSON.stringify({ rawText: "想认识人" })]
    );
    const requestId = request.rows[0]!.create_match_request.id;
    const round = await db.query<{ create_or_get_match_round: { id: string } }>(
      "select create_or_get_match_round('adventurex-expired-round',now())"
    );
    const roundId = round.rows[0]!.create_or_get_match_round.id;
    await db.query("select add_request_to_match_round($1::uuid,$2::uuid)", [roundId, requestId]);
    await db.query("select * from settle_match_round($1::uuid,'[]'::jsonb)", [roundId]);
    const expired = await db.query<{ status: string; active_round_id: string | null }>(
      "select status,active_round_id from match_requests where id=$1::uuid",
      [requestId]
    );
    expect(expired.rows[0]).toEqual({ status: "expired", active_round_id: null });
    const rematched = await db.query<{ restart_match_request: { id: string; status: string } }>(
      "select restart_match_request($1::uuid)",
      [requestId]
    );
    expect(rematched.rows[0]!.restart_match_request).toMatchObject({ status: "matching" });
    expect(rematched.rows[0]!.restart_match_request.id).not.toBe(requestId);
  });

  it("prioritizes active waiters, recalls watchers, and keeps proactive interest after an unmatched round", async () => {
    const waitingUserId = "73000000-0000-4000-8000-000000000001";
    const watchingUserId = "73000000-0000-4000-8000-000000000002";
    await db.query("select ensure_tomeet_user($1::uuid, '当前等待用户')", [waitingUserId]);
    await db.query("select ensure_tomeet_user($1::uuid, '主动推送用户')", [watchingUserId]);
    const waiting = await db.query<{ create_match_request: { id: string } }>(
      "select create_match_request($1::uuid,$2::jsonb)",
      [waitingUserId, JSON.stringify({ rawText: "现在想匹配" })]
    );
    const watching = await db.query<{ create_match_request: { id: string } }>(
      "select create_match_request($1::uuid,$2::jsonb)",
      [watchingUserId, JSON.stringify({ rawText: "有合适的再告诉我" })]
    );
    const waitingRequestId = waiting.rows[0]!.create_match_request.id;
    const watchingRequestId = watching.rows[0]!.create_match_request.id;
    await db.query(
      "select set_match_request_interest($1::uuid,'watching',true,true)",
      [watchingRequestId]
    );
    const round = await db.query<{ create_or_get_match_round: { id: string } }>(
      "select create_or_get_match_round('adventurex-watching-recall',now())"
    );
    const roundId = round.rows[0]!.create_or_get_match_round.id;
    await db.query("select add_request_to_match_round($1::uuid,$2::uuid)", [roundId, waitingRequestId]);
    const candidates = await db.query<{ list_match_round_candidates: { request: { id: string } } }>(
      "select * from list_match_round_candidates($1::uuid)",
      [roundId]
    );
    const relevantCandidateIds = new Set([waitingRequestId, watchingRequestId]);
    expect(candidates.rows
      .map((row) => row.list_match_round_candidates.request.id)
      .filter((requestId) => relevantCandidateIds.has(requestId))).toEqual([
      waitingRequestId,
      watchingRequestId
    ]);

    await db.query("select add_request_to_match_round($1::uuid,$2::uuid)", [roundId, watchingRequestId]);
    await db.query("select * from settle_match_round($1::uuid,'[]'::jsonb)", [roundId]);
    const settled = await db.query<{
      id: string;
      status: string;
      phase: string;
      proactive_push_enabled: boolean;
    }>(`
      select id,status,phase,proactive_push_enabled
      from match_requests where id in ($1::uuid,$2::uuid) order by id
    `, [waitingRequestId, watchingRequestId]);
    expect(settled.rows.find((row) => row.id === waitingRequestId)).toMatchObject({
      status: "expired",
      phase: "waiting",
      proactive_push_enabled: false
    });
    expect(settled.rows.find((row) => row.id === watchingRequestId)).toMatchObject({
      status: "matching",
      phase: "watching",
      proactive_push_enabled: true
    });
  });

  it("keeps an accepting unmatched user eligible for consent and prioritizes them among watchers", async () => {
    const participantUserIds = [
      "75000000-0000-4000-8000-000000000001",
      "75000000-0000-4000-8000-000000000002",
      "75000000-0000-4000-8000-000000000003"
    ];
    const requestIds: string[] = [];
    for (const [index, userId] of participantUserIds.entries()) {
      await db.query("select ensure_tomeet_user($1::uuid,$2)", [userId, `确认候选${index + 1}`]);
      const request = await db.query<{ create_match_request: { id: string } }>(
        "select create_match_request($1::uuid,$2::jsonb)",
        [userId, JSON.stringify({ rawText: "愿意参加候选局" })]
      );
      requestIds.push(request.rows[0]!.create_match_request.id);
    }
    const round = await db.query<{ create_or_get_match_round: { id: string } }>(
      "select create_or_get_match_round('adventurex-confirmation-incomplete',now())"
    );
    const roundId = round.rows[0]!.create_or_get_match_round.id;
    for (const requestId of requestIds) {
      await db.query("select add_request_to_match_round($1::uuid,$2::uuid)", [roundId, requestId]);
    }
    const proposal = {
      drafts: [{
        tempDraftId: "confirmation-incomplete-draft",
        offlineGameId: "game-story-table",
        targetPlayers: 3,
        candidateRequestIds: requestIds,
        rationale: "等待多人确认"
      }],
      userOptions: requestIds.map((requestId) => ({ requestId, tempDraftIds: ["confirmation-incomplete-draft"] }))
    };
    const offers = requestIds.map((requestId) => ({
      requestId,
      sourceType: "draft",
      tempDraftId: "confirmation-incomplete-draft",
      sourceVersion: 0,
      optionNumber: 1,
      offlineGameId: "game-story-table",
      previewText: "等待候选确认",
      hooks: []
    }));
    await db.query(
      "select * from save_match_round_proposals($1::uuid,$2::jsonb,$3::jsonb,now()+interval '90 seconds')",
      [roundId, JSON.stringify(proposal), JSON.stringify(offers)]
    );
    await db.query(
      "select * from save_match_choices($1::uuid,1::smallint,array[1]::smallint[],'{}'::uuid[],'愿意参加'::text)",
      [requestIds[0]]
    );
    await db.query("select * from settle_match_round($1::uuid,'[]'::jsonb)", [roundId]);

    const accepting = await db.query<{ status: string; phase: string; proactive_push_enabled: boolean }>(
      "select status,phase,proactive_push_enabled from match_requests where id=$1::uuid",
      [requestIds[0]]
    );
    expect(accepting.rows[0]).toEqual({
      status: "matching",
      phase: "push_consent",
      proactive_push_enabled: false
    });
    await db.query("select set_match_request_interest($1::uuid,'watching',true,true)", [requestIds[0]]);

    const normalWatcherUserId = "75000000-0000-4000-8000-000000000004";
    const activeUserId = "75000000-0000-4000-8000-000000000005";
    await db.query("select ensure_tomeet_user($1::uuid,'普通留意用户')", [normalWatcherUserId]);
    await db.query("select ensure_tomeet_user($1::uuid,'当前等待用户')", [activeUserId]);
    const normalWatcher = await db.query<{ create_match_request: { id: string } }>(
      "select create_match_request($1::uuid,$2::jsonb)",
      [normalWatcherUserId, JSON.stringify({ rawText: "有合适的再告诉我" })]
    );
    const active = await db.query<{ create_match_request: { id: string } }>(
      "select create_match_request($1::uuid,$2::jsonb)",
      [activeUserId, JSON.stringify({ rawText: "现在想匹配" })]
    );
    await db.query(
      "select set_match_request_interest($1::uuid,'watching',true,true)",
      [normalWatcher.rows[0]!.create_match_request.id]
    );
    const nextRound = await db.query<{ create_or_get_match_round: { id: string } }>(
      "select create_or_get_match_round('adventurex-confirmation-priority',now())"
    );
    const nextRoundId = nextRound.rows[0]!.create_or_get_match_round.id;
    await db.query("select add_request_to_match_round($1::uuid,$2::uuid)", [
      nextRoundId,
      active.rows[0]!.create_match_request.id
    ]);
    const candidates = await db.query<{
      list_match_round_candidates: { request: { id: string }; matching_priority: string };
    }>("select * from list_match_round_candidates($1::uuid)", [nextRoundId]);

    const relevantRequestIds = new Set([
      active.rows[0]!.create_match_request.id,
      requestIds[0]!,
      normalWatcher.rows[0]!.create_match_request.id
    ]);
    expect(candidates.rows.map((row) => ({
      requestId: row.list_match_round_candidates.request.id,
      priority: row.list_match_round_candidates.matching_priority
    })).filter((candidate) => relevantRequestIds.has(candidate.requestId))).toEqual([
      { requestId: active.rows[0]!.create_match_request.id, priority: "active_waiting" },
      { requestId: requestIds[0], priority: "confirmation_follow_up" },
      { requestId: normalWatcher.rows[0]!.create_match_request.id, priority: "watching" }
    ]);
  });

  it("isolates owner virtual users and supports retryable WeChat proactive delivery", async () => {
    const ownerUserId = "74000000-0000-4000-8000-000000000001";
    const realUserId = "74000000-0000-4000-8000-000000000002";
    await db.query("select ensure_tomeet_user($1::uuid, '测试池所有者')", [ownerUserId]);
    await db.query("select ensure_tomeet_user($1::uuid, '真实用户')", [realUserId]);
    const configured = await db.query<{
      configure_adventurex_test_pool: { enabled: boolean; provisionedUserCount: number };
    }>("select configure_adventurex_test_pool($1::uuid,true,5)", [ownerUserId]);
    expect(configured.rows[0]?.configure_adventurex_test_pool).toMatchObject({
      enabled: true,
      provisionedUserCount: 5
    });
    const virtualRequests = await db.query<{ prepare_adventurex_test_pool: { id: string } }>(
      "select * from prepare_adventurex_test_pool($1::uuid)",
      [ownerUserId]
    );
    expect(virtualRequests.rows).toHaveLength(5);
    const ownerRequest = await db.query<{ create_match_request: { id: string } }>(
      "select create_match_request($1::uuid,$2::jsonb)",
      [ownerUserId, JSON.stringify({ rawText: "测试匹配" })]
    );
    const testRound = await db.query<{ create_or_get_match_round: { id: string } }>(
      "select create_or_get_match_round($1,now())",
      [`adventurex-test:${ownerUserId}:migration`]
    );
    const testRoundId = testRound.rows[0]!.create_or_get_match_round.id;
    await db.query("select add_request_to_match_round($1::uuid,$2::uuid)", [
      testRoundId,
      ownerRequest.rows[0]!.create_match_request.id
    ]);
    for (const row of virtualRequests.rows) {
      await db.query("select add_request_to_match_round($1::uuid,$2::uuid)", [
        testRoundId,
        row.prepare_adventurex_test_pool.id
      ]);
    }
    const testCandidates = await db.query<{ count: number }>(
      "select count(*)::integer as count from list_match_round_candidates($1::uuid)",
      [testRoundId]
    );
    expect(testCandidates.rows[0]?.count).toBe(6);

    await db.query(`
      insert into wechat_ilink_connections (
        user_id,ilink_bot_id,owner_ilink_user_id,bot_token_ciphertext,base_url
      ) values ($1::uuid,'bot-outbound-migration','owner-outbound-migration',repeat('x',32),'https://ilink.example.com')
    `, [realUserId]);
    const message = await db.query<{ append_agent_message: { id: string } }>(
      "select append_agent_message($1::uuid,'assistant','主动候选提醒','outbound-migration-message','system',null::uuid)",
      [realUserId]
    );
    await db.query("select enqueue_wechat_outbound_message($1::uuid,$2::uuid,'主动候选提醒')", [
      realUserId,
      message.rows[0]!.append_agent_message.id
    ]);
    const claimed = await db.query<{
      claim_wechat_outbound_messages: { id: string; content: string; attempts: number };
    }>("select * from claim_wechat_outbound_messages('migration-worker',20)");
    expect(claimed.rows).toHaveLength(1);
    expect(claimed.rows[0]?.claim_wechat_outbound_messages).toMatchObject({
      content: "主动候选提醒",
      attempts: 1
    });
    const outboundId = claimed.rows[0]!.claim_wechat_outbound_messages.id;
    await db.query("select complete_wechat_outbound_message($1::uuid,'migration-worker','temporary failure')", [outboundId]);
    const retry = await db.query<{ status: string; attempts: number; last_error: string }>(
      "select status,attempts,last_error from wechat_outbound_messages where id=$1::uuid",
      [outboundId]
    );
    expect(retry.rows[0]).toMatchObject({
      status: "retry",
      attempts: 1,
      last_error: "temporary failure"
    });

    const webMessage = await db.query<{ append_agent_message: { id: string } }>(
      "select append_agent_message($1::uuid,'assistant','只在网页显示','web-only-message','web',null::uuid)",
      [realUserId]
    );
    await expect(db.query(
      "select enqueue_wechat_outbound_message($1::uuid,$2::uuid,'只在网页显示')",
      [realUserId, webMessage.rows[0]!.append_agent_message.id]
    )).rejects.toThrow("Web 对话消息不能投递到微信");
  });

  it("keeps memory tables and mutation RPCs unavailable to public roles", async () => {
    const privileges = await db.query<{
      anon_table: boolean;
      authenticated_table: boolean;
      anon_function: boolean;
    }>(`
      select
        has_table_privilege('anon', 'public.user_memories', 'select') as anon_table,
        has_table_privilege('authenticated', 'public.user_memory_profiles', 'select') as authenticated_table,
        has_function_privilege(
          'anon',
          'public.apply_user_memory_changes(uuid,text,text,text,jsonb,uuid[],boolean)',
          'execute'
        ) as anon_function
    `);
    expect(privileges.rows[0]).toEqual({
      anon_table: false,
      authenticated_table: false,
      anon_function: false
    });
  });

  it("keeps dynamic matchmaking state and RPCs service-role only", async () => {
    const privileges = await db.query<{
      rls_enabled: boolean;
      anon_table: boolean;
      authenticated_table: boolean;
      anon_accept: boolean;
      authenticated_stop: boolean;
      service_accept: boolean;
    }>(`
      select
        (select relrowsecurity from pg_class where oid = 'public.match_invites'::regclass) as rls_enabled,
        has_table_privilege('anon', 'public.match_invites', 'select') as anon_table,
        has_table_privilege('authenticated', 'public.match_invites', 'select') as authenticated_table,
        has_function_privilege('anon', 'public.accept_match_invite(uuid,uuid)', 'execute') as anon_accept,
        has_function_privilege('authenticated', 'public.stop_room_matching(uuid,uuid)', 'execute') as authenticated_stop,
        has_function_privilege('service_role', 'public.accept_match_invite(uuid,uuid)', 'execute') as service_accept
    `);
    expect(privileges.rows[0]).toEqual({
      rls_enabled: true,
      anon_table: false,
      authenticated_table: false,
      anon_accept: false,
      authenticated_stop: false,
      service_accept: true
    });
  });

  it("enforces the aligned match, room, history, and feedback lifecycle", async () => {
    const userIds = [
      "60000000-0000-4000-8000-000000000001",
      "60000000-0000-4000-8000-000000000002",
      "60000000-0000-4000-8000-000000000003"
    ];
    const requestIds: string[] = [];
    for (const [index, userId] of userIds.entries()) {
      await db.query("select ensure_tomeet_user($1::uuid, $2)", [userId, `用户${index + 1}`]);
      await db.query("update user_models set current_intent = $2::jsonb where user_id = $1::uuid", [
        userId,
        JSON.stringify({ rawText: "想认识新朋友", socialIntentConfirmed: true })
      ]);
      const request = await db.query<{ create_match_request: { id: string } }>(
        "select create_match_request($1::uuid, $2::jsonb)",
        [userId, JSON.stringify({ rawText: "想认识新朋友" })]
      );
      requestIds.push(request.rows[0]!.create_match_request.id);
    }

    const decision = {
      memberIds: userIds,
      requestIds,
      offlineGameId: "game-story-table",
      summary: "迁移生命周期测试"
    };
    const created = await db.query<{ create_match_room: string }>(
      "select create_match_room($1::jsonb, null)",
      [JSON.stringify(decision)]
    );
    const roomId = created.rows[0]!.create_match_room;
    const history = await db.query<{ social_history: string[] }>(
      "select social_history from user_models where user_id = $1::uuid",
      [userIds[0]]
    );
    expect(history.rows[0]!.social_history).toContain(roomId);
    await expect(db.query("select create_match_request($1::uuid, $2::jsonb)", [
      userIds[0],
      JSON.stringify({ rawText: "未完成房间时再次匹配" })
    ])).rejects.toThrow("你还有一个未结束的匹配房间");

    for (const userId of userIds) {
      await db.query("select confirm_room_member($1::uuid, $2::uuid)", [roomId, userId]);
    }
    await db.query("select complete_match_room($1::uuid)", [roomId]);
    const cleared = await db.query<{ current_intent: Record<string, unknown> }>(
      "select current_intent from user_models where user_id = $1::uuid",
      [userIds[0]]
    );
    expect(cleared.rows[0]!.current_intent).toEqual({});

    await db.query("update user_models set current_intent = $2::jsonb where user_id = $1::uuid", [
      userIds[0],
      JSON.stringify({ nextIntent: "下次继续深聊" })
    ]);
    await db.query("select complete_match_room($1::uuid)", [roomId]);
    const preserved = await db.query<{ current_intent: Record<string, unknown> }>(
      "select current_intent from user_models where user_id = $1::uuid",
      [userIds[0]]
    );
    expect(preserved.rows[0]!.current_intent).toEqual({ nextIntent: "下次继续深聊" });

    await expect(db.query("select save_post_event_feedback($1::jsonb)", [JSON.stringify({
      roomId,
      userId: userIds[0],
      peopleFeedback: "聊得很好",
      gameFeedback: "游戏自然",
      connectionUserIds: [userIds[0]],
      nextIntent: "下次继续"
    })])).rejects.toThrow("连接用户不能包含自己");
  });

  it("creates a room only after bilateral acceptance and fills it one invite at a time", async () => {
    const userIds = Array.from(
      { length: 7 },
      (_, index) => `70000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`
    );
    const requestIds: string[] = [];
    for (const [index, userId] of userIds.slice(0, 2).entries()) {
      await db.query("select ensure_tomeet_user($1::uuid, $2)", [userId, `动态用户${index + 1}`]);
      const request = await db.query<{ create_match_request: { id: string } }>(
        "select create_match_request($1::uuid, $2::jsonb)",
        [userId, JSON.stringify({ rawText: `动态匹配用户${index + 1}` })]
      );
      requestIds.push(request.rows[0]!.create_match_request.id);
    }

    const pairInvite = await db.query<{ create_initial_match_invite: { inviteId: string } }>(
      "select create_initial_match_invite($1::jsonb, null)",
      [JSON.stringify({
        memberIds: userIds.slice(0, 2),
        requestIds,
        offlineGameId: "game-story-table",
        summary: "先匹配当前最合适的两位用户"
      })]
    );
    const inviteId = pairInvite.rows[0]!.create_initial_match_invite.inviteId;
    const firstAccepted = await db.query<{
      accept_match_invite: { room: null };
    }>("select accept_match_invite($1::uuid, $2::uuid)", [inviteId, userIds[0]]);
    expect(firstAccepted.rows[0]!.accept_match_invite.room).toBeNull();

    const secondAccepted = await db.query<{
      accept_match_invite: {
        room: {
          roomId: string;
          matchingStatus: string;
          capacity: number;
          members: Array<{ userId: string }>;
        };
      };
    }>("select accept_match_invite($1::uuid, $2::uuid)", [inviteId, userIds[1]]);
    const initialRoom = secondAccepted.rows[0]!.accept_match_invite.room;
    expect(initialRoom.members).toHaveLength(2);
    expect(initialRoom.matchingStatus).toBe("active");
    expect(initialRoom.capacity).toBe(6);

    let latestRoom = initialRoom;
    for (const [offset, userId] of userIds.slice(2, 6).entries()) {
      await db.query("select ensure_tomeet_user($1::uuid, $2)", [userId, `扩房用户${offset + 3}`]);
      const request = await db.query<{ create_match_request: { id: string } }>(
        "select create_match_request($1::uuid, $2::jsonb)",
        [userId, JSON.stringify({ rawText: `加入动态房间${offset + 3}` })]
      );
      const requestId = request.rows[0]!.create_match_request.id;
      const joinInvite = await db.query<{ create_room_join_invite: { inviteId: string } }>(
        "select create_room_join_invite($1::jsonb, null)",
        [JSON.stringify({
          roomId: initialRoom.roomId,
          userId,
          requestId,
          summary: "当前队列里的最高匹配用户"
        })]
      );
      const accepted = await db.query<{
        accept_match_invite: { room: typeof initialRoom };
      }>(
        "select accept_match_invite($1::uuid, $2::uuid)",
        [joinInvite.rows[0]!.create_room_join_invite.inviteId, userId]
      );
      latestRoom = accepted.rows[0]!.accept_match_invite.room;
    }
    expect(latestRoom.members).toHaveLength(6);
    expect(latestRoom.matchingStatus).toBe("full");

    await db.query("select ensure_tomeet_user($1::uuid, $2)", [userIds[6], "满员后用户"]);
    const extraRequest = await db.query<{ create_match_request: { id: string } }>(
      "select create_match_request($1::uuid, $2::jsonb)",
      [userIds[6], JSON.stringify({ rawText: "房间满员后请求" })]
    );
    await expect(db.query("select create_room_join_invite($1::jsonb, null)", [JSON.stringify({
      roomId: initialRoom.roomId,
      userId: userIds[6],
      requestId: extraRequest.rows[0]!.create_match_request.id,
      summary: "不应进入满员房间"
    })])).rejects.toThrow("停止匹配");
  });

  it("lets any room member stop matching and requeues a pending invitee", async () => {
    const userIds = [
      "80000000-0000-4000-8000-000000000001",
      "80000000-0000-4000-8000-000000000002",
      "80000000-0000-4000-8000-000000000003"
    ];
    const requestIds: string[] = [];
    for (const [index, userId] of userIds.entries()) {
      await db.query("select ensure_tomeet_user($1::uuid, $2)", [userId, `停止测试用户${index + 1}`]);
      const request = await db.query<{ create_match_request: { id: string } }>(
        "select create_match_request($1::uuid, $2::jsonb)",
        [userId, JSON.stringify({ rawText: `停止测试${index + 1}` })]
      );
      requestIds.push(request.rows[0]!.create_match_request.id);
    }
    const pairInvite = await db.query<{ create_initial_match_invite: { inviteId: string } }>(
      "select create_initial_match_invite($1::jsonb, null)",
      [JSON.stringify({
        memberIds: userIds.slice(0, 2),
        requestIds: requestIds.slice(0, 2),
        offlineGameId: "game-city-clues",
        summary: "停止测试初始匹配"
      })]
    );
    const pairInviteId = pairInvite.rows[0]!.create_initial_match_invite.inviteId;
    await db.query("select accept_match_invite($1::uuid, $2::uuid)", [pairInviteId, userIds[0]]);
    const accepted = await db.query<{
      accept_match_invite: { room: { roomId: string } };
    }>("select accept_match_invite($1::uuid, $2::uuid)", [pairInviteId, userIds[1]]);
    const roomId = accepted.rows[0]!.accept_match_invite.room.roomId;

    const joinInvite = await db.query<{ create_room_join_invite: { inviteId: string } }>(
      "select create_room_join_invite($1::jsonb, null)",
      [JSON.stringify({
        roomId,
        userId: userIds[2],
        requestId: requestIds[2],
        summary: "停止前的待处理邀请"
      })]
    );
    const stopped = await db.query<{
      stop_room_matching: {
        room: { matchingStatus: string };
        requeuedRequestIds: string[];
      };
    }>("select stop_room_matching($1::uuid, $2::uuid)", [roomId, userIds[0]]);
    expect(stopped.rows[0]!.stop_room_matching.room.matchingStatus).toBe("stopped");
    expect(stopped.rows[0]!.stop_room_matching.requeuedRequestIds).toContain(requestIds[2]);

    const requeued = await db.query<{ status: string; invite_id: string | null }>(
      "select status, invite_id from match_requests where id = $1::uuid",
      [requestIds[2]]
    );
    expect(requeued.rows[0]).toMatchObject({ status: "matching", invite_id: null });
    await expect(db.query(
      "select accept_match_invite($1::uuid, $2::uuid)",
      [joinInvite.rows[0]!.create_room_join_invite.inviteId, userIds[2]]
    )).rejects.toThrow("失效");
  });
});
