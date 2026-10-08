import { useEffect, useState } from "react";
import type { CatalogStatus, EpisodeDetail } from "@twib/shared";
import { RefreshCw, TriangleAlert } from "lucide-react";
import { api } from "./api";
import {
  catalogUpdateLabel,
  catalogUpdates,
  startVisibleCatalogPolling,
} from "./catalog-sync";

export function CatalogSyncNotice({
  episode,
  reviewing,
  loading,
  pending,
  onApply,
  onCancel,
  onBack,
}: {
  episode: EpisodeDetail | null;
  reviewing: boolean;
  loading: boolean;
  pending: boolean;
  onApply: () => void;
  onCancel: () => void;
  onBack: () => void;
}) {
  const [status, setStatus] = useState<CatalogStatus | null>(null);
  const [pollError, setPollError] = useState("");
  useEffect(
    () =>
      startVisibleCatalogPolling({
        read: api.catalogStatus,
        onStatus: (next) => {
          setStatus(next);
          setPollError("");
        },
        onError: setPollError,
        visibility: document,
      }),
    [],
  );
  const updates = catalogUpdates(episode, status);
  const lastSuccess = status?.sync.lastSuccessAt ?? episode?.sync.lastSuccessAt;
  const lastError = status ? status.sync.lastError : episode?.sync.lastError;
  return (
    <section className="catalog-sync" aria-label="Catalog sync status">
      <div className="catalog-sync-summary">
        <span>
          <RefreshCw size={14} aria-hidden="true" />
          {!status
            ? pollError
              ? "Catalog sync status unavailable"
              : "Checking catalog sync status…"
            : !status.sync.configured
              ? "Automatic catalog sync is not configured"
              : status.sync.running
                ? "Catalog sync in progress"
                : status.sync.stale
                  ? "Catalog sync is overdue"
                  : "Automatic catalog sync"}
        </span>
        <small>
          Last successful sync:{" "}
          {lastSuccess ? (
            <time dateTime={lastSuccess}>
              {new Date(lastSuccess).toLocaleString(undefined, {
                timeZoneName: "short",
              })}
            </time>
          ) : (
            "not yet confirmed"
          )}
        </small>
        {loading && (
          <button className="quiet" onClick={onCancel}>
            Cancel refresh
          </button>
        )}
      </div>
      {pollError && (
        <p className="catalog-sync-warning" role="status" aria-live="polite">
          <TriangleAlert size={15} aria-hidden="true" />
          Could not check catalog updates. {pollError} Showing the last known
          status; the next check runs while this tab is visible.
        </p>
      )}
      {lastError && (
        <p className="catalog-sync-warning" role="status" aria-live="polite">
          <TriangleAlert size={15} aria-hidden="true" />
          Last catalog sync failed: {lastError} Previously imported clips remain
          available.
        </p>
      )}
      {status?.sync.stale && !lastError && (
        <p className="catalog-sync-warning">
          No recent successful sync is confirmed. The catalog may be out of
          date.
        </p>
      )}
      {updates.available && (
        <div className="catalog-update-banner">
          <div role="status" aria-live="polite" aria-atomic="true">
            <strong>{catalogUpdateLabel(updates)}</strong>
            <p>
              {reviewing
                ? "Your current review stays unchanged. Return to the slate when you’re ready to apply updates."
                : "Apply updates to load the latest imported slate. Saved decisions and render-specific drafts are kept."}
            </p>
          </div>
          {reviewing ? (
            <button className="quiet" onClick={onBack}>
              Return to slate
            </button>
          ) : (
            <div className="catalog-update-actions">
              <button onClick={onApply} disabled={loading || pending}>
                {loading ? "Applying updates…" : "Apply updates"}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
