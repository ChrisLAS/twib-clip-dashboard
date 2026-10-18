// Controlled SQL only: user input is never interpolated.
export const intakeCurrentSql = `EXISTS(SELECT 1 FROM manual_intake i JOIN episode_workspaces e ON e.id=i.episode_id WHERE i.id=w.intake_id AND i.owner=w.owner AND i.revision=w.intake_revision AND i.status='awaiting_processing' AND i.episode_id=w.episode_id AND e.revision=w.workspace_revision AND e.is_active=1 AND e.status='draft' AND json_extract(e.data,'$.number')=w.episode_number)`;
export function intakeClaimGuard(enabled: boolean) {
  const marker = "json_extract(capture_jobs.request_json,'$.intake_work_id')";
  return enabled
    ? `(${marker} IS NULL OR EXISTS(SELECT 1 FROM intake_work_requests w WHERE w.job_id=${marker} AND ${intakeCurrentSql} AND (capture_jobs.job_id=w.job_id OR EXISTS(SELECT 1 FROM intake_cut_authorizations a WHERE a.request_id=capture_jobs.job_id AND NOT EXISTS(SELECT 1 FROM inventory_cut_requests child WHERE child.source_plan_request_id=capture_jobs.job_id)))))`
    : `${marker} IS NULL`;
}
