export type StaleChunkRecovery = "reloading" | "skipped";

export const STALE_CHUNK_RELOAD_KEY = "safe-reload:reloaded-at";
export const STALE_CHUNK_RELOAD_GUARD_MS = 60_000;
const WORKER_ACTIVATION_TIMEOUT_MS = 3_000;
const BUSY_POLL_MS = 250;

const DYNAMIC_IMPORT_ERROR_PATTERNS: readonly RegExp[] = [
    /Failed to fetch dynamically imported module/i,
    /error loading dynamically imported module/i,
    /is not a valid JavaScript MIME type/i,
    /Importing a module script failed/i,
    /Unable to preload CSS/i,
];

let isBusy: () => boolean = () => false;
let onWarn: ((message: string, error: unknown) => void) | undefined;
let reloadScheduled = false;
let preloadListener: ((event: Event) => void) | null = null;

const messageOf = (error: unknown): string =>
    error instanceof Error ? error.message : typeof error === "string" ? error : "";

export function isDynamicImportError(error: unknown): boolean {
    const message = messageOf(error);
    return DYNAMIC_IMPORT_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

export function configureStaleChunkRecovery(options: {
    isBusy?: () => boolean;
    onWarn?: (message: string, error: unknown) => void;
}): void {
    isBusy = options.isBusy ?? (() => false);
    onWarn = options.onWarn;
}

function writeStamp(now: number): boolean {
    try {
        sessionStorage.setItem(STALE_CHUNK_RELOAD_KEY, String(now));
        return true;
    } catch {
        return false;
    }
}

function claimReloadSlot(now: number): boolean {
    try {
        const last = Number(sessionStorage.getItem(STALE_CHUNK_RELOAD_KEY) ?? 0);
        if (now - last < STALE_CHUNK_RELOAD_GUARD_MS) return false;
        return writeStamp(now);
    } catch {
        return false;
    }
}

function waitUntilIdle(): Promise<void> {
    return new Promise((resolve) => {
        const check = () => {
            if (isBusy()) setTimeout(check, BUSY_POLL_MS);
            else resolve();
        };
        check();
    });
}

async function activateWaitingWorker(): Promise<void> {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const container = navigator.serviceWorker;
    try {
        const registration = await Promise.race([
            container.getRegistration(),
            new Promise<undefined>((resolve) => setTimeout(resolve, WORKER_ACTIVATION_TIMEOUT_MS)),
        ]);
        const waiting = registration?.waiting;
        if (!waiting) return;
        await new Promise<void>((resolve) => {
            const done = () => {
                clearTimeout(timer);
                container.removeEventListener("controllerchange", done);
                resolve();
            };
            const timer = setTimeout(done, WORKER_ACTIVATION_TIMEOUT_MS);
            container.addEventListener("controllerchange", done);
            waiting.postMessage({ type: "SKIP_WAITING" });
        });
    } catch (error) {
        onWarn?.("Waiting service worker could not be activated", error);
    }
}

async function reloadToLatestVersion(stamp: boolean): Promise<void> {
    await waitUntilIdle();
    await activateWaitingWorker();
    await waitUntilIdle();
    if (stamp) writeStamp(Date.now());
    window.location.reload();
}

export function reloadWithLatestVersion(): Promise<void> {
    return reloadToLatestVersion(false);
}

export function recoverFromStaleChunk(error: unknown): StaleChunkRecovery {
    if (!isDynamicImportError(error)) return "skipped";
    if (reloadScheduled) return "reloading";
    if (typeof navigator !== "undefined" && navigator.onLine === false) return "skipped";
    if (!claimReloadSlot(Date.now())) return "skipped";

    reloadScheduled = true;
    onWarn?.("Stale chunk failed to load; reloading once for the new version", error);
    void reloadToLatestVersion(true);
    return "reloading";
}

export function installStaleChunkRecovery(): void {
    if (typeof window === "undefined" || preloadListener !== null) return;
    preloadListener = (event) => {
        const error = (event as Event & { payload?: unknown }).payload;
        if (isDynamicImportError(error)) {
            recoverFromStaleChunk(error);
            return;
        }
        onWarn?.("vite:preloadError with an unrecognized message; page not reloaded", error);
    };
    window.addEventListener("vite:preloadError", preloadListener);
}

export function resetStaleChunkRecoveryForTests(): void {
    if (preloadListener !== null) window.removeEventListener("vite:preloadError", preloadListener);
    preloadListener = null;
    reloadScheduled = false;
    isBusy = () => false;
    onWarn = undefined;
}
