import type { ParsedCodebaseIndexConfig } from "../config/schema.js";
import type { HostMode } from "../config/host.js";
import type { Indexer, IndexProgress, IndexStats } from "../indexer/index.js";
import { existsSync, realpathSync } from "fs";
import * as os from "os";
import * as path from "path";

import { resolveProjectIndexPath } from "../config/paths.js";
import { isTransientIndexLockContention } from "../indexer/index-lock.js";
import { hasProjectMarker } from "./files.js";

export type AutoIndexCoordinatorState =
  | "idle"
  | "checking"
  | "indexing"
  | "ready"
  | "busy-retrying"
  | "failed"
  | "stopped";

export type AutoIndexSource = "startup" | "retrieval" | "watcher" | "manual";

export interface AutoIndexProgressSnapshot {
  phase: IndexProgress["phase"];
  filesProcessed: number;
  totalFiles: number;
  chunksProcessed: number;
  totalChunks: number;
  percentage: number;
}

export interface AutoIndexStatusSnapshot {
  enabled: boolean;
  state: AutoIndexCoordinatorState;
  source?: AutoIndexSource;
  startedAt?: string;
  updatedAt: string;
  completedAt?: string;
  errorAt?: string;
  lastError?: string;
  retryAttempt?: number;
  maxRetries?: number;
  nextRetryAt?: string;
  progress?: AutoIndexProgressSnapshot;
  blockedReason?: "home-directory" | "project-marker-missing";
  /** Set while automatic indexing is deferred by the changed-file guard. */
  throttledReason?: string;
  /** Summary of the most recent completed indexing run. */
  lastRun?: {
    totalFiles: number;
    indexedChunks: number;
    durationMs: number;
  };
}

export interface CoordinatedIndexResult {
  outcome: "ready" | "failed" | "stopped";
  stats?: IndexStats;
  skipped?: boolean;
  error?: unknown;
}

export interface AutoIndexRetrievalResult {
  ready: boolean;
  text?: string;
}

type CoordinatedIndexer = Pick<
  Indexer,
  "forceIndex" | "getStatus" | "index"
> & Partial<Pick<Indexer, "getIndexFreshness" | "retryFailedBatches">>;

interface AutoIndexRegistration {
  config: ParsedCodebaseIndexConfig;
  getIndexer: () => CoordinatedIndexer;
  projectRoot: string;
  safeToRun: boolean;
  blockedReason?: AutoIndexStatusSnapshot["blockedReason"];
}

interface IndexRequest {
  /** Files reported changed with this request; already-coalesced merges carry 0. */
  changedFiles: number;
  checkFreshness: boolean;
  /** Requests that tolerate being merged at the autoIndexMinIntervalMs boundary. */
  coalesce: boolean;
  force: boolean;
  onProgress?: (progress: IndexProgress) => void;
  source: AutoIndexSource;
}

const MAX_RETRY_DELAY_MS = 10_000;
const SHUTDOWN_WAIT_MS = 2_000;
const coordinators = new Map<string, AutoIndexCoordinator>();
const coordinatorKeysByProject = new Map<string, string>();
const coordinatorReplacementBarriers = new Map<string, Promise<void>>();

class AutoIndexCancelledError extends Error {
  constructor() {
    super("Auto-index coordination was cancelled");
    this.name = "AutoIndexCancelledError";
  }
}

function now(): string {
  return new Date().toISOString();
}

function canonicalizePath(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  if (existsSync(resolved)) {
    try {
      return realpathSync.native(resolved);
    } catch {
      return resolved;
    }
  }

  const parent = path.dirname(resolved);
  if (parent === resolved) return resolved;
  return path.join(canonicalizePath(parent), path.basename(resolved));
}

export function isHomeDirectory(projectRoot: string): boolean {
  return canonicalizePath(projectRoot) === canonicalizePath(os.homedir());
}

function projectLookupKey(projectRoot: string, host: HostMode): string {
  return `${host}::${canonicalizePath(projectRoot)}`;
}

function coordinatorKey(
  projectRoot: string,
  config: ParsedCodebaseIndexConfig,
  host: HostMode,
): string {
  const canonicalProjectRoot = canonicalizePath(projectRoot);
  const indexPath = resolveProjectIndexPath(projectRoot, config.scope, host);
  return `${canonicalizePath(indexPath)}::${canonicalProjectRoot}`;
}

function getProjectSafety(
  projectRoot: string,
  config: ParsedCodebaseIndexConfig,
): Pick<AutoIndexRegistration, "blockedReason" | "safeToRun"> {
  if (isHomeDirectory(projectRoot)) {
    return { safeToRun: false, blockedReason: "home-directory" };
  }
  if (config.indexing.requireProjectMarker && !hasProjectMarker(projectRoot)) {
    return { safeToRun: false, blockedReason: "project-marker-missing" };
  }
  return { safeToRun: true };
}

function calculatePercentage(progress: IndexProgress): number {
  if (progress.phase === "scanning") return 0;
  if (progress.phase === "complete") return 100;
  if (progress.phase === "parsing") {
    return progress.totalFiles === 0
      ? 5
      : Math.round(5 + (progress.filesProcessed / progress.totalFiles) * 15);
  }
  if (progress.phase === "embedding") {
    return progress.totalChunks === 0
      ? 20
      : Math.round(20 + (progress.chunksProcessed / progress.totalChunks) * 70);
  }
  if (progress.phase === "storing") return 95;
  return 0;
}

function safeFailureMessage(error: unknown): string {
  if (isTransientIndexLockContention(error)) {
    return "Another index process remained busy after the configured retries.";
  }
  return "Automatic indexing failed. Check the embedding provider configuration, then run index_codebase.";
}

function cancellableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new AutoIndexCancelledError());
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AutoIndexCancelledError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  if (timeoutMs <= 0) return Promise.resolve(undefined);
  return new Promise<T | undefined>((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    timer.unref?.();
    void promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, () => {
      clearTimeout(timer);
      resolve(undefined);
    });
  });
}

function requestPriority(request: IndexRequest): number {
  if (request.force) return 4;
  if (request.source === "manual") return 3;
  if (request.source === "watcher") return 2;
  return 1;
}

function mergeRequests(current: IndexRequest | null, next: IndexRequest): IndexRequest {
  if (!current) return next;
  const preferred = requestPriority(next) > requestPriority(current) ? next : current;
  return {
    changedFiles: 0,
    checkFreshness: current.checkFreshness && next.checkFreshness,
    coalesce: current.coalesce && next.coalesce,
    force: current.force || next.force,
    onProgress: next.onProgress ?? current.onProgress,
    source: preferred.source,
  };
}

class AutoIndexCoordinator {
  private registration: AutoIndexRegistration;
  private status: AutoIndexStatusSnapshot;
  private activation: Promise<void> = Promise.resolve();
  private inFlight: Promise<CoordinatedIndexResult> | null = null;
  private activeRequest: IndexRequest | null = null;
  private pendingRequest: IndexRequest | null = null;
  private pendingFollowUp: Promise<CoordinatedIndexResult> | null = null;
  private abortController: AbortController | null = null;
  private stopped = false;
  private lastRunCompletedAtMs = 0;
  private throttleTimer: ReturnType<typeof setTimeout> | null = null;
  private throttledRun: Promise<CoordinatedIndexResult> | null = null;
  private resolveThrottledRun: ((result: CoordinatedIndexResult) => void) | null = null;
  private changedFilesSinceLastRun = 0;
  private changedFilesDeferred: Promise<CoordinatedIndexResult> | null = null;
  private changedFilesDeferredRequest: IndexRequest | null = null;
  private resolveChangedFilesDeferral: (() => void) | null = null;

  constructor(registration: AutoIndexRegistration) {
    this.registration = registration;
    this.status = {
      enabled: registration.config.indexing.autoIndex,
      state: "idle",
      updatedAt: now(),
      blockedReason: registration.blockedReason,
    };
  }

  update(registration: AutoIndexRegistration): void {
    this.registration = registration;
    this.status.enabled = registration.config.indexing.autoIndex;
    this.status.blockedReason = registration.blockedReason;
    this.status.updatedAt = now();
    if (this.stopped) {
      this.stopped = false;
      this.status.state = "idle";
    }
    if (!registration.config.indexing.autoIndex && this.activeRequest?.source !== "manual") {
      this.pendingRequest = null;
      this.abortController?.abort();
      if (!this.inFlight) {
        this.setState("idle", { source: undefined });
      }
    }
    this.refreshThrottleGuard();
    this.releaseChangedFilesDeferral();
  }

  activateAfter(activation: Promise<void>): void {
    this.activation = activation;
  }

  snapshot(): AutoIndexStatusSnapshot {
    this.refreshSafety();
    this.refreshThrottleGuard();
    return {
      ...this.status,
      progress: this.status.progress ? { ...this.status.progress } : undefined,
      lastRun: this.status.lastRun ? { ...this.status.lastRun } : undefined,
    };
  }

  start(source: "startup" | "retrieval", options: { coalesce?: boolean } = {}): Promise<CoordinatedIndexResult> | null {
    this.refreshSafety();
    if (!this.registration.config.indexing.autoIndex || !this.registration.safeToRun) return null;
    if (this.status.state === "failed") return this.inFlight;
    return this.request({
      changedFiles: 0,
      checkFreshness: true,
      coalesce: options.coalesce === true,
      force: false,
      source,
    });
  }

  request(request: IndexRequest): Promise<CoordinatedIndexResult> {
    if (this.stopped) {
      return Promise.resolve({ outcome: "stopped" });
    }
    if (request.source === "watcher" && request.changedFiles > 0) {
      this.changedFilesSinceLastRun += request.changedFiles;
      this.refreshThrottleGuard();
    }
    return this.activation.then(() => this.enqueueRequest(request));
  }

  private enqueueRequest(request: IndexRequest): Promise<CoordinatedIndexResult> {
    if (this.stopped || !this.canRun(request)) {
      return Promise.resolve({ outcome: "stopped" });
    }
    if (this.shouldDeferForChangedFiles(request)) {
      this.changedFilesDeferredRequest = mergeRequests(this.changedFilesDeferredRequest, request);
      this.refreshThrottleGuard();
      if (this.changedFilesDeferred) {
        return this.changedFilesDeferred;
      }
      const deferred = this.waitForChangedFileGuard();
      this.changedFilesDeferred = deferred;
      void deferred.then(
        () => this.finishChangedFilesDeferral(deferred),
        () => this.finishChangedFilesDeferral(deferred),
      );
      return deferred;
    }
    if (!this.inFlight && this.shouldThrottleStart(request)) {
      this.pendingRequest = mergeRequests(this.pendingRequest, request);
      return this.scheduleThrottledRun();
    }
    if (this.inFlight) {
      if (request.force && !this.activeRequest?.force) {
        this.pendingRequest = mergeRequests(this.pendingRequest, request);
        this.abortController?.abort();
        const active = this.inFlight;
        return active.then(() => {
          if (this.stopped) return { outcome: "stopped" };
          return this.inFlight ?? this.startRequest(request);
        });
      }
      if (request.source === "watcher") {
        this.pendingRequest = mergeRequests(this.pendingRequest, request);
        const active = this.inFlight;
        return active.then(() => {
          if (this.stopped) return { outcome: "stopped" };
          return this.pendingFollowUp ?? { outcome: "stopped" };
        });
      }
      return this.inFlight;
    }
    return this.startRequest(request);
  }

  currentJob(): Promise<CoordinatedIndexResult> | null {
    return this.inFlight;
  }

  getIndexer(): CoordinatedIndexer {
    return this.registration.getIndexer();
  }

  getWaitMs(): number {
    return this.registration.config.indexing.autoIndexWaitMs;
  }

  async stop(waitForCompletion = false): Promise<void> {
    this.stopped = true;
    this.cancelThrottleRun();
    this.changedFilesDeferredRequest = null;
    this.releaseChangedFilesDeferral();
    this.pendingRequest = null;
    this.abortController?.abort();
    this.setState("stopped", {
      completedAt: now(),
      nextRetryAt: undefined,
      progress: undefined,
      retryAttempt: undefined,
      throttledReason: undefined,
    });
    const inFlight = this.inFlight;
    if (inFlight) {
      if (waitForCompletion) {
        await inFlight;
      } else {
        await withTimeout(inFlight, SHUTDOWN_WAIT_MS);
      }
    }
  }

  private startRequest(request: IndexRequest): Promise<CoordinatedIndexResult> {
    if (this.stopped || !this.canRun(request)) {
      return Promise.resolve({ outcome: "stopped" });
    }
    this.activeRequest = request;
    const job = this.run(request);
    this.inFlight = job;
    void job.then((result) => {
      if (this.inFlight !== job) return;
      this.inFlight = null;
      this.activeRequest = null;
      this.abortController = null;
      this.lastRunCompletedAtMs = Date.now();
      if (result.outcome === "ready" && !result.skipped) {
        this.changedFilesSinceLastRun = 0;
        this.refreshThrottleGuard();
        this.releaseChangedFilesDeferral();
      }
      const pending = this.pendingRequest;
      this.pendingRequest = null;
      if (pending && !this.stopped) {
        const followUp = this.request(pending);
        this.pendingFollowUp = followUp;
        void followUp.then(() => {
          if (this.pendingFollowUp === followUp) {
            this.pendingFollowUp = null;
          }
        });
      }
    });
    return job;
  }

  private async run(request: IndexRequest): Promise<CoordinatedIndexResult> {
    const controller = new AbortController();
    this.abortController = controller;
    const startedAt = now();
    this.setState("checking", {
      completedAt: undefined,
      errorAt: undefined,
      lastError: undefined,
      nextRetryAt: undefined,
      progress: undefined,
      retryAttempt: undefined,
      source: request.source,
      startedAt,
    });

    const maxRetries = request.source === "manual"
      ? 0
      : this.registration.config.indexing.autoIndexMaxRetries;
    let retryAttempt = 0;
    while (true) {
      try {
        this.throwIfCancelled(controller.signal);
        const indexer = this.registration.getIndexer();
        if (request.checkFreshness && !request.force) {
          if (indexer.getIndexFreshness) {
            const freshness = await indexer.getIndexFreshness();
            this.throwIfCancelled(controller.signal);
            if (freshness.readable && freshness.current) {
              this.setState("ready", {
                completedAt: now(),
                progress: undefined,
                retryAttempt: undefined,
              });
              return { outcome: "ready", skipped: true };
            }
          }
        }

        await this.retryFailedBatchesBeforeRun(indexer, request);
        this.throwIfCancelled(controller.signal);
        this.setState("indexing", {
          nextRetryAt: undefined,
          retryAttempt: retryAttempt > 0 ? retryAttempt : undefined,
        });
        const operation = request.force ? indexer.forceIndex.bind(indexer) : indexer.index.bind(indexer);
        const stats = await operation((progress) => {
          this.throwIfCancelled(controller.signal);
          request.onProgress?.(progress);
          this.status.progress = {
            phase: progress.phase,
            filesProcessed: progress.filesProcessed,
            totalFiles: progress.totalFiles,
            chunksProcessed: progress.chunksProcessed,
            totalChunks: progress.totalChunks,
            percentage: calculatePercentage(progress),
          };
          this.status.updatedAt = now();
        });
        this.throwIfCancelled(controller.signal);
        if (request.source === "startup" || request.source === "retrieval") {
          const latestStatus = await this.registration.getIndexer().getStatus();
          if (!latestStatus.indexed) {
            const error = new Error("Indexing completed without producing a readable index");
            this.setState("failed", {
              completedAt: now(),
              errorAt: now(),
              lastError: "Automatic indexing completed but no readable index was produced. Check include and exclude patterns.",
              progress: undefined,
            });
            return { outcome: "failed", error, stats };
          }
        }
        this.setState("ready", {
          completedAt: now(),
          lastRun: {
            totalFiles: stats.totalFiles,
            indexedChunks: stats.indexedChunks,
            durationMs: stats.durationMs,
          },
          progress: this.status.progress
            ? { ...this.status.progress, phase: "complete", percentage: 100 }
            : undefined,
          retryAttempt: undefined,
        });
        return { outcome: "ready", stats };
      } catch (error) {
        if (error instanceof AutoIndexCancelledError || controller.signal.aborted) {
          if (this.stopped) {
            this.setState("stopped", { completedAt: now(), progress: undefined });
            return { outcome: "stopped" };
          }
          if (!this.registration.config.indexing.autoIndex && request.source !== "manual") {
            this.setState("idle", {
              completedAt: now(),
              progress: undefined,
              source: undefined,
            });
            return { outcome: "stopped" };
          }
          return { outcome: "stopped" };
        }

        if (isTransientIndexLockContention(error) && retryAttempt < maxRetries) {
          retryAttempt += 1;
          const delayMs = Math.min(
            this.registration.config.indexing.autoIndexRetryDelayMs * (2 ** (retryAttempt - 1)),
            MAX_RETRY_DELAY_MS,
          );
          const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
          this.setState("busy-retrying", {
            maxRetries,
            nextRetryAt,
            progress: undefined,
            retryAttempt,
          });
          try {
            await cancellableDelay(delayMs, controller.signal);
          } catch (delayError) {
            if (delayError instanceof AutoIndexCancelledError) {
              if (this.stopped) {
                this.setState("stopped", { completedAt: now(), progress: undefined });
              }
              return { outcome: "stopped" };
            }
            throw delayError;
          }
          this.setState("checking", { nextRetryAt: undefined });
          continue;
        }

        const errorAt = now();
        this.setState("failed", {
          completedAt: errorAt,
          errorAt,
          lastError: safeFailureMessage(error),
          nextRetryAt: undefined,
          progress: undefined,
          retryAttempt: retryAttempt > 0 ? retryAttempt : undefined,
        });
        return { outcome: "failed", error };
      }
    }
  }

  private setState(
    state: AutoIndexCoordinatorState,
    updates: Partial<AutoIndexStatusSnapshot> = {},
  ): void {
    if (this.stopped && state !== "stopped") return;
    this.status = {
      ...this.status,
      ...updates,
      enabled: this.registration.config.indexing.autoIndex,
      state,
      updatedAt: now(),
      blockedReason: this.registration.blockedReason,
    };
  }

  private throwIfCancelled(signal: AbortSignal): void {
    if (signal.aborted) throw new AutoIndexCancelledError();
  }

  private refreshSafety(): void {
    const previousBlockedReason = this.registration.blockedReason;
    const safety = getProjectSafety(this.registration.projectRoot, this.registration.config);
    this.registration.safeToRun = safety.safeToRun;
    this.registration.blockedReason = safety.blockedReason;
    this.status.blockedReason = safety.blockedReason;
    if (previousBlockedReason !== safety.blockedReason) {
      this.status.updatedAt = now();
    }
  }

  private async retryFailedBatchesBeforeRun(
    indexer: CoordinatedIndexer,
    request: IndexRequest,
  ): Promise<void> {
    if (request.source === "manual" || !indexer.retryFailedBatches) return;
    const status = await indexer.getStatus();
    if (status.failedBatchesCount === 0) return;
    await indexer.retryFailedBatches();
  }

  private shouldThrottleStart(request: IndexRequest): boolean {
    if (!request.coalesce) return false;
    if (this.throttledRun) return true;
    const intervalMs = this.registration.config.indexing.autoIndexMinIntervalMs;
    if (intervalMs <= 0 || this.lastRunCompletedAtMs === 0) return false;
    return Date.now() - this.lastRunCompletedAtMs < intervalMs;
  }

  private scheduleThrottledRun(): Promise<CoordinatedIndexResult> {
    if (this.throttledRun) return this.throttledRun;
    const intervalMs = this.registration.config.indexing.autoIndexMinIntervalMs;
    const delayMs = Math.max(0, this.lastRunCompletedAtMs + intervalMs - Date.now());
    const run = new Promise<CoordinatedIndexResult>((resolve) => {
      const timer = setTimeout(() => {
        this.throttleTimer = null;
        this.throttledRun = null;
        this.resolveThrottledRun = null;
        const pending = this.pendingRequest;
        this.pendingRequest = null;
        if (this.stopped || !pending) {
          resolve({ outcome: "stopped" });
          return;
        }
        resolve(this.request(pending));
      }, delayMs);
      timer.unref?.();
      this.throttleTimer = timer;
      this.resolveThrottledRun = resolve;
    });
    this.throttledRun = run;
    return run;
  }

  private cancelThrottleRun(): void {
    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
    this.throttledRun = null;
    const resolve = this.resolveThrottledRun;
    this.resolveThrottledRun = null;
    resolve?.({ outcome: "stopped" });
  }

  private changedFileGuardExceeded(): boolean {
    const max = this.registration.config.indexing.autoIndexMaxChangedFiles;
    return max > 0 && this.changedFilesSinceLastRun > max;
  }

  private shouldDeferForChangedFiles(request: IndexRequest): boolean {
    if (request.source === "manual" || request.force) return false;
    return this.changedFileGuardExceeded();
  }

  private refreshThrottleGuard(): void {
    let reason: string | undefined;
    if (this.changedFileGuardExceeded()) {
      const max = this.registration.config.indexing.autoIndexMaxChangedFiles;
      reason = `${this.changedFilesSinceLastRun} changed files exceed autoIndexMaxChangedFiles (${max}); run /index manually`;
    }
    if (this.status.throttledReason !== reason) {
      this.status.throttledReason = reason;
      this.status.updatedAt = now();
    }
  }

  private async waitForChangedFileGuard(): Promise<CoordinatedIndexResult> {
    while (!this.stopped) {
      this.refreshThrottleGuard();
      if (!this.changedFileGuardExceeded()) {
        const request = this.changedFilesDeferredRequest;
        this.changedFilesDeferredRequest = null;
        if (!request) return { outcome: "stopped" };
        return this.enqueueRequest(request);
      }
      await this.waitForChangedFilesSignal();
    }
    return { outcome: "stopped" };
  }

  private waitForChangedFilesSignal(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.resolveChangedFilesDeferral = resolve;
    });
  }

  private releaseChangedFilesDeferral(): void {
    const resolve = this.resolveChangedFilesDeferral;
    this.resolveChangedFilesDeferral = null;
    resolve?.();
  }

  private finishChangedFilesDeferral(deferred: Promise<CoordinatedIndexResult>): void {
    if (this.changedFilesDeferred !== deferred) return;
    this.changedFilesDeferred = null;
  }

  private canRun(request: IndexRequest): boolean {
    this.refreshSafety();
    if (request.source === "manual" || request.source === "watcher") {
      return true;
    }

    return this.registration.safeToRun && this.registration.config.indexing.autoIndex;
  }
}

function getCoordinator(projectRoot: string, host: HostMode): AutoIndexCoordinator | null {
  const key = coordinatorKeysByProject.get(projectLookupKey(projectRoot, host));
  return key ? coordinators.get(key) ?? null : null;
}

export function configureAutoIndex(
  projectRoot: string,
  host: HostMode,
  config: ParsedCodebaseIndexConfig,
  getIndexer: () => CoordinatedIndexer,
): void {
  const projectKey = projectLookupKey(projectRoot, host);
  const safety = getProjectSafety(projectRoot, config);
  const registration: AutoIndexRegistration = {
    config,
    getIndexer,
    projectRoot,
    ...safety,
  };
  const key = coordinatorKey(projectRoot, config, host);
  const previousKey = coordinatorKeysByProject.get(projectKey);
  if (previousKey && previousKey !== key) {
    const previousCoordinator = coordinators.get(previousKey);
    const previousBarrier = coordinatorReplacementBarriers.get(projectKey) ?? Promise.resolve();
    const stopPrevious = previousCoordinator?.stop(true) ?? Promise.resolve();
    const activation = Promise.all([previousBarrier, stopPrevious]).then(() => undefined);
    coordinatorReplacementBarriers.set(projectKey, activation);
    coordinators.delete(previousKey);

    const coordinator = new AutoIndexCoordinator(registration);
    coordinator.activateAfter(activation);
    coordinators.set(key, coordinator);
    coordinatorKeysByProject.set(projectKey, key);
    return;
  }

  let coordinator = coordinators.get(key);
  if (!coordinator) {
    coordinator = new AutoIndexCoordinator(registration);
    coordinators.set(key, coordinator);
  } else {
    coordinator.update(registration);
  }
  coordinatorKeysByProject.set(projectKey, key);
}

export function startAutoIndex(
  projectRoot: string,
  host: HostMode,
  source: "startup" | "retrieval" = "startup",
): Promise<CoordinatedIndexResult> | null {
  return getCoordinator(projectRoot, host)?.start(source) ?? null;
}

export function requestBackgroundIndex(
  projectRoot: string,
  host: HostMode,
  changedFiles = 0,
): Promise<CoordinatedIndexResult> | null {
  return getCoordinator(projectRoot, host)?.request({
    changedFiles,
    checkFreshness: false,
    coalesce: true,
    force: false,
    source: "watcher",
  }) ?? null;
}

export function runCoordinatedIndex(
  projectRoot: string,
  host: HostMode,
  force: boolean,
  onProgress?: (progress: IndexProgress) => void,
): Promise<CoordinatedIndexResult> | null {
  return getCoordinator(projectRoot, host)?.request({
    changedFiles: 0,
    checkFreshness: !force,
    coalesce: false,
    force,
    onProgress,
    source: "manual",
  }) ?? null;
}

export function getAutoIndexStatus(
  projectRoot: string,
  host: HostMode,
): AutoIndexStatusSnapshot {
  return getCoordinator(projectRoot, host)?.snapshot() ?? {
    enabled: false,
    state: "idle",
    updatedAt: now(),
  };
}

export async function waitForAutoIndexForRetrieval(
  projectRoot: string,
  host: HostMode,
): Promise<AutoIndexRetrievalResult> {
  const coordinator = getCoordinator(projectRoot, host);
  if (!coordinator) return { ready: true };
  const initial = coordinator.snapshot();
  if (!initial.enabled) return { ready: true };
  if (initial.blockedReason === "home-directory") {
    return {
      ready: false,
      text: "Automatic indexing is disabled for the home directory. Open a specific project and retry.",
    };
  }
  if (initial.blockedReason === "project-marker-missing") {
    return {
      ready: false,
      text: "Automatic indexing is waiting for a recognized project marker. Add a project marker or set indexing.requireProjectMarker=false, then retry.",
    };
  }

  let existingIndex = false;
  try {
    const indexState = await readIndexState(coordinator);
    if (indexState.current) return { ready: true };
    existingIndex = indexState.readable;
  } catch {
    // The coordinator reports a sanitized actionable failure below.
  }

  const job = coordinator.start("retrieval", { coalesce: existingIndex }) ?? coordinator.currentJob();
  if (existingIndex) {
    // A readable stale index serves retrieval while the refresh runs in the background.
    // Incompatible indexes fall through to the bounded first-use wait so the failure
    // state surfaces instead of a silently wrong-index response.
    if (job) void job.then(() => undefined, () => undefined);
    return { ready: true };
  }

  if (job) {
    await withTimeout(job, coordinator.getWaitMs());
  }

  try {
    if ((await readIndexState(coordinator)).current) return { ready: true };
  } catch {
    // The coordinator reports a sanitized actionable failure below.
  }

  const status = coordinator.snapshot();
  if (status.state === "failed") {
    return {
      ready: false,
      text: `Automatic indexing failed${status.errorAt ? ` at ${status.errorAt}` : ""}. ${status.lastError ?? "Check index_status, then run index_codebase."}`,
    };
  }
  if (status.state === "stopped") {
    return {
      ready: false,
      text: "Automatic indexing stopped before a readable index was ready. Restart the MCP server or run index_codebase.",
    };
  }
  return {
    ready: false,
    text: `Automatic indexing is ${status.state}. Retry shortly or call index_status for progress. You can also run index_codebase explicitly.`,
  };
}

export async function stopAutoIndex(
  projectRoot: string,
  host: HostMode,
): Promise<void> {
  await getCoordinator(projectRoot, host)?.stop();
}

export async function stopAllAutoIndexes(): Promise<void> {
  await Promise.all(Array.from(coordinators.values(), (coordinator) => coordinator.stop()));
}

export async function resetAutoIndexCoordinatorsForTests(): Promise<void> {
  await stopAllAutoIndexes();
  await Promise.all(coordinatorReplacementBarriers.values());
  coordinators.clear();
  coordinatorKeysByProject.clear();
  coordinatorReplacementBarriers.clear();
}

async function readIndexState(coordinator: AutoIndexCoordinator): Promise<{ current: boolean; readable: boolean }> {
  const indexer = coordinator.getIndexer();
  if (indexer.getIndexFreshness) {
    const freshness = await indexer.getIndexFreshness();
    // An incompatible index cannot serve retrieval; treat it like a missing first-use index.
    const usable = freshness.readable && freshness.reason !== "incompatible";
    return { current: usable && freshness.current, readable: usable };
  }
  const indexed = (await indexer.getStatus()).indexed;
  return { current: indexed, readable: indexed };
}
