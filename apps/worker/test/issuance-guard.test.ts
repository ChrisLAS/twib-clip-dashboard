import { DatabaseSync } from "node:sqlite";
import { it, expect } from "vitest";
import { issuanceGuard } from "../src/capture-jobs/issuance-guard";
it("binds direct cut/plan jobs to original requests, including malformed and missing roots", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE capture_jobs(job_id TEXT,owner TEXT,request_json TEXT,created_at); CREATE TABLE intake_work_requests(job_id TEXT,owner TEXT,created_at); CREATE TABLE inventory_cut_requests(request_id TEXT,owner TEXT,source_plan_request_id TEXT,created_at)",
    );
    const check = () =>
      db
        .prepare("SELECT " + issuanceGuard(100) + " eligible FROM capture_jobs")
        .get()?.eligible;
    db.prepare("INSERT INTO capture_jobs VALUES('child','owner',?,200)").run(
      JSON.stringify({ kind: "cut" }),
    );
    db.exec(
      "INSERT INTO inventory_cut_requests VALUES('child','owner','root',200)",
    );
    expect(check()).toBe(0);
    db.exec(
      "INSERT INTO inventory_cut_requests VALUES('root','owner',NULL,99)",
    );
    expect(check()).toBe(0);
    db.exec(
      "UPDATE inventory_cut_requests SET created_at=100 WHERE request_id='root'",
    );
    expect(check()).toBe(1);
    db.exec(
      "UPDATE inventory_cut_requests SET created_at='invalid' WHERE request_id='root'",
    );
    expect(check()).toBe(0);
    db.exec(
      "UPDATE inventory_cut_requests SET source_plan_request_id=NULL,created_at=100 WHERE request_id='child'",
    );
    expect(check()).toBe(1);
    db.exec(
      "UPDATE inventory_cut_requests SET created_at=99 WHERE request_id='child'",
    );
    expect(check()).toBe(0);
    db.exec('UPDATE capture_jobs SET request_json=\'{"kind":"plan"}\'');
    expect(check()).toBe(0);
    db.exec(
      "UPDATE inventory_cut_requests SET created_at=100 WHERE request_id='child'",
    );
    expect(check()).toBe(1);
    db.exec(
      'UPDATE capture_jobs SET request_json=\'{"intake_work_id":"root"}\'',
    );
    db.exec(
      "INSERT INTO intake_work_requests VALUES('root','owner','invalid')",
    );
    expect(check()).toBe(0);
  } finally {
    db.close();
  }
});
it.each([NaN, Infinity, -1, 1.5])("rejects invalid fence %s", (value) =>
  expect(() => issuanceGuard(value)).toThrow(),
);
