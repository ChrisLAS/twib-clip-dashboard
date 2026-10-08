import { useEffect, useRef, useState } from "react";
import type { PublicationStatus } from "@twib/shared";
export function PublicationPanel({
  csrf,
  demo,
}: {
  csrf: string;
  demo: boolean;
}) {
  const [open, setOpen] = useState(false),
    [status, setStatus] = useState<PublicationStatus | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const alive = useRef(true),
    lock = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function load(sync = false) {
    if (lock.current || demo) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        sync ? "/api/publication/sync" : "/api/publication",
        {
          credentials: "same-origin",
          cache: "no-store",
          signal: AbortSignal.timeout(60000),
          ...(sync
            ? {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "X-CSRF-Token": csrf,
                },
                body: "{}",
              }
            : {}),
        },
      );
      if (!response.ok)
        throw new Error(
          "Publication check could not be confirmed. Refresh status before checking again.",
        );
      const next: PublicationStatus = await response.json();
      if (alive.current) setStatus(next);
    } catch (e) {
      if (alive.current)
        setError(
          e instanceof Error ? e.message : "Publication status is unavailable.",
        );
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <details
      className="workflow-panel"
      onToggle={(e) => {
        const next = e.currentTarget.open;
        setOpen(next);
        if (next && !status) void load();
      }}
    >
      <summary>Published episode · RSS, transcript & chapters</summary>
      {open && (
        <div className="workflow-content">
          {demo ? (
            <p>Publication ingestion is unavailable in the fictional demo.</p>
          ) : (
            <>
              <p>
                Hourly public-feed checks. Chapters help navigation; they do not
                prove a clip aired.
              </p>
              {status && (
                <>
                  <p>
                    {status.configured
                      ? "Feed configured"
                      : "Feed not configured"}{" "}
                    · {status.running ? "Check running" : "Idle"}
                  </p>
                  <p>
                    Last successful metadata check:{" "}
                    {status.lastSuccessAt
                      ? new Date(status.lastSuccessAt).toLocaleString()
                      : "Not yet checked"}
                  </p>
                  <p>
                    Last observed scheduled success:{" "}
                    {status.lastScheduledSuccessAt
                      ? new Date(status.lastScheduledSuccessAt).toLocaleString()
                      : "Not observed yet"}
                  </p>
                  {status.latest && (
                    <p>
                      Published: {status.latest.title}{" "}
                      {status.latest.episodeNumber !== null
                        ? `(episode ${status.latest.episodeNumber})`
                        : ""}
                    </p>
                  )}
                  <ul>
                    {Object.entries(status.assets).map(([kind, asset]) => (
                      <li key={kind}>
                        {kind}: {asset.state}
                        {asset.error ? ` · ${asset.error}` : ""}
                        {asset.nextRetryAt
                          ? ` · retry after ${new Date(asset.nextRetryAt).toLocaleString()}`
                          : ""}
                      </li>
                    ))}
                  </ul>
                  {status.lastError && <p role="status">{status.lastError}</p>}
                  <p>
                    Episode media bytes have not been fingerprinted. Airing
                    requires separate verification.
                  </p>
                </>
              )}
              <div className="workflow-actions">
                <button disabled={busy} onClick={() => void load()}>
                  Refresh publication status
                </button>
                <button
                  disabled={busy || !status?.configured || status.running}
                  onClick={() => void load(true)}
                >
                  {busy ? "Checking…" : "Check public feed now"}
                </button>
              </div>
              {error && <p role="alert">{error}</p>}
            </>
          )}
        </div>
      )}
    </details>
  );
}
