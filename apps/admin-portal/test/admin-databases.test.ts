import test from "node:test";
import assert from "node:assert/strict";
import { parseAdminDatabase } from "../src/server/admin-databases.ts";

test("accepts only platform databases in the Super Admin explorer", () => {
  assert.equal(parseAdminDatabase("core"), "core");
  assert.equal(parseAdminDatabase("billing"), "billing");
  assert.equal(parseAdminDatabase("bsp"), "bsp");
  assert.equal(parseAdminDatabase("other"), null);
  assert.equal(parseAdminDatabase(null), null);
});
