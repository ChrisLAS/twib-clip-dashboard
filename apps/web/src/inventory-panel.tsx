import { useEffect, useRef, useState } from "react";
import {
  Archive,
  ChevronDown,
  Clock3,
  FileText,
  FolderArchive,
  RefreshCw,
  Search,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import type { InventoryResponse, InventoryStatus } from "@twib/shared";
import { api } from "./api";
import {
  inventoryBytes,
  inventoryStatusLabels,
  inventoryStatusNotes,
  inventoryTimestamp,
} from "./inventory-format";
import "./inventory.css";

type RecordItem = InventoryResponse["items"][number];
function InventoryRecord({ record }: { record: RecordItem }) {
  const variant = record.variants[0],
    item = variant?.item;
  if (!item) return null;
  const status = item.processing_status;
  const title = item.media?.ref ?? `Candidate ${record.id.slice(-12)}`;
  return (
    <details className={`inventory-record inventory-tone-${status}`}>
      <summary>
        <span className="inventory-file-icon">
          {item.kind === "media" ? (
            <FolderArchive size={20} />
          ) : (
            <FileText size={20} />
          )}
        </span>
        <span className="inventory-record-title">
          <strong>{title}</strong>
          <small>
            {item.kind === "media"
              ? "Episode-relative file"
              : "Identity only · source omitted"}{" "}
            <span aria-hidden="true">·</span>{" "}
            {item.media
              ? inventoryBytes(item.media.size_bytes)
              : "Candidate metadata"}
          </small>
        </span>
        <span className={`inventory-badge ${status}`}>
          {inventoryStatusLabels[status] ?? status}
        </span>
        <span className="inventory-record-time">
          {inventoryTimestamp(variant.observedAt)}
        </span>
        <ChevronDown className="inventory-chevron" size={17} />
      </summary>
      <div className="inventory-record-details">
        <p className="inventory-status-explanation">
          {inventoryStatusNotes[status] ?? inventoryStatusNotes.unknown}
        </p>
        {(record.conflictingLatestObservations || record.variantsTruncated) && (
          <p role="note" className="inventory-warning">
            Multiple or truncated observations need inspection. No readiness is
            inferred.
          </p>
        )}
        <dl className="inventory-detail-grid">
          <div>
            <dt>Readiness</dt>
            <dd>Not evaluated</dd>
          </div>
          <div>
            <dt>File presence at scan</dt>
            <dd>
              {item.media
                ? item.media.present
                  ? "Observed present"
                  : "Not present"
                : "Not a file record"}
            </dd>
          </div>
          <div>
            <dt>Modified on source</dt>
            <dd>{inventoryTimestamp(item.media?.modified_at)}</dd>
          </div>
          <div>
            <dt>Observed on source</dt>
            <dd>{inventoryTimestamp(variant.observedAt)}</dd>
          </div>
          <div>
            <dt>Received by dashboard</dt>
            <dd>{inventoryTimestamp(variant.receivedAt)}</dd>
          </div>
          <div>
            <dt>Observation scope</dt>
            <dd>
              {variant.receiptComplete
                ? "Complete snapshot"
                : "Partial snapshot · retained history"}
            </dd>
          </div>
          <div>
            <dt>Inventory sequence</dt>
            <dd>{variant.sequence}</dd>
          </div>
          <div className="inventory-wide">
            <dt>Stable record identity</dt>
            <dd className="inventory-mono">{record.id}</dd>
          </div>
          <div className="inventory-wide">
            <dt>Receipt</dt>
            <dd className="inventory-mono">{variant.receiptId}</dd>
          </div>
        </dl>
        <div className="inventory-evidence">
          <h3>Source observations</h3>
          {item.observations.length ? (
            item.observations.map((observation, index) => (
              <div className="inventory-observation" key={index}>
                <span>{observation.status}</span>
                <code>
                  {observation.artifact ?? "No artifact reference recorded"}
                </code>
              </div>
            ))
          ) : (
            <p className="muted">
              No additional source observations were recorded.
            </p>
          )}
        </div>
        {!!item.capture_evidence?.length && (
          <p className="inventory-proof">
            {item.capture_evidence.length} capture evidence record
            {item.capture_evidence.length === 1 ? "" : "s"}. Producer hashes are
            assertions; content hashes and streams have not been independently
            rechecked.
          </p>
        )}
        <p className="inventory-privacy">
          <ShieldCheck size={14} />
          Metadata only. Source URLs and editorial context are not displayed. No
          media playback or producer actions.
        </p>
      </div>
    </details>
  );
}
export function InventoryPanel({ active }: { active: boolean }) {
  const [status, setStatus] = useState<InventoryStatus | null>(null),
    [query, setQuery] = useState(""),
    [draft, setDraft] = useState("");
  const [cursor, setCursor] = useState<string | null>(null),
    [previous, setPrevious] = useState<(string | null)[]>([]),
    [revision, setRevision] = useState(0);
  const [data, setData] = useState<InventoryResponse | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const epoch = useRef(0);
  useEffect(() => {
    const version = ++epoch.current;
    if (!active) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setData(null);
    api
      .inventory(
        { episodeNumber: 127, status, query, after: cursor },
        controller.signal,
      )
      .then((result) => {
        if (!controller.signal.aborted && version === epoch.current)
          setData(result);
      })
      .catch(() => {
        if (!controller.signal.aborted && version === epoch.current)
          setError(
            "Inventory could not be loaded. Your stored records are unchanged. Sign in again if your owner session expired, then retry.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted && version === epoch.current)
          setLoading(false);
      });
    return () => controller.abort();
  }, [active, status, query, cursor, revision]);
  function resetPage() {
    setCursor(null);
    setPrevious([]);
  }
  function filter(next: InventoryStatus | null) {
    setStatus(next);
    resetPage();
  }
  const count = data?.summary.totalItems;
  const latest = data?.latestReceipt;
  if (!active) return null;
  return (
    <section className="inventory-workspace" aria-labelledby="inventory-title">
      <div className="inventory-heading">
        <div>
          <p className="eyebrow copper">NUMBER ONE / SOURCE INVENTORY</p>
          <h1 id="inventory-title">
            Collected, not yet curated<span className="heading-dot">.</span>
          </h1>
          <p className="subtitle">
            A read-only record of what the producer observed.
          </p>
        </div>
        <span className="inventory-readonly">
          <ShieldCheck size={15} />
          Owner only · metadata
        </span>
      </div>
      <div className="inventory-scope">
        <label htmlFor="inventory-episode">Inventory episode</label>
        <select id="inventory-episode" value="127" onChange={() => {}}>
          <option value="127">TWiB 127 · registered pilot</option>
        </select>
        <span className="inventory-source">
          Source <code>nomad:number-one</code>
        </span>
        <button
          className="quiet"
          onClick={() => {
            resetPage();
            setRevision((n) => n + 1);
          }}
          disabled={loading}
        >
          <RefreshCw size={15} className={loading ? "spin" : ""} />
          Refresh stored records
        </button>
      </div>
      <div className="inventory-boundary">
        <Archive size={20} />
        <div>
          <strong>Inventory is separate from your episode slate</strong>
          <p>
            These records do not establish playable media or editorial
            readiness. The inventory episode is selected independently from your
            curated workspace.
          </p>
        </div>
      </div>
      {error && (
        <div className="error-banner" role="alert">
          <TriangleAlert />
          <div>
            <strong>Inventory unavailable</strong>
            <p>{error}</p>
          </div>
          <button onClick={() => setRevision((n) => n + 1)}>
            Retry inventory
          </button>
        </div>
      )}
      <div aria-busy={loading}>
        <div
          className="inventory-counts"
          role="group"
          aria-label="Filter inventory by processing status"
        >
          {[
            null,
            "candidate",
            "captured_observed",
            "incomplete",
            "quarantined",
          ].map((value) => (
            <button
              key={value ?? "all"}
              aria-pressed={status === value}
              className={`inventory-count ${status === value ? "selected" : ""} ${value ?? "all"}`}
              onClick={() => filter(value as InventoryStatus | null)}
            >
              <span>
                {value ? inventoryStatusLabels[value] : "All records"}
              </span>
              <strong>
                {data
                  ? value
                    ? (data.summary.statusCounts[value as InventoryStatus] ?? 0)
                    : count
                  : "—"}
              </strong>
              <small>
                {value === "captured_observed"
                  ? "Evidence, not QA"
                  : value === "candidate"
                    ? "Source identities"
                    : value === "incomplete"
                      ? "Partial records"
                      : value === "quarantined"
                        ? "Held for inspection"
                        : "Retained identities"}
              </small>
            </button>
          ))}
        </div>
        <div className="inventory-freshness">
          <div>
            <span
              className={`inventory-gate ${data?.ingestionPaused ? "paused" : ""}`}
            >
              <span aria-hidden="true" />
              {data
                ? data.ingestionPaused
                  ? "Ingestion off"
                  : "Receiver gate open"
                : "Checking receiver state"}
            </span>
            <p>
              {data?.ingestionPaused
                ? "Retained metadata is available. No new submissions are accepted."
                : "Receiver state does not indicate whether the producer is running."}
            </p>
          </div>
          <div>
            <span className="eyebrow">LAST RECEIVED</span>
            <strong>{inventoryTimestamp(data?.latestReceivedAt)}</strong>
            <small>Durable server receipt</small>
          </div>
          <div>
            <span className="eyebrow">SOURCE OBSERVED</span>
            <strong>{inventoryTimestamp(data?.latestObservedAt)}</strong>
            <small>Producer clock · not a live heartbeat</small>
          </div>
        </div>
        <form
          className="inventory-toolbar"
          onSubmit={(event) => {
            event.preventDefault();
            setQuery(draft.trim());
            resetPage();
          }}
        >
          <label className="inventory-search">
            <Search size={17} />
            <span className="sr-only">Search inventory</span>
            <input
              value={draft}
              maxLength={200}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Search filename, record ID or artifact reference"
            />
          </label>
          <button type="submit">Search</button>
          <label className="inventory-status-select">
            <span className="sr-only">Processing status</span>
            <select
              value={status ?? ""}
              onChange={(e) =>
                filter((e.target.value || null) as InventoryStatus | null)
              }
            >
              <option value="">All processing states</option>
              {Object.entries(inventoryStatusLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {(query || status) && (
            <button
              className="quiet"
              type="button"
              onClick={() => {
                setDraft("");
                setQuery("");
                filter(null);
              }}
            >
              Clear filters
            </button>
          )}
        </form>
        {data && (
          <div className="inventory-results-meta" role="status">
            <span>
              {data.summary.matchedItems.toLocaleString()} matching record
              {data.summary.matchedItems === 1 ? "" : "s"}
              {query ? ` for “${query}”` : ""}
            </span>
            <span>
              Candidate coverage: partial
              {latest
                ? ` · Latest snapshot: ${latest.complete ? "complete" : "partial"}`
                : ""}
            </span>
          </div>
        )}
        {loading ? (
          <div className="inventory-loading" role="status">
            <RefreshCw className="spin" size={20} />
            Reading stored inventory…
          </div>
        ) : (
          data &&
          (data.items.length ? (
            <div className="inventory-list">
              <div className="inventory-list-head">
                <span>RECORD / FILE REFERENCE</span>
                <span>PROCESSING STATE</span>
                <span>SOURCE OBSERVED</span>
              </div>
              {data.items.map((item) => (
                <InventoryRecord
                  key={`${item.id}-${item.variants[0]?.sequence}`}
                  record={item}
                />
              ))}
            </div>
          ) : (
            <div className="inventory-empty">
              <Archive size={30} />
              <h2>
                {count
                  ? "No matching records"
                  : latest
                    ? "No inventory records"
                    : "No inventory received"}
              </h2>
              <p>
                {count
                  ? "Try another filename or processing state. Filters do not change stored records."
                  : latest
                    ? "The received snapshot contained no records. It does not establish an empty source."
                    : "No snapshot has been received for this registered inventory episode. This does not mean the source has no files."}
              </p>
            </div>
          ))
        )}
        {data && (previous.length > 0 || data.nextCursor) && (
          <div className="inventory-pagination">
            <button
              disabled={loading || !previous.length}
              onClick={() => {
                setCursor(previous.at(-1) ?? null);
                setPrevious((p) => p.slice(0, -1));
              }}
            >
              Previous records
            </button>
            <span>Page {previous.length + 1} · up to 20 per page</span>
            <button
              disabled={loading || !data.nextCursor}
              onClick={() => {
                setPrevious((p) => [...p, cursor]);
                setCursor(data.nextCursor);
              }}
            >
              Next records
            </button>
          </div>
        )}
      </div>
      {latest && (
        <details className="inventory-receipt">
          <summary>
            <Clock3 size={16} />
            Latest scan receipt <span>Sequence {latest.sequence}</span>
            <ChevronDown size={15} />
          </summary>
          <dl className="inventory-detail-grid">
            <div>
              <dt>Records in this snapshot</dt>
              <dd>{latest.stored_item_count}</dd>
            </div>
            <div>
              <dt>Snapshot coverage</dt>
              <dd>
                {latest.complete
                  ? "Complete within collector scope"
                  : "Partial · omitted records do not delete history"}
              </dd>
            </div>
            <div>
              <dt>Observed on producer</dt>
              <dd>{inventoryTimestamp(latest.observedAt)}</dd>
            </div>
            <div>
              <dt>Received by dashboard</dt>
              <dd>{inventoryTimestamp(latest.accepted_at)}</dd>
            </div>
            <div className="inventory-wide">
              <dt>Receipt ID</dt>
              <dd className="inventory-mono">{latest.receipt_id}</dd>
            </div>
            <div className="inventory-wide">
              <dt>Scan ID</dt>
              <dd className="inventory-mono">{latest.scan_id}</dd>
            </div>
          </dl>
        </details>
      )}
      <footer className="inventory-footnote">
        <ShieldCheck size={15} />
        <p>
          Source URLs and editorial context are omitted. No media is uploaded
          here. Missing records in partial scans are retained; nothing is
          deleted. <span>{data?.identityCaveat}</span>
        </p>
      </footer>
    </section>
  );
}
