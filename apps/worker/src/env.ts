export interface Env {
  DB: D1Database;
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
