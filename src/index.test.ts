import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    STALE_CHUNK_RELOAD_GUARD_MS,
    STALE_CHUNK_RELOAD_KEY,
    configureStaleChunkRecovery,
    installStaleChunkRecovery,
    isDynamicImportError,
    recoverFromStaleChunk,
    reloadWithLatestVersion,
    resetStaleChunkRecoveryForTests,
} from "./index.js";

const CHROME = new TypeError(
    "Failed to fetch dynamically imported module: https://example.com/assets/Settings-DDHNXpEr.js",
);
const FIREFOX = new TypeError(
    "error loading dynamically imported module: https://example.com/assets/Settings-DDHNXpEr.js",
);
const SAFARI_MIME = new TypeError("'text/html' is not a valid JavaScript MIME type.");
const SAFARI = new TypeError("Importing a module script failed.");
const VITE_CSS = new Error("Unable to preload CSS for /assets/Settings-BEnX7yUz.css");
const SECURITY = Object.assign(new Error("The operation is insecure."), { name: "SecurityError" });

let reload: ReturnType<typeof vi.fn>;

type FakeContainer = {
    getRegistration: ReturnType<typeof vi.fn>;
    addEventListener: (type: string, listener: () => void) => void;
    removeEventListener: (type: string, listener: () => void) => void;
    fireControllerChange: () => void;
    listenerCount: () => number;
};

function fakeServiceWorker(waiting: { postMessage: ReturnType<typeof vi.fn> } | null): FakeContainer {
    const listeners = new Set<() => void>();
    const container: FakeContainer = {
        getRegistration: vi.fn().mockResolvedValue(waiting ? { waiting } : { waiting: null }),
        addEventListener: (type, listener) => {
            if (type === "controllerchange") listeners.add(listener);
        },
        removeEventListener: (type, listener) => {
            if (type === "controllerchange") listeners.delete(listener);
        },
        fireControllerChange: () => [...listeners].forEach((listener) => listener()),
        listenerCount: () => listeners.size,
    };
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: container });
    return container;
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T10:00:00Z"));
    sessionStorage.clear();
    resetStaleChunkRecoveryForTests();
    reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    Reflect.deleteProperty(navigator, "serviceWorker");
});

describe("isDynamicImportError", () => {
    it.each([
        ["Chrome and Edge", CHROME],
        ["Firefox", FIREFOX],
        ["Safari (server answered with index.html)", SAFARI_MIME],
        ["Safari (404 or broken connection)", SAFARI],
        ["Vite CSS preload", VITE_CSS],
    ])("recognizes the %s message", (_browser, error) => {
        expect(isDynamicImportError(error)).toBe(true);
    });

    it("recognizes a plain string message", () => {
        expect(isDynamicImportError("Importing a module script failed.")).toBe(true);
    });

    it.each([
        ["a SecurityError", SECURITY],
        ["reading a property of an undefined module", new TypeError("Cannot read properties of undefined (reading 'default')")],
        ["a plain network error", new TypeError("Failed to fetch")],
        ["an ordinary error", new Error("card declined")],
        ["null", null],
        ["undefined", undefined],
    ])("does not treat %s as a dynamic import error", (_name, error) => {
        expect(isDynamicImportError(error)).toBe(false);
    });
});

describe("recoverFromStaleChunk", () => {
    it("reloads the page once on a dynamic import error", async () => {
        expect(recoverFromStaleChunk(CHROME)).toBe("reloading");
        await vi.runAllTimersAsync();
        expect(reload).toHaveBeenCalledTimes(1);
        expect(sessionStorage.getItem(STALE_CHUNK_RELOAD_KEY)).toBe(String(Date.now()));
    });

    it("reloads on the Safari MIME type message too", async () => {
        expect(recoverFromStaleChunk(SAFARI_MIME)).toBe("reloading");
        await vi.runAllTimersAsync();
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it("ignores other errors and leaves no stamp", async () => {
        expect(recoverFromStaleChunk(SECURITY)).toBe("skipped");
        expect(recoverFromStaleChunk(new Error("card declined"))).toBe("skipped");
        await vi.runAllTimersAsync();
        expect(reload).not.toHaveBeenCalled();
        expect(sessionStorage.getItem(STALE_CHUNK_RELOAD_KEY)).toBeNull();
    });

    it("does not reload twice inside the guard window, so a broken release cannot loop", async () => {
        sessionStorage.setItem(STALE_CHUNK_RELOAD_KEY, String(Date.now() - 5_000));
        expect(recoverFromStaleChunk(CHROME)).toBe("skipped");
        await vi.runAllTimersAsync();
        expect(reload).not.toHaveBeenCalled();
    });

    it("reloads again once the guard window has passed", async () => {
        sessionStorage.setItem(STALE_CHUNK_RELOAD_KEY, String(Date.now() - STALE_CHUNK_RELOAD_GUARD_MS - 1));
        expect(recoverFromStaleChunk(CHROME)).toBe("reloading");
        await vi.runAllTimersAsync();
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it("treats an unreadable stamp as no earlier reload", async () => {
        sessionStorage.setItem(STALE_CHUNK_RELOAD_KEY, "not a number");
        expect(recoverFromStaleChunk(CHROME)).toBe("reloading");
        await vi.runAllTimersAsync();
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it("reloads once when the listener and an error boundary report the same error", async () => {
        expect(recoverFromStaleChunk(CHROME)).toBe("reloading");
        expect(recoverFromStaleChunk(CHROME)).toBe("reloading");
        await vi.runAllTimersAsync();
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it("still skips an unrelated error while a reload is scheduled", () => {
        recoverFromStaleChunk(CHROME);
        expect(recoverFromStaleChunk(SECURITY)).toBe("skipped");
    });

    it("does not reload while offline, because the browser would show its offline page", async () => {
        vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
        expect(recoverFromStaleChunk(CHROME)).toBe("skipped");
        await vi.runAllTimersAsync();
        expect(reload).not.toHaveBeenCalled();
    });

    it("does not reload when sessionStorage throws, because a loop could not be prevented", async () => {
        const blocked = () => {
            throw new DOMException("The operation is insecure.", "SecurityError");
        };
        vi.stubGlobal("sessionStorage", { getItem: blocked, setItem: blocked, removeItem: blocked, clear: blocked });
        expect(recoverFromStaleChunk(CHROME)).toBe("skipped");
        await vi.runAllTimersAsync();
        expect(reload).not.toHaveBeenCalled();
    });

    it("activates a waiting service worker first, then reloads", async () => {
        const waiting = { postMessage: vi.fn() };
        const container = fakeServiceWorker(waiting);

        expect(recoverFromStaleChunk(SAFARI)).toBe("reloading");
        await vi.advanceTimersByTimeAsync(0);
        expect(waiting.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
        expect(reload).not.toHaveBeenCalled();

        container.fireControllerChange();
        await vi.advanceTimersByTimeAsync(0);
        expect(reload).toHaveBeenCalledTimes(1);
        expect(container.listenerCount()).toBe(0);
    });

    it("stops waiting for a worker that never takes control and reloads anyway", async () => {
        const waiting = { postMessage: vi.fn() };
        const container = fakeServiceWorker(waiting);

        recoverFromStaleChunk(CHROME);
        await vi.advanceTimersByTimeAsync(2_900);
        expect(reload).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(200);
        expect(reload).toHaveBeenCalledTimes(1);
        expect(container.listenerCount()).toBe(0);
    });

    it("reloads without waiting when no worker is waiting", async () => {
        const container = fakeServiceWorker(null);
        recoverFromStaleChunk(CHROME);
        await vi.advanceTimersByTimeAsync(0);
        expect(container.getRegistration).toHaveBeenCalled();
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it("reloads anyway when the registration never arrives", async () => {
        const container = fakeServiceWorker(null);
        container.getRegistration.mockReturnValue(new Promise(() => {}));
        recoverFromStaleChunk(CHROME);
        await vi.advanceTimersByTimeAsync(2_900);
        expect(reload).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(200);
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it("reloads anyway and reports it when the registration cannot be read", async () => {
        const onWarn = vi.fn();
        configureStaleChunkRecovery({ onWarn });
        const container = fakeServiceWorker(null);
        const denied = new Error("denied");
        container.getRegistration.mockRejectedValue(denied);
        recoverFromStaleChunk(CHROME);
        await vi.advanceTimersByTimeAsync(0);
        expect(reload).toHaveBeenCalledTimes(1);
        expect(onWarn).toHaveBeenCalledWith("Waiting service worker could not be activated", denied);
    });

    it("waits for isBusy to turn false before reloading", async () => {
        let busy = true;
        configureStaleChunkRecovery({ isBusy: () => busy });

        expect(recoverFromStaleChunk(CHROME)).toBe("reloading");
        await vi.advanceTimersByTimeAsync(10_000);
        expect(reload).not.toHaveBeenCalled();

        busy = false;
        await vi.advanceTimersByTimeAsync(500);
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it("keeps waiting when work starts while the worker activates", async () => {
        let busy = false;
        configureStaleChunkRecovery({ isBusy: () => busy });
        const waiting = { postMessage: vi.fn() };
        const container = fakeServiceWorker(waiting);

        recoverFromStaleChunk(CHROME);
        await vi.advanceTimersByTimeAsync(0);
        expect(waiting.postMessage).toHaveBeenCalled();
        busy = true;
        container.fireControllerChange();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(reload).not.toHaveBeenCalled();

        busy = false;
        await vi.advanceTimersByTimeAsync(500);
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it("writes the stamp at reload time, so a long wait does not use up the guard window", async () => {
        let busy = true;
        configureStaleChunkRecovery({ isBusy: () => busy });
        const firstStamp = Date.now();
        recoverFromStaleChunk(CHROME);
        await vi.advanceTimersByTimeAsync(STALE_CHUNK_RELOAD_GUARD_MS + 5_000);
        busy = false;
        await vi.advanceTimersByTimeAsync(500);
        expect(reload).toHaveBeenCalledTimes(1);
        expect(Number(sessionStorage.getItem(STALE_CHUNK_RELOAD_KEY))).toBeGreaterThan(
            firstStamp + STALE_CHUNK_RELOAD_GUARD_MS,
        );
    });

    it("reports the reload through onWarn", async () => {
        const onWarn = vi.fn();
        configureStaleChunkRecovery({ onWarn });
        recoverFromStaleChunk(CHROME);
        await vi.runAllTimersAsync();
        expect(onWarn).toHaveBeenCalledTimes(1);
        expect(onWarn).toHaveBeenCalledWith(expect.stringContaining("reloading once"), CHROME);
    });

    it("replaces the earlier configuration on every configure call", async () => {
        configureStaleChunkRecovery({ isBusy: () => true });
        configureStaleChunkRecovery({});
        recoverFromStaleChunk(CHROME);
        await vi.advanceTimersByTimeAsync(0);
        expect(reload).toHaveBeenCalledTimes(1);
    });
});

describe("reloadWithLatestVersion", () => {
    it("ignores the guard window, leaves the stamp alone, activates a waiting worker and reloads", async () => {
        sessionStorage.setItem(STALE_CHUNK_RELOAD_KEY, String(Date.now()));
        const stamp = sessionStorage.getItem(STALE_CHUNK_RELOAD_KEY);
        const waiting = { postMessage: vi.fn() };
        const container = fakeServiceWorker(waiting);

        const done = reloadWithLatestVersion();
        await vi.advanceTimersByTimeAsync(0);
        expect(waiting.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
        container.fireControllerChange();
        await done;
        expect(reload).toHaveBeenCalledTimes(1);
        expect(sessionStorage.getItem(STALE_CHUNK_RELOAD_KEY)).toBe(stamp);
    });

    it("waits while the app is busy", async () => {
        let busy = true;
        configureStaleChunkRecovery({ isBusy: () => busy });

        void reloadWithLatestVersion();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(reload).not.toHaveBeenCalled();

        busy = false;
        await vi.advanceTimersByTimeAsync(500);
        expect(reload).toHaveBeenCalledTimes(1);
    });
});

describe("installStaleChunkRecovery", () => {
    function preloadError(payload: unknown): Event {
        const event = new Event("vite:preloadError", { cancelable: true });
        Object.assign(event, { payload });
        window.dispatchEvent(event);
        return event;
    }

    it("reloads on vite:preloadError and leaves the event alone so an error boundary still sees the error", async () => {
        installStaleChunkRecovery();
        const event = preloadError(CHROME);
        await vi.runAllTimersAsync();
        expect(reload).toHaveBeenCalledTimes(1);
        expect(event.defaultPrevented).toBe(false);
    });

    it("adds a single listener when installed twice", () => {
        const add = vi.spyOn(window, "addEventListener");
        installStaleChunkRecovery();
        installStaleChunkRecovery();
        expect(add.mock.calls.filter(([type]) => type === "vite:preloadError")).toHaveLength(1);
    });

    it("does not reload when the chunk loaded and then threw", async () => {
        installStaleChunkRecovery();
        preloadError(SECURITY);
        await vi.runAllTimersAsync();
        expect(reload).not.toHaveBeenCalled();
        expect(sessionStorage.getItem(STALE_CHUNK_RELOAD_KEY)).toBeNull();
    });

    it("does not reload on an unrecognized message but reports it through onWarn", async () => {
        const onWarn = vi.fn();
        configureStaleChunkRecovery({ onWarn });
        installStaleChunkRecovery();
        const unknown = new TypeError("A browser message nobody has seen");
        preloadError(unknown);
        await vi.runAllTimersAsync();
        expect(reload).not.toHaveBeenCalled();
        expect(onWarn).toHaveBeenCalledWith(expect.stringContaining("vite:preloadError"), unknown);
    });

    it("keeps to the guard window when the event triggers the reload", async () => {
        sessionStorage.setItem(STALE_CHUNK_RELOAD_KEY, String(Date.now() - 1_000));
        installStaleChunkRecovery();
        preloadError(SAFARI_MIME);
        await vi.runAllTimersAsync();
        expect(reload).not.toHaveBeenCalled();
    });
});
