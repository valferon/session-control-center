import * as vscode from "vscode";
import * as https from "https";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ClaudeUsage, UsageWindow } from "../model/types";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA = "oauth-2025-04-20";
const HOST = "api.anthropic.com";
const PATH = "/api/oauth/usage";

// Fetches Claude Code subscription usage (the same data as the `/usage` command:
// 5h session window + 7d weekly window). Reads the user's own OAuth token from
// the local credentials file and calls the official endpoint. The token is read
// at call time, used only as a request header, and never logged or persisted.
const MAX_BACKOFF_MS = 30 * 60_000;
// Treat a shared result as fresh for this long → at most ~1 real API call per
// this window, no matter how many VSCodium windows are open.
const SOFT_TTL_MS = 4.5 * 60_000;
// If another window claimed a fetch within this window, don't pile on.
const CLAIM_MS = 25_000;
const SHARED_FILE = "usage-shared.json";

interface SharedUsage {
  data?: ClaudeUsage;
  fetchedAt: number;
  fetchingAt: number; // claim timestamp (0 = not fetching)
}

export class UsageService {
  private current?: ClaudeUsage;
  private inFlight = false;
  private failCount = 0;
  private nextAllowedFetchMs = 0;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  // storageUri is globalStorageUri — the SAME path across all windows of this
  // user, so the shared cache coordinates fetches between windows.
  constructor(private readonly storageUri: vscode.Uri) {}

  getCurrent(): ClaudeUsage | undefined {
    return this.current;
  }

  // Off by default: the panel reads the local Claude OAuth token and calls
  // Anthropic's usage endpoint, so it stays opt-in. When disabled we never read
  // the token or hit the network.
  isEnabled(): boolean {
    return vscode.workspace
      .getConfiguration("claudeControlCenter")
      .get<boolean>("usage.enabled", false);
  }

  private sharedUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.storageUri, SHARED_FILE);
  }

  private async readShared(): Promise<SharedUsage | undefined> {
    try {
      const buf = await vscode.workspace.fs.readFile(this.sharedUri());
      return JSON.parse(Buffer.from(buf).toString("utf8")) as SharedUsage;
    } catch {
      return undefined;
    }
  }

  private async writeShared(s: SharedUsage): Promise<void> {
    try {
      await vscode.workspace.fs.createDirectory(this.storageUri);
      await vscode.workspace.fs.writeFile(this.sharedUri(), Buffer.from(JSON.stringify(s), "utf8"));
    } catch {
      // best-effort coordination; ignore write failures
    }
  }

  // force=true (manual Refresh) ignores backoff but still respects an in-flight
  // fetch and writes through the shared cache.
  async refresh(force = false): Promise<void> {
    if (!this.isEnabled()) {
      // Opt-in feature is off: never touch the token or the network. Clear any
      // last-good window so the panel doesn't show stale data after a toggle.
      if (this.current) {
        this.current = undefined;
        this._onDidChange.fire();
      }
      return;
    }
    if (this.inFlight) {
      return;
    }
    this.inFlight = true;
    try {
      await this.doRefresh(force);
    } finally {
      this.inFlight = false;
    }
  }

  private async doRefresh(force: boolean): Promise<void> {
    const now = Date.now();
    const shared = await this.readShared();

    // 1. Another window fetched recently → serve that, no API call.
    if (!force && shared?.data && now - shared.fetchedAt < SOFT_TTL_MS) {
      this.set(shared.data);
      return;
    }
    // 2. Another window is fetching right now → use what we have, don't pile on.
    if (!force && shared?.fetchingAt && now - shared.fetchingAt < CLAIM_MS) {
      if (shared.data) {
        this.set(shared.data);
      }
      return;
    }
    // 3. This window is backing off after a failure/429.
    if (!force && now < this.nextAllowedFetchMs) {
      if (shared?.data) {
        this.set(shared.data);
      }
      return;
    }

    const token = this.readToken();
    if (!token) {
      this.setError("Not signed in to a Claude subscription (no OAuth token found).");
      return;
    }
    if (token.expiresAt && token.expiresAt < now) {
      // The access token is short-lived and rotated in-place by Claude Code out
      // of band. Don't blank the panel during that brief gap — keep last-good
      // and back off briefly so we retry once the file is refreshed.
      this.backoff(60_000);
      if (shared?.data) {
        this.set(shared.data);
      } else if (!this.current) {
        this.setError("Claude token expired — open Claude Code to refresh it.");
      }
      return;
    }

    // Claim the fetch slot so sibling windows back off.
    await this.writeShared({ data: shared?.data, fetchedAt: shared?.fetchedAt ?? 0, fetchingAt: now });

    let res: { status: number; retryAfterMs?: number; json?: any };
    try {
      res = await this.httpGet(token.accessToken);
    } catch (e) {
      this.backoff();
      this.setError(`Usage fetch failed: ${truncateErr(e)}`);
      await this.writeShared({ data: shared?.data, fetchedAt: shared?.fetchedAt ?? 0, fetchingAt: 0 });
      return;
    }
    if (res.status >= 200 && res.status < 300 && res.json) {
      this.failCount = 0;
      this.nextAllowedFetchMs = 0;
      const usage = parseUsage(res.json);
      this.set(usage);
      await this.writeShared({ data: usage, fetchedAt: Date.now(), fetchingAt: 0 });
      return;
    }
    // release the claim on any non-success
    await this.writeShared({ data: shared?.data, fetchedAt: shared?.fetchedAt ?? 0, fetchingAt: 0 });
    if (res.status === 429) {
      this.backoff(res.retryAfterMs);
      const mins = Math.ceil((this.nextAllowedFetchMs - now) / 60_000);
      this.setError(`Rate limited by Anthropic. Retrying in ~${mins}m.`);
      return;
    }
    this.backoff();
    this.setError(res.status === 401 || res.status === 403 ? "Unauthorized — open Claude Code to re-auth." : `HTTP ${res.status}.`);
  }

  // Exponential backoff (1,2,4,8,16,30 min), or honor an explicit Retry-After.
  private backoff(retryAfterMs?: number): void {
    this.failCount++;
    const expo = Math.min(MAX_BACKOFF_MS, 60_000 * 2 ** (this.failCount - 1));
    this.nextAllowedFetchMs = Date.now() + Math.max(retryAfterMs ?? 0, expo);
  }

  private set(u: ClaudeUsage): void {
    this.current = u;
    this._onDidChange.fire();
  }

  // Preserve last-good numbers when a refresh fails, so a transient 429 doesn't
  // blank the panel — just annotate staleness.
  private setError(msg: string): void {
    if (this.current && (this.current.fiveHour || this.current.sevenDay)) {
      this.current = { ...this.current, error: msg, fetchedAt: this.current.fetchedAt };
    } else {
      this.current = { fetchedAt: Date.now(), error: msg };
    }
    this._onDidChange.fire();
  }

  private readToken(): { accessToken: string; expiresAt?: number } | undefined {
    // On macOS, Claude Code stores the OAuth blob in the login Keychain, not the
    // credentials file (the file is often absent or a stale leftover). Prefer the
    // fresher of the two so a rotated token in the Keychain wins over a stale file.
    const fromFile = this.parseOauth(this.readCredentialsFile());
    const fromKeychain = process.platform === "darwin" ? this.parseOauth(this.readKeychain()) : undefined;
    if (fromFile && fromKeychain) {
      return (fromKeychain.expiresAt ?? 0) >= (fromFile.expiresAt ?? 0) ? fromKeychain : fromFile;
    }
    return fromKeychain ?? fromFile;
  }

  private parseOauth(raw: string | undefined): { accessToken: string; expiresAt?: number } | undefined {
    if (!raw) {
      return undefined;
    }
    try {
      const o = JSON.parse(raw)?.claudeAiOauth;
      if (o?.accessToken) {
        let expiresAt: number | undefined;
        if (typeof o.expiresAt === "number") {
          // Normalize seconds-epoch to ms (some OAuth stores use seconds).
          expiresAt = o.expiresAt < 1e12 ? o.expiresAt * 1000 : o.expiresAt;
        }
        return { accessToken: o.accessToken, expiresAt };
      }
    } catch {
      // missing/unparseable credentials
    }
    return undefined;
  }

  private readCredentialsFile(): string | undefined {
    try {
      return fs.readFileSync(this.credentialsPath(), "utf8");
    } catch {
      return undefined;
    }
  }

  // Reads the OAuth blob from the macOS login Keychain. Same JSON shape as the
  // credentials file. The token is never logged; only used as a request header.
  private readKeychain(): string | undefined {
    try {
      const out = execFileSync(
        "security",
        ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
        { encoding: "utf8", timeout: 5000 }
      );
      return typeof out === "string" && out.trim() ? out.trim() : undefined;
    } catch {
      // no matching keychain item, or user denied access
      return undefined;
    }
  }

  private credentialsPath(): string {
    const cfg = process.env.CLAUDE_CONFIG_DIR;
    const base = cfg && cfg.trim() ? cfg.trim() : path.join(os.homedir(), ".claude");
    return path.join(base, ".credentials.json");
  }

  // Resolves with the HTTP status (+ parsed JSON for 2xx, + retry-after for 429).
  // Rejects only on transport errors, with a sanitized message so a raw network
  // error object (which can embed request options/headers) never leaks the token.
  private httpGet(accessToken: string): Promise<{ status: number; retryAfterMs?: number; json?: any }> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ok = (v: { status: number; retryAfterMs?: number; json?: any }) => {
        if (!settled) {
          settled = true;
          resolve(v);
        }
      };
      const fail = (code: string) => {
        if (!settled) {
          settled = true;
          reject(new Error(code));
        }
      };
      const req = https.request(
        {
          host: HOST,
          path: PATH,
          method: "GET",
          timeout: 6000,
          headers: {
            "Content-Type": "application/json",
            "anthropic-beta": OAUTH_BETA,
            Authorization: `Bearer ${accessToken}`,
          },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          let retryAfterMs: number | undefined;
          const ra = res.headers["retry-after"];
          if (typeof ra === "string") {
            const secs = Number(ra);
            if (!Number.isNaN(secs)) {
              retryAfterMs = secs * 1000;
            }
          }
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => {
            if (status >= 200 && status < 300) {
              try {
                ok({ status, json: JSON.parse(body) });
              } catch {
                fail("bad JSON response");
              }
            } else {
              ok({ status, retryAfterMs });
            }
          });
        }
      );
      req.on("error", (e) => fail("network error: " + ((e as NodeJS.ErrnoException).code ?? "unknown")));
      req.on("timeout", () => {
        req.destroy();
        fail("timeout");
      });
      req.end();
    });
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}

function parseUsage(raw: any): ClaudeUsage {
  const win = (o: any): UsageWindow | undefined => {
    if (!o || typeof o.utilization !== "number") {
      return undefined;
    }
    return { percent: Math.round(o.utilization), resetsAt: o.resets_at ?? undefined };
  };
  const out: ClaudeUsage = { fetchedAt: Date.now() };
  out.fiveHour = win(raw.five_hour);
  out.sevenDay = win(raw.seven_day);
  out.sevenDaySonnet = win(raw.seven_day_sonnet);
  out.sevenDayOpus = win(raw.seven_day_opus);
  if (raw.extra_usage && raw.extra_usage.is_enabled) {
    out.extra = {
      percent: Math.round(raw.extra_usage.utilization ?? 0),
      usedCredits: raw.extra_usage.used_credits ?? 0,
      monthlyLimit: raw.extra_usage.monthly_limit ?? 0,
      currency: raw.extra_usage.currency ?? "USD",
    };
  }
  // Severity from the structured `limits` array. There can be MULTIPLE weekly
  // entries (weekly_all aggregate + weekly_scoped per-model); use the aggregate
  // (kind weekly_all) for the overall weekly bar so a critical cap isn't masked.
  if (Array.isArray(raw.limits)) {
    for (const l of raw.limits) {
      if (l.group === "session" && out.fiveHour) {
        out.fiveHour.severity = l.severity;
      }
      if ((l.kind === "weekly_all" || (l.group === "weekly" && !l.scope)) && out.sevenDay) {
        out.sevenDay.severity = l.severity;
      }
      // Per-model weekly caps arrive as weekly_scoped entries (top-level
      // seven_day_opus/_sonnet are often null); key them off the model name.
      if (l.kind === "weekly_scoped" && l.scope?.model?.display_name) {
        const w: UsageWindow = {
          percent: Math.round(l.percent ?? 0),
          resetsAt: l.resets_at ?? undefined,
          severity: l.severity,
        };
        switch (l.scope.model.display_name) {
          case "Fable":
            out.sevenDayFable = w;
            break;
          case "Opus":
            out.sevenDayOpus = out.sevenDayOpus ?? w;
            break;
          case "Sonnet":
            out.sevenDaySonnet = out.sevenDaySonnet ?? w;
            break;
        }
      }
    }
  }
  return out;
}

function truncateErr(e: unknown): string {
  const s = e instanceof Error ? e.message : String(e);
  return s.length > 80 ? s.slice(0, 80) : s;
}
