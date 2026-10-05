from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# These edits apply to the working tree after apply_issue_306.py has generated the candidate.
route = ROOT / "apps/core/src/authorization-request-routes.ts"
text = route.read_text()

old_terminal = '''  } catch {\n    const refreshed = assertOwned(principal, actor, await loadRequest(env, spaceId, requestId));\n    if (status(refreshed.row) === target) return refreshed;\n    await afterTransitionConflict(env, principal, actor, spaceId, requestId);\n  }\n'''
new_terminal = '''  } catch (error) {\n    const refreshed = assertOwned(principal, actor, await loadRequest(env, spaceId, requestId));\n    const refreshedStatus = status(refreshed.row);\n    if (refreshedStatus === target) return refreshed;\n    if (refreshedStatus !== "pending") {\n      await afterTransitionConflict(env, principal, actor, spaceId, requestId);\n    }\n    throw error;\n  }\n'''
if text.count(old_terminal) != 1:
    raise SystemExit(f"terminal transition catch anchor count={text.count(old_terminal)}")
text = text.replace(old_terminal, new_terminal, 1)

old_confirm = '''    } catch {\n      const resolved = await afterTransitionConflict(context.env, principal, actor, spaceId, requestId);\n      return context.json(success(requestDto(resolved.current.row, resolved.current.items, {\n        delegations: resolved.delegations,\n      })));\n    }\n'''
new_confirm = '''    } catch (error) {\n      const refreshed = assertOwned(principal, actor, await loadRequest(context.env, spaceId, requestId));\n      if (status(refreshed.row) === "approved") {\n        return context.json(success(requestDto(refreshed.row, refreshed.items, {\n          delegations: await loadApprovedDelegations(context.env, requestId),\n        })));\n      }\n      if (status(refreshed.row) !== "pending") {\n        await afterTransitionConflict(context.env, principal, actor, spaceId, requestId);\n      }\n      throw error;\n    }\n'''
if text.count(old_confirm) != 1:
    raise SystemExit(f"confirm catch anchor count={text.count(old_confirm)}")
text = text.replace(old_confirm, new_confirm, 1)
route.write_text(text)

# Scope Delegation assertions to each unique test Space; D1 integration state is shared across test cases.
test = ROOT / "apps/core/test/authorization-request.integration.test.ts"
t = test.read_text()
anchor = '''async function count(db: D1Database, table: string, requestId?: string): Promise<number> {\n'''
helper = '''async function countDelegations(db: D1Database, spaceId: string): Promise<number> {\n  const row = await db.prepare("SELECT COUNT(*) AS count FROM delegations WHERE source_space_id=?")\n    .bind(spaceId).first<{ count: number }>();\n  return Number(row?.count ?? 0);\n}\n\n'''
if t.count(anchor) != 1:
    raise SystemExit("authorization-request test count helper anchor missing")
t = t.replace(anchor, helper + anchor, 1)
t = t.replace('count(db, "delegations")', 'countDelegations(db, spaceId)')
test.write_text(t)

# Schema 49 is now the canonical final Core migration state.
final_state = ROOT / "apps/core/test/final-migration-state.integration.test.ts"
f = final_state.read_text()
if f.count('expect(row?.value).toBe("48");') != 1:
    raise SystemExit("final migration schema assertion drifted")
f = f.replace('expect(row?.value).toBe("48");', 'expect(row?.value).toBe("49");', 1)
final_state.write_text(f)

# Keep the package release metadata aligned with the Kernel contract bump.
package = ROOT / "apps/core/package.json"
p = package.read_text()
if p.count('"version": "0.44.0"') != 1:
    raise SystemExit("core package version anchor drifted")
p = p.replace('"version": "0.44.0"', '"version": "0.45.0"', 1)
package.write_text(p)

# The workspace lockfile records workspace package versions; update only the Core importer value if present.
lock = ROOT / "pnpm-lock.yaml"
l = lock.read_text()
old = '''  apps/core:\n'''
if old not in l:
    raise SystemExit("pnpm lock Core importer missing")
# pnpm lock normally does not record the workspace package's own version, so no mutation is required here.

print("Applied #306 round-two correctness fixes")
