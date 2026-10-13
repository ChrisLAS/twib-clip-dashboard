import {
  InventoryReviewEditor,
  reviewLabels,
  type InventoryReviewDraft,
} from "./inventory-review-editor";
import type { InventoryReview, InventoryReviewStatus } from "@twib/shared";
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
import type {
  InventoryResponse,
  InventoryStatus,
  InventoryGroup,
} from "@twib/shared";
import { api } from "./api";
import {
  inventoryBytes,
  inventoryFormatHint,
  inventoryStatusLabels,
  inventoryStatusNotes,
  inventoryTimestamp,
} from "./inventory-format";
import "./inventory.css";
import {
  inventoryScopeKey,
  matchEpisodeFile,
  matchExplicitFile,
  playbackEligible,
} from "./inventory-local-media";
import {
  InventoryLocalPlayer,
  type LocalPlaybackSelection,
} from "./inventory-local-player";

type RecordItem = InventoryResponse["items"][number];
function InventoryRecord({
  record,
  onPlay,
  onFile,
  localMatch,
  pinned,
  selection,
  active,
  csrfToken,
  reviewDraft,
  onReviewDraft,
  onReviewSaved,
  onClose,
  onRefresh,
}: {
  record: RecordItem;
  onPlay: () => void;
  onFile: (file: File, confirmedRef: string) => void;
  localMatch: string;
  pinned?: boolean;
  selection: LocalPlaybackSelection | null;
  active: boolean;
  csrfToken?: string;
  reviewDraft?: InventoryReviewDraft;
  onReviewDraft: (draft: InventoryReviewDraft | null) => void;
  onReviewSaved: (review: InventoryReview) => void;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const [confirmedRef, setConfirmedRef] = useState("");
  const [expanded, setExpanded] = useState(false);
  const variant = record.variants[0],
    item = variant?.item;
  if (!item) return null;
  const status = item.processing_status;
  const formatHint = inventoryFormatHint(item.media?.ref);
  const title = item.media?.ref ?? `Candidate ${record.id.slice(-12)}`;
  return (
    <details
      className={`inventory-record inventory-tone-${status}`}
      onToggle={(e) => setExpanded(e.currentTarget.open)}
    >
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
          <small
            className={`inventory-review-badge review-${record.review?.effectiveStatus ?? "unreviewed"}`}
          >
            Saved:{" "}
            {reviewLabels[record.review?.effectiveStatus ?? "unreviewed"]}
          </small>
          {formatHint && (
            <small className="inventory-format-hint">{formatHint}</small>
          )}
        </span>
        <span className={`inventory-badge ${status}`}>
          {inventoryStatusLabels[status] ?? status}
        </span>
        <span className="inventory-record-time">
          {record.firstObservedAt
            ? inventoryTimestamp(record.firstObservedAt)
            : "First observed not recorded"}
        </span>
        <ChevronDown className="inventory-chevron" size={17} />
      </summary>
      <div className="inventory-record-details">
        {pinned && (
          <p className="inventory-warning">
            Selected clip outside this response. Its local selection and draft
            are retained; refresh or reselect after sync changes.
          </p>
        )}
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
            <dt>Reported by</dt>
            <dd>Number One · Nomad</dd>
          </div>
          <div>
            <dt>Number One record</dt>
            <dd>
              {record.producerRecord?.clip_uid ??
                record.producerRecord?.clip_id ??
                "Legacy inventory identity"}
            </dd>
          </div>
          <div>
            <dt>First observed</dt>
            <dd>{inventoryTimestamp(record.firstObservedAt)}</dd>
          </div>
          <div>
            <dt>Capture completed (producer)</dt>
            <dd>
              {inventoryTimestamp(
                item.observations.find((o) => o.timestamps.captured_at)
                  ?.timestamps.captured_at,
              )}
            </dd>
          </div>
          <div>
            <dt>Downloaded or created by</dt>
            <dd>Unknown · not recorded</dd>
          </div>
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
        {playbackEligible(record) && (
          <div className="inventory-local-actions">
            <p>
              {localMatch === "matched"
                ? "Selected local file matches the relative reference and size."
                : localMatch === "ambiguous"
                  ? "Ambiguous local selection. Select one episode folder again."
                  : localMatch === "size_mismatch"
                    ? "Local file size differs from the observation. Wait for sync or refresh inventory, then select again."
                    : "Select your synced episode folder to play this file locally."}
            </p>
            <button onClick={onPlay} disabled={localMatch !== "matched"}>
              Play selected local file
            </button>
            <details>
              <summary>Select an individual file instead</summary>
              <p>
                The browser cannot report its parent folder. Type the exact
                episode-relative reference above to bind the file to this record
                explicitly.
              </p>
              <label>
                Confirm full reference
                <input
                  value={confirmedRef}
                  maxLength={1024}
                  onChange={(event) => setConfirmedRef(event.target.value)}
                />
              </label>
              <label>
                Choose exact local file
                <input
                  type="file"
                  disabled={confirmedRef !== item.media?.ref}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) onFile(file, confirmedRef);
                    event.target.value = "";
                  }}
                />
              </label>
            </details>
          </div>
        )}
        <div className="inventory-row-review">
          {selection && (
            <InventoryLocalPlayer
              selection={selection}
              active={active && expanded}
              onClose={onClose}
            />
          )}
          <InventoryReviewEditor
            record={record}
            csrfToken={csrfToken}
            draft={reviewDraft}
            onDraft={onReviewDraft}
            onSaved={onReviewSaved}
            onRefresh={onRefresh}
          />
        </div>
        <p className="inventory-privacy">
          <ShieldCheck size={14} />
          Source URLs and producer editorial context are not displayed. Saving
          reviews changes dashboard metadata only. Local playback uses files you
          explicitly select; no host file operations are enabled.
        </p>
      </div>
    </details>
  );
}
export function InventoryPanel({
  active,
  csrfToken,
}: {
  active: boolean;
  csrfToken?: string;
}) {
  const [group, setGroup] = useState<InventoryGroup>("media");
  const [status, setStatus] = useState<InventoryStatus | null>(null),
    [query, setQuery] = useState(""),
    [draft, setDraft] = useState("");
  const [cursor, setCursor] = useState<string | null>(null),
    [previous, setPrevious] = useState<(string | null)[]>([]),
    [revision, setRevision] = useState(0);
  const [data, setData] = useState<InventoryResponse | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [selection, setSelection] = useState<LocalPlaybackSelection | null>(
    null,
  );
  const [reviewDrafts, setReviewDrafts] = useState<
    Record<string, InventoryReviewDraft>
  >({});
  const [sort, setSort] = useState<"filename" | "first_observed">("filename");
  const [direction, setDirection] = useState<"asc" | "desc">("asc");
  const [reviewFilter, setReviewFilter] = useState<
    "all" | InventoryReviewStatus
  >("all");
  const [groupFolders, setGroupFolders] = useState(true);
  const [reviewNotice, setReviewNotice] = useState("");
  const [selectionError, setSelectionError] = useState("");
  const folderInput = useRef<HTMLInputElement>(null);
  const epoch = useRef(0);

  useEffect(() => {
    folderInput.current?.setAttribute("webkitdirectory", "");
  }, [active]);
  useEffect(() => {
    if (!data) return;
    setSelection((selected) => {
      if (!selected) return selected;
      if (
        selected.sourceId !== data.sourceId ||
        selected.episodeId !== data.episodeId
      )
        return null;
      const current = data.items.find(
        (record) => record.id === selected.record.id,
      );
      // Pages and partial snapshots can omit existing identities. Omission does
      // not delete a selection, and a new sequence alone does not reset playback.
      if (!current) return selected;
      const oldMedia = selected.record.variants[0].item.media;
      const newMedia = current.variants[0]?.item.media;
      if (
        !playbackEligible(current) ||
        newMedia?.ref !== oldMedia?.ref ||
        newMedia?.size_bytes !== oldMedia?.size_bytes ||
        newMedia?.modified_at !== oldMedia?.modified_at
      )
        return selected.invalid ? selected : { ...selected, invalid: true };
      return selected;
    });
  }, [data]);
  function choose(record: RecordItem, file?: File, confirmedRef?: string) {
    if (!data) return;
    const match = file
      ? matchExplicitFile(record, file, confirmedRef ?? "")
      : matchEpisodeFile(record, files, data.episodeNumber ?? 127);
    if (match.state !== "matched") {
      setSelectionError(
        "The selected file does not uniquely match the exact reference and observed size. No playback was opened.",
      );
      return;
    }
    setSelectionError("");
    setSelection({
      key: inventoryScopeKey(data.sourceId, data.episodeId, record.id),
      sourceId: data.sourceId,
      episodeId: data.episodeId,
      record,
      file: match.file,
      manual: !!file,
      mtimeDiffers: match.mtimeDiffers,
    });
  }
  useEffect(() => {
    const version = ++epoch.current;
    if (!active) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    api
      .inventory(
        {
          episodeNumber: 127,
          group,
          status,
          query,
          after: cursor,
          sort,
          direction,
          review: reviewFilter,
          groupFolders,
        },
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
  }, [
    active,
    group,
    status,
    query,
    cursor,
    revision,
    sort,
    direction,
    reviewFilter,
    groupFolders,
  ]);
  function resetPage() {
    setCursor(null);
    setPrevious([]);
  }
  function filter(next: InventoryStatus | null) {
    setStatus(next);
    setGroup("all");
    resetPage();
  }
  const pinned =
    selection &&
    data &&
    selection.sourceId === data.sourceId &&
    selection.episodeId === data.episodeId &&
    !data.items.some((item) => item.id === selection.record.id)
      ? selection.record
      : null;
  const shownItems = data ? [...data.items, ...(pinned ? [pinned] : [])] : [];
  const count = data?.summary.totalItems;
  const latest = data?.latestReceipt;
  return (
    <section
      hidden={!active}
      className="inventory-workspace"
      aria-labelledby="inventory-title"
    >
      <div className="inventory-heading">
        <div>
          <p className="eyebrow copper">NUMBER ONE / SOURCE INVENTORY</p>
          <h1 id="inventory-title">
            Reported by Number One<span className="heading-dot">.</span>
          </h1>
          <p className="subtitle">Nomad · TWiB 127 inventory report</p>
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
          Reporter <code>nomad:number-one</code>
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
            Number One reported files and records observed on Nomad. This report
            does not identify who downloaded or created each file. Playable
            media and editorial readiness have not been evaluated.
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
      <div className="inventory-local-picker">
        <label>
          Choose synced episode 127 folder
          <input
            ref={folderInput}
            type="file"
            multiple
            onChange={(event) => {
              setFiles(Array.from(event.target.files ?? []));
              setSelectionError("");
              event.target.value = "";
            }}
          />
        </label>
        <p>
          Choose the folder named <code>127</code>, not its parent. Firefox and
          Chrome grant access only after your selection. Nothing is uploaded;
          reload requires selecting again.
        </p>
        {!!files.length && (
          <p role="status">
            {files.length} local files selected. Exact relative references and
            size are used; matching filenames alone are insufficient.
          </p>
        )}
        {(files.length > 0 || selection) && (
          <button
            className="quiet"
            onClick={() => {
              setFiles([]);
              setSelection(null);
            }}
          >
            Release selected local files
          </button>
        )}
        {selectionError && <p role="alert">{selectionError}</p>}
      </div>
      {reviewNotice && (
        <p role="status" className="inventory-review-notice">
          {reviewNotice}
        </p>
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
              aria-pressed={
                status === value && (value !== null || group === "all")
              }
              className={`inventory-count ${status === value && (value !== null || group === "all") ? "selected" : ""} ${value ?? "all"}`}
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
        <div
          className="inventory-groups"
          role="group"
          aria-label="Inventory groups"
        >
          {(
            [
              ["media", "Media files", data?.summary.groupCounts.media],
              [
                "attention",
                "Needs review",
                data?.summary.groupCounts.attention,
              ],
              [
                "research",
                "Research candidates",
                data?.summary.groupCounts.research,
              ],
              ["all", "All inventory", count],
            ] as const
          ).map(([value, label, total]) => (
            <button
              key={value}
              aria-pressed={group === value}
              onClick={() => {
                setGroup(value);
                setStatus(null);
                resetPage();
              }}
            >
              {label} <strong>{total ?? "—"}</strong>
            </button>
          ))}
        </div>
        <p className="inventory-group-note" role="note">
          {group === "media"
            ? `${data?.summary.groupCounts.attention ?? "—"} records need review; ${data?.summary.groupCounts.research ?? "—"} research candidates are separate. All ${count ?? "—"} records remain available.`
            : group === "research"
              ? "Candidate identities only. These records do not establish a downloaded media file."
              : group === "attention"
                ? "Incomplete, quarantined, failed, missing, unverified and ambiguous records are retained here for review."
                : "All retained records are available across pages."}{" "}
          Media files have reported capture evidence and a recognized
          audio/video filename. Playback and codecs have not been verified. MP4
          is preferred for video; existing WebM files remain visible with a
          conversion flag.
          {group === "attention" && (
            <span className="inventory-retry-note">
              {" "}
              Re-download requests are not connected yet. Nothing on this page
              retries or deletes a file.
            </span>
          )}
        </p>
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
          <label>
            <span className="sr-only">Sort inventory</span>
            <select
              aria-label="Sort inventory"
              value={sort}
              onChange={(e) => {
                setSort(e.target.value as "filename" | "first_observed");
                resetPage();
              }}
            >
              <option value="filename">Filename</option>
              <option value="first_observed">First observed</option>
            </select>
          </label>
          <label>
            <span className="sr-only">Sort direction</span>
            <select
              aria-label="Sort direction"
              value={direction}
              onChange={(e) => {
                setDirection(e.target.value as "asc" | "desc");
                resetPage();
              }}
            >
              <option value="asc">Ascending / oldest first</option>
              <option value="desc">Descending / newest first</option>
            </select>
          </label>
          <label>
            <span className="sr-only">Review decision</span>
            <select
              aria-label="Review decision"
              value={reviewFilter}
              onChange={(e) => {
                setReviewFilter(
                  e.target.value as "all" | InventoryReviewStatus,
                );
                resetPage();
              }}
            >
              <option value="all">All review decisions</option>
              {Object.entries(reviewLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="inventory-folder-toggle">
            <input
              type="checkbox"
              checked={groupFolders}
              onChange={(e) => {
                setGroupFolders(e.target.checked);
                resetPage();
              }}
            />
            Group by folder
          </label>
          {(query || status) && (
            <button
              className="quiet"
              type="button"
              onClick={() => {
                setDraft("");
                setQuery("");
                setStatus(null);
                resetPage();
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
        {loading && (
          <div className="inventory-loading" role="status">
            <RefreshCw className="spin" size={20} />
            Reading stored inventory…
          </div>
        )}
        {data &&
          (shownItems.length ? (
            <div className="inventory-list">
              <div className="inventory-list-head">
                <span>RECORD / FILE REFERENCE</span>
                <span>PROCESSING STATE</span>
                <span>FIRST OBSERVED</span>
              </div>
              {shownItems.flatMap((item, index) => {
                const folder =
                  item.folder ??
                  item.variants[0]?.item.media?.ref
                    .split("/")
                    .slice(0, -1)
                    .join("/") ??
                  "";
                const key = inventoryScopeKey(
                  data.sourceId,
                  data.episodeId,
                  item.id,
                );
                const previous = shownItems[index - 1];
                const previousFolder =
                  previous?.folder ??
                  previous?.variants[0]?.item.media?.ref
                    .split("/")
                    .slice(0, -1)
                    .join("/") ??
                  "";
                return [
                  groupFolders && (index === 0 || previousFolder !== folder) ? (
                    <h2
                      className="inventory-folder-heading"
                      key={"folder:" + key}
                    >
                      {folder || "Ungrouped"}
                      <small> · records on this page</small>
                    </h2>
                  ) : null,
                  <InventoryRecord
                    key={key}
                    record={item}
                    pinned={pinned?.id === item.id}
                    active={active}
                    csrfToken={csrfToken}
                    selection={selection?.key === key ? selection : null}
                    onClose={() => setSelection(null)}
                    reviewDraft={reviewDrafts[key]}
                    onReviewDraft={(draft) =>
                      setReviewDrafts((old) => {
                        const next = { ...old };
                        if (draft) next[key] = draft;
                        else delete next[key];
                        return next;
                      })
                    }
                    onReviewSaved={(saved) => {
                      setSelection((old) =>
                        old?.key === key
                          ? { ...old, record: { ...old.record, review: saved } }
                          : old,
                      );
                      setReviewNotice(
                        `${reviewLabels[saved.effectiveStatus]} saved for ${item.filename ?? item.variants[0]?.item.media?.ref ?? "record"}.`,
                      );
                      setData((old) => {
                        if (
                          !old ||
                          old.sourceId !== data.sourceId ||
                          old.episodeId !== data.episodeId
                        )
                          return old;
                        const exclude =
                          reviewFilter !== "all" &&
                          saved.effectiveStatus !== reviewFilter;
                        return {
                          ...old,
                          items: old.items.flatMap((current) => {
                            if (current.id !== item.id) return [current];
                            if (exclude) return [];
                            const changed =
                              current.review?.version !== saved.version;
                            return [
                              {
                                ...current,
                                review: {
                                  ...saved,
                                  ...(changed
                                    ? {
                                        effectiveStatus: "unreviewed" as const,
                                        changed: true,
                                        version:
                                          current.review?.version ??
                                          saved.version,
                                      }
                                    : {}),
                                },
                              },
                            ];
                          }),
                          summary: {
                            ...old.summary,
                            matchedItems:
                              old.summary.matchedItems -
                              (exclude &&
                              old.items.some(
                                (current) => current.id === item.id,
                              )
                                ? 1
                                : 0),
                          },
                        };
                      });
                    }}
                    onRefresh={() => setRevision((old) => old + 1)}
                    localMatch={
                      matchEpisodeFile(item, files, data.episodeNumber ?? 127)
                        .state
                    }
                    onPlay={() => choose(item)}
                    onFile={(file, ref) => choose(item, file, ref)}
                  />,
                ];
              })}
            </div>
          ) : (
            <div className="inventory-empty">
              <Archive size={30} />
              <h2>
                {count
                  ? !query && !status && group !== "all"
                    ? `No ${group === "media" ? "media files" : group === "research" ? "research candidates" : "records needing review"} in this group`
                    : "No matching records"
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
          ))}
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
