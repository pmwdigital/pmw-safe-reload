# @pmwdigital/safe-reload

Reload a single-page app once after a deploy has removed a lazy chunk that an old tab still asks for, and never while the user is in the middle of work.

No dependencies. Written in TypeScript, shipped as ESM, runs in the browser.

## The problem

A tab opened before a deploy keeps running the old build. When the user opens a route that loads lazily, the old build asks for a hashed file that the new deploy no longer serves. The server answers 404, or returns `index.html` as its single-page-app fallback, and the dynamic `import()` rejects. Each browser words the error differently:

| Browser | Message |
| --- | --- |
| Chrome, Edge | `Failed to fetch dynamically imported module` |
| Firefox | `error loading dynamically imported module` |
| Safari, server returned `index.html` | `'text/html' is not a valid JavaScript MIME type` |
| Safari, 404 or broken connection | `Importing a module script failed` |
| Vite, chunk CSS | `Unable to preload CSS` |

The user stays on an error screen until they reload by hand. A bare `window.location.reload()` in the error handler brings its own problems: it cuts off a request in flight, it throws away unsaved input, it loops forever when the new build is broken too, and with a service worker waiting it reloads into the old cached `index.html` and fails again.

## Install

```bash
npm install github:pmwdigital/pmw-safe-reload
```

The package builds itself with its `prepare` script when installed from GitHub. If your npm config sets `ignore-scripts`, that build is skipped.

## Usage with Vite

Call this once, before the app renders:

```ts
import {
    configureStaleChunkRecovery,
    installStaleChunkRecovery,
} from "@pmwdigital/safe-reload";

configureStaleChunkRecovery({ isBusy: () => paymentInFlight() });
installStaleChunkRecovery();
```

In a production build, Vite routes dynamic `import()` calls through a helper. When the import or its preloaded CSS fails, the helper dispatches a cancelable `vite:preloadError` event on `window` with the original error in `event.payload`, and rethrows the error unless the event was canceled. `installStaleChunkRecovery()` listens for that event. It does not call `preventDefault()`, so the original error still reaches your error boundary.

## Usage with React.lazy

```tsx
import { lazy, Suspense } from "react";

const Settings = lazy(() => import("./Settings"));

export function App() {
    return (
        <RouteBoundary>
            <Suspense fallback={<p>Loading...</p>}>
                <Settings />
            </Suspense>
        </RouteBoundary>
    );
}
```

With Vite, the install above already reloads when this import fails. The error boundary is where you show something better than a crash while the reload waits. Builds that never dispatch `vite:preloadError` can start recovery from the boundary instead:

```tsx
import { Component, type ReactNode } from "react";
import { recoverFromStaleChunk } from "@pmwdigital/safe-reload";

type State = { failed: boolean; reloading: boolean };

export class RouteBoundary extends Component<{ children: ReactNode }, State> {
    state: State = { failed: false, reloading: false };

    static getDerivedStateFromError(): Partial<State> {
        return { failed: true };
    }

    componentDidCatch(error: unknown) {
        this.setState({ reloading: recoverFromStaleChunk(error) === "reloading" });
    }

    render() {
        if (!this.state.failed) return this.props.children;
        return this.state.reloading ? <p>Loading the new version...</p> : <p>Something went wrong.</p>;
    }
}
```

`recoverFromStaleChunk(error)` returns `"reloading"` when a reload is scheduled, by this call or an earlier one, and `"skipped"` otherwise. If the listener and the boundary both report the same error, the page still reloads once.

## When the page reloads

`recoverFromStaleChunk(error)` runs these checks in order and returns `"skipped"` at the first one that fails:

1. The error message matches one of the patterns in the table above. Any other error is ignored.
2. The browser is online. An offline reload would land on the browser's offline page.
3. This tab has not reloaded through the library in the last 60 seconds. The time of the last reload is kept in `sessionStorage`, so a new build that is broken too ends on your error screen instead of looping. If `sessionStorage` cannot be read or written, nothing reloads, because a loop could not be prevented.

If all three pass, it waits and then reloads:

4. `isBusy()` is polled every 250 ms until it returns `false`.
5. If a service worker is waiting, it receives `{ type: "SKIP_WAITING" }` and the library waits for `controllerchange`, at most 3 seconds. Without this step the old worker would serve the old `index.html` again.
6. `isBusy()` is checked once more, because work can start during step 5. The stamp in `sessionStorage` is written again at this moment, so a long wait does not use up the 60 second window. Then the page reloads.

## Never while the user is busy

The library cannot see what the user is doing, so the app tells it. `isBusy` returns `true` while a payment request is in flight, a form holds unsaved input, an upload is running, and so on. While it returns `true`, no automatic reload happens, however long that takes. The last `isBusy()` check and `window.location.reload()` run in the same task, so no click or key press can land between them.

## Reload button

```ts
import { reloadWithLatestVersion } from "@pmwdigital/safe-reload";

reloadButton.addEventListener("click", () => void reloadWithLatestVersion());
```

`reloadWithLatestVersion()` is for a visible "Reload" button. It waits for `isBusy` and for a waiting service worker like automatic recovery does, but it ignores the 60 second window and leaves the stamp alone. Its promise resolves after `window.location.reload()` has been called.

## Reporting

```ts
configureStaleChunkRecovery({
    isBusy: () => paymentInFlight(),
    onWarn: (message, error) => console.warn(message, error),
});
```

`onWarn` is optional. It receives a short human-readable message and the original error when the library schedules a reload, when it ignores a `vite:preloadError` whose message it does not recognize, and when a waiting service worker cannot be activated. Do not match on the message text.

## API

| Export | What it does |
| --- | --- |
| `installStaleChunkRecovery()` | Listens for `vite:preloadError` and recovers from dynamic import errors. Calling it twice adds one listener. |
| `configureStaleChunkRecovery({ isBusy, onWarn })` | Sets the busy callback and the reporter. Both are optional, and without `isBusy` the page is never considered busy. Every call replaces the previous configuration. |
| `recoverFromStaleChunk(error)` | Starts recovery for an error you caught yourself. Returns `"reloading"` or `"skipped"`. |
| `reloadWithLatestVersion()` | Reload for a manual button. Waits like automatic recovery and ignores the 60 second window. |
| `isDynamicImportError(error)` | `true` when the error, an `Error` or a string, matches a known message. |
| `STALE_CHUNK_RELOAD_KEY` | The `sessionStorage` key, `"safe-reload:reloaded-at"`. |
| `STALE_CHUNK_RELOAD_GUARD_MS` | The window in which a second automatic reload is refused, `60000`. |
| `resetStaleChunkRecoveryForTests()` | Removes the listener and clears the module state. For test suites only. |
| `StaleChunkRecovery` | Type of the result of `recoverFromStaleChunk`: `"reloading"` or `"skipped"`. |

## Limits

- Detection is by message text. The five patterns above are all the library knows. A browser that words the error differently is not recognized until a pattern is added, and `onWarn` reports the `vite:preloadError` events it did not recognize so you can notice. Webpack's `ChunkLoadError` is not matched.
- Only `vite:preloadError` is listened to. With other bundlers, or for `import()` calls that Vite does not wrap, call `recoverFromStaleChunk(error)` from your own catch block or error boundary. Bundlers that keep native `import()` get the browser messages in the table.
- A reload only helps when the next load fetches the new build. The waiting service worker must call `self.skipWaiting()` when it receives `{ type: "SKIP_WAITING" }`, the message convention used in the Workbox docs. A worker that ignores the message is waited for 3 seconds, the page reloads anyway, and the 60 second window prevents a second attempt.
- At most one automatic reload per tab per 60 seconds.
- `isBusy` is polled, not pushed. If it never returns `false`, the page never reloads and the error screen stays.
- There is one configuration per page, kept in module state.
- It reacts to a failed import only. It does not check for new versions in the background and it shows no UI.

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
```

The 39 tests run in jsdom with fake timers. They use the error messages quoted above and stand-ins for the service worker and `location.reload`, so no real browser is involved.

## License

MIT
