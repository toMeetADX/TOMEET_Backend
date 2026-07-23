import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
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
        and table_name in ('users','messages','user_models','match_requests','match_rooms','room_members','offline_games','post_event_feedback','llm_jobs')
    `);
    expect(result.rows).toHaveLength(9);
    const memoryTables = await db.query<{ table_name: string }>(`
      select table_name from information_schema.tables
      where table_schema = 'public'
        and table_name in ('user_memories', 'user_memory_profiles')
    `);
    expect(memoryTables.rows).toHaveLength(2);
  });

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
        'public.wechat_message_receipts'::regclass
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
          'wechat_message_receipts'
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
});
