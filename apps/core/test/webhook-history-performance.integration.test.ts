import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { webhookDeliveryHistoryStatement } from "../src/event-subscription-routes";

const legacySql = `SELECT d.id,d.event_id,d.status,d.attempt_count,d.queued_at,d.delivered_at,d.last_status_code,d.last_error,d.created_at,
        e.event_type,e.model_key,e.record_id,e.record_version,e.change_id,e.occurred_at
      FROM webhook_deliveries d
      JOIN event_subscriptions s ON s.id=d.subscription_id
      JOIN domain_event_outbox e ON e.id=d.event_id
      WHERE s.endpoint_id=? ORDER BY d.created_at DESC,d.id DESC LIMIT 50`;

describe("Endpoint delivery history read budget", () => {
  it("uses only endpoint-scoped subscriptions, retains retired filters and exact global top 50", async () => {
    const db = (env as unknown as {DB:D1Database}).DB;
    const suffix = crypto.randomUUID().replaceAll("-","");
    const user = `usr_${suffix}`, app = `app_${suffix}`, space = `spc_${suffix}`, otherSpace = `spc_other_${suffix}`;
    const selected = `whk_selected_${suffix}`, other = `whk_other_${suffix}`, empty = `whk_empty_${suffix}`;
    const active = `sub_active_${suffix}`, retired = `sub_retired_${suffix}`;
    const now = "2026-11-17T00:00:00.000Z";
    const makeSpace = (id:string) => db.prepare(
      "INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone) VALUES(?,?,?,?,?,'UTC')"
    ).bind(id,"History fixture",user,now,now);
    const makeEndpoint = (id:string,spaceId:string) => db.prepare(`INSERT INTO webhook_endpoints(
      id,application_id,space_id,subscriber_service_principal_id,name,webhook_url,signing_secret,created_by_user_id,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(id,app,spaceId,`svc_${suffix}`,"Fixture","https://example.com/hook","a".repeat(64),user,now,now);
    const makeSubscription = (id:string,endpoint:string,model:string,deleted:string|null,enabled:number) => db.prepare(`INSERT INTO event_subscriptions(
      id,endpoint_id,model_key,enabled,created_by_user_id,created_at,updated_at,deleted_at
    ) VALUES(?,?,?,?,?,?,?,?)`).bind(id,endpoint,model,enabled,user,now,now,deleted);
    await db.batch([makeSpace(space),makeSpace(otherSpace),makeEndpoint(selected,space),makeEndpoint(other,otherSpace),makeEndpoint(empty,space),
      makeSubscription(retired,selected,"task",now,0),makeSubscription(active,selected,"task",null,1)]);
    const pair = (i:number,subscription:string,spaceId:string,prefix:string) => {
      const event = `evt_${prefix}_${suffix}_${i}`;
      const delivery = `dlv_${prefix}_${suffix}_${String(i).padStart(3,"0")}`;
      // Tied timestamps exercise the global id DESC tie-breaker.
      const created = i%2===0 ? "2026-11-17T01:00:00.000Z" : now;
      return [
        db.prepare(`INSERT INTO domain_event_outbox(id,event_type,space_id,model_key,record_id,record_version,actor_type,actor_id,occurred_at)
          VALUES(?,'record.created',?,'task',?,1,'user',?,?)`).bind(event,spaceId,`rec_${prefix}_${suffix}_${i}`,user,created),
        db.prepare(`INSERT INTO webhook_deliveries(id,event_id,subscription_id,status,created_at,updated_at)
          VALUES(?,?,?,'succeeded',?,?)`).bind(delivery,event,subscription,created,created),
      ];
    };
    for(let offset=0;offset<240;offset+=20) {
      const statements:D1PreparedStatement[]=[];
      for(let i=offset;i<offset+20;i++){
        const sub=`sub_other_${suffix}_${i}`;
        statements.push(makeSubscription(sub,other,`fixture_${i}`,null,1),...pair(i,sub,otherSpace,"other"));
      }
      await db.batch(statements);
    }
    for(let offset=0;offset<60;offset+=20) {
      const statements:D1PreparedStatement[]=[];
      for(let i=offset;i<offset+20;i++)statements.push(...pair(i,i%2?retired:active,space,"selected"));
      await db.batch(statements);
    }
    const actual=await webhookDeliveryHistoryStatement(db,selected).all<Record<string,unknown>>();
    const old=await db.prepare(legacySql).bind(selected).all<Record<string,unknown>>();
    expect(actual.results).toEqual(old.results);
    expect(actual.results).toHaveLength(50);
    expect(actual.results.every(row=>String(row.id).startsWith("dlv_selected_"))).toBe(true);
    // 30 active + 20 of the 30 retired rows after global sorting.
    expect(actual.results.filter(row=>row.created_at===now)).toHaveLength(20);
    expect(actual.meta.rows_read).toBeLessThanOrEqual(250);
    const emptyResult=await webhookDeliveryHistoryStatement(db,empty).all();
    expect(emptyResult.results).toEqual([]);
    expect(emptyResult.meta.rows_read).toBeLessThanOrEqual(5);
    const missing=await webhookDeliveryHistoryStatement(db,`whk_missing_${suffix}`).all();
    expect(missing.results).toEqual([]);
    expect(missing.meta.rows_read).toBeLessThanOrEqual(5);
    // Use the same SQL text as the runtime (not a hand-written substitute).
    let captured="";
    const observed={prepare(sql:string){captured=sql;return db.prepare(sql);}} as unknown as D1Database;
    webhookDeliveryHistoryStatement(observed,selected);
    const plan=await db.prepare("EXPLAIN QUERY PLAN "+captured).bind(selected).all<{detail:string}>();
    const details=plan.results.map(row=>row.detail).join("\n");
    expect(details).toContain("idx_event_subscriptions_endpoint_history");
    expect(details).toContain("idx_webhook_deliveries_subscription");
    expect(details).not.toMatch(/SCAN (?:s|d|e)(?: |$)/u);
  });
});
