export interface Env {
  DB: D1Database;
  // Private activation config only; intentionally absent from tracked wrangler vars.
  INVENTORY_INGEST_ENABLED?: string;
  INVENTORY_APP_ORIGIN?: string;
  INVENTORY_ACCESS_TEAM_DOMAIN?: string;
  INVENTORY_ACCESS_AUD?: string;
  INVENTORY_ACCESS_CLIENT_ID?: string;
  INVENTORY_GRANT_STARTS_AT?: string;
  INVENTORY_GRANT_EXPIRES_AT?: string;
  PUBLICATION_FEED_URL?: string;
  PUBLICATION_ALLOWED_HOSTS?: string;
  PUBLICATION_AUTO_ROLLOVER?: string;
  ASSETS?: Fetcher;
  APP_ENV: string;
  LOCAL_DEMO?: string;
  APP_ORIGIN?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  OWNER_EMAIL?: string;
  CSRF_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REFRESH_TOKEN?: string;
  PRODUCER_SHEET_ID?: string;
  PRODUCER_SHEET_RANGE?: string;
  ALLOWED_EPISODE_IDS?: string;
  ALLOWED_DRIVE_FOLDER_IDS?: string;
}
