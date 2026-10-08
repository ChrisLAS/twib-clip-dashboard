import { safeUploadFolderUrl, type Episode } from "@twib/shared";

interface WorkspaceRow {
  id: string;
  imported_data: string | null;
  workspace_data: string | null;
  status: Episode["status"] | null;
  is_active: number | null;
  revision: number | null;
  upload_folder_url: string | null;
  clip_count: number;
  intake_count: number;
}
export async function workspaceEpisodes(
  db: D1Database,
  owner = "",
  id?: string,
): Promise<Episode[]> {
  const rows = await db
    .prepare(
      `SELECT ids.id,e.data AS imported_data,w.data AS workspace_data,w.status,w.is_active,w.revision,w.upload_folder_url,
    (SELECT count(*) FROM clips WHERE episode_id=ids.id) AS clip_count,
    (SELECT count(*) FROM manual_intake WHERE episode_id=ids.id AND owner=? AND status='awaiting_processing') AS intake_count
    FROM (SELECT id FROM episodes UNION SELECT id FROM episode_workspaces) ids
    LEFT JOIN episodes e ON e.id=ids.id LEFT JOIN episode_workspaces w ON w.id=ids.id
    ${id ? "WHERE ids.id=?" : ""}`,
    )
    .bind(owner, ...(id ? [id] : []))
    .all<WorkspaceRow>();
  return rows.results
    .map((row) => {
      const imported = row.imported_data
        ? (JSON.parse(row.imported_data) as Episode)
        : undefined;
      const workspace = row.workspace_data
        ? (JSON.parse(row.workspace_data) as Episode)
        : undefined;
      const base = workspace ?? imported;
      if (!base) throw new Error("Missing episode metadata");
      return {
        id: row.id,
        number: base.number,
        title: base.title,
        subtitle: base.subtitle,
        publishedGuid:
          imported?.publishedGuid ?? workspace?.publishedGuid ?? null,
        clipCount: row.clip_count,
        status: row.status ?? (imported?.publishedGuid ? "published" : "draft"),
        isActive: !!row.is_active,
        workspaceRevision: row.revision ?? 0,
        uploadFolderUrl: safeUploadFolderUrl(row.upload_folder_url),
        intakeCount: row.intake_count,
      };
    })
    .sort(
      (a, b) =>
        Number(b.isActive) - Number(a.isActive) ||
        b.number - a.number ||
        b.id.localeCompare(a.id),
    );
}
