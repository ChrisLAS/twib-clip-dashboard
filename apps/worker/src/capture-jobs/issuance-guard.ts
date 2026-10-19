// Controlled SQL only. The caller validates the authenticated timestamp as a
// nonnegative safe integer before interpolation; no request input reaches SQL.
export function issuanceGuard(starts: number): string {
  if (!Number.isSafeInteger(starts) || starts < 0)
    throw new Error("Invalid issuance fence");
  const recent = (column: string) =>
    `typeof(${column})='integer' AND ${column}>=${starts}`;
  return `CASE
    WHEN json_type(capture_jobs.request_json,'$.intake_work_id') IS NOT NULL
    THEN EXISTS(SELECT 1 FROM intake_work_requests w
      WHERE w.job_id=json_extract(capture_jobs.request_json,'$.intake_work_id')
      AND w.owner=capture_jobs.owner AND ${recent("w.created_at")})
    WHEN coalesce(json_extract(capture_jobs.request_json,'$.kind'),'capture') IN ('cut','plan')
    THEN EXISTS(SELECT 1 FROM inventory_cut_requests c
      LEFT JOIN inventory_cut_requests root ON root.request_id=c.source_plan_request_id
      WHERE c.request_id=capture_jobs.job_id AND c.owner=capture_jobs.owner
      AND ((c.source_plan_request_id IS NULL AND ${recent("c.created_at")})
        OR (c.source_plan_request_id IS NOT NULL AND root.owner=c.owner
          AND root.source_plan_request_id IS NULL AND ${recent("root.created_at")})))
    ELSE (${recent("capture_jobs.created_at")})
  END`;
}
