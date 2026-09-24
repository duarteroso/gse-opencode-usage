# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A GNOME Shell extension (uuid `opencodeusage@duarte.roso`) that shows remaining OpenCode Go subscription usage, per limit window, in the top panel.

It reads the **account-wide** usage meter — the same three numbers the console at `https://opencode.ai/auth` displays:

```
GET https://opencode.ai/zen/go/v1/usage
Authorization: Bearer <opencode-go key from ~/.local/share/opencode/auth.json>

{"usage":{
  "rolling":{"status":"ok","percent":0,"resetsAt":"2026-09-24T20:31:50.142Z"},
  "weekly": {"status":"ok","percent":0,"resetsAt":"2026-09-28T00:00:00.000Z"},
  "monthly":{"status":"ok","percent":81,"resetsAt":"2026-09-27T17:01:24.000Z"}}}
```

`percent` is percent **used**; the UI renders it directly as used. `rolling` is the 5-hour window. This endpoint is undocumented (it is not in `https://opencode.ai/v2/openapi.json`, which only covers the local server) but verified working against a live account.

### Two dead ends — do not reintroduce them

- **`opencode api experimental.session.stats` is the wrong data source.** It reports only *this machine's local sessions*, not account usage. Measured against a real account: it showed $0.01 of `opencode-go` spend over 30 days while the account's actual monthly usage was 81%. Any approach built on it will read near-zero and display ~100% remaining regardless of real usage. (`opencode stats --days N` is additionally calendar-day-only, so it can't express a 5-hour window at all.)
- **The limits are not usefully per-model here.** `https://opencode.ai/docs/go/` does describe per-model dollar caps (5h = 20% of the monthly cap, weekly = 50%, monthly = 100%), and an earlier version of this extension hardcoded a `MODEL_INFO` cap table from those docs. That table was guesswork that went stale instantly, and the console does not report per-model figures anyway — it reports the three aggregate percentages above, which is what the plan is actually throttled on. The endpoint returns percentages only, with **no dollar amounts**, so the UI cannot show `$` remaining.

This directory is not a git repository and has no build tooling, package.json, or test suite — it's a live extension directory read directly by GNOME Shell (it sits directly at `~/.local/share/gnome-shell/extensions/opencodeusage@duarte.roso`, GNOME Shell's extensions search path, not a symlink into it).

## Files

- `extension.js` — entry point. Exports a default class extending `Extension` with `enable()`/`disable()`, and a `PanelMenu.Button` indicator (`GObject.registerClass`) shown in the top panel. Polls the usage endpoint via `Soup.Session` every 120s. The panel shows only the icon, in every state (normal, error, before the first fetch); all figures live in the popup, which lists all three windows with used % and a reset countdown marked by an alarm icon, e.g. `This month: 81% used ~ ⏰ 3d 1h`.
- `metadata.json` — extension metadata: `uuid`, `name`, `description`, supported `shell-version`.
- `stylesheet.css` — custom St/CSS styling for the extension's actors (currently empty).
- `icons/opencode-logo.svg` — bundled panel icon (the opencode logo). This is a full-color raster logo embedded in an SVG wrapper (`<image href="data:image/png;base64,...">`), **not** a single-color/`currentColor` vector, so unlike a conventional `-symbolic` status icon GNOME Shell cannot recolor it to match the panel theme — it always renders in its own fixed colors. Loaded via `Gio.FileIcon` in `extension.js` rather than an icon-theme lookup, since it's not installed system-wide. `St.Icon`'s `system-status-icon` style class still applies (it only sets the panel icon size, `icon-size: 1.09em`; it does not force symbolic recoloring for a `Gio.FileIcon`).
- `po/` — localization sources: `POTFILES` (the file list `xgettext` scans), `opencodeusage@duarte.roso.pot` (the extracted template), 22 complete (9/9 messages) `.po` files — `fr`, `pt` (European), `es`, `de`, `it`, `nl`, `pt_BR` (Brazilian), `ru`, `zh_CN`, `ja`, `ko`, `tr`, `pl`, `uk`, `ro`, `ar` (Modern Standard Arabic), `hi` (Hindi), `th`, `vi`, `cs`, `sk`, `eo` (Esperanto) — and `README.md` (how to add a language and regenerate the template). No `en.po` — English is the source language the strings are already written in. Their compiled `.mo`s are checked into `locale/<lang>/LC_MESSAGES/opencodeusage@duarte.roso.mo` for local testing; re-run `msgfmt` there after editing a `.po` (see `po/README.md`) so the two don't drift. `gnome-extensions pack --podir=po --extra-source=icons .` also (re)compiles every `.po` into `locale/` at pack time. **`--extra-source=icons` is required**: `gnome-extensions pack` only bundles `metadata.json`, `extension.js`, `stylesheet.css`, `prefs.js`, and compiled schemas/locale by default, so without it the `icons/` directory — and therefore the panel icon `extension.js` loads relative to `extensionPath` — is silently left out of the zip.
- **`fmt()`'s placeholders resolve by order-of-appearance in the translated string, not by declared position** (no `%1$s` support) — so a translation is free to reorder `%s`/`%d`/`%%` relative to the English source (`tr.po` does this: `%%%d` puts the percent sign before the number for `%81`-style phrasing) but must never rebind which *argument* a placeholder consumes (e.g. swapping the window name and the percentage). See `po/README.md` for the full explanation and worked example.

## Notes for this extension specifically

- **Never call `_()` (gettext) at module scope.** It throws `Error: gettext can only be called from extensions` until the `Extension` instance exists (GNOME Shell only wires up the gettext context partway through loading the module — see `ui/extensionSystem.js`'s `_callExtensionInit`), which aborts the entire module import silently and makes the indicator never appear, with no visible error outside the shell's own log. Keep translatable strings as plain string literals in module-scope data (like `WINDOWS`) and wrap them in `_()` only inside methods that run after construction.
- **`xgettext` can't see through a variable.** `_(w.menuLabel)` at render time doesn't give `xgettext` a literal to extract, so the `WINDOWS` labels are additionally wrapped in `N_()` — a no-op identity function that exists only as an `xgettext --keyword=N_` marker — right where they're defined. Any new module-scope string that's translated later via a variable needs the same treatment, and the `xgettext` invocation in `po/README.md` must keep `--keyword=N_` alongside `--keyword=_`.
- A `PanelMenu.Button` only lays out its **first** child (`PanelMenu.ButtonBox`'s `vfunc_allocate` only looks at `get_first_child()`); adding two separate direct children (e.g. an icon plus something else) means the second one is silently never painted. The icon is added to a single `St.BoxLayout` (`style_class: 'panel-status-menu-box'`), and that one box — not the icon directly — is added to the button, so a second child can be added to the box later without hitting this bug.
- `disable()` should use `this._indicator?.destroy()`, not a bare `.destroy()` — if `enable()` throws partway through, `_indicator` may be unset and a bare call throws again, potentially wedging re-enable.
- Menu rows are `{text, resetIn?}` objects, not strings — `_setRows()` renders `resetIn` after a `~` separator as an `alarm-symbolic` icon plus the bare duration, in place of a "resets in" caption. Don't try to right-align that countdown: `x_expand` on the item's label was tried and looks broken, because a `PopupMenuSection`'s width comes from the widest item in the entire menu (here "Open OpenCode Console"), so every row gets a differently-sized gap. Let the row flow left at its natural width. Both `_setRows()` call sites must pass objects; passing a bare string yields a row with an empty label and no error. Icon names are **not** validated at runtime: an unknown name renders as a broken-image glyph, so check any replacement resolves (`Gtk.IconTheme.has_icon`) before swapping it. Keep the icon's `accessible_name` — it's the only thing conveying "resets in" to a screen reader now that the words are gone.
- **Don't use `String.prototype.format`.** It's a deprecated GJS-only extension that GNOME Shell installs into its own environment, so it can't be exercised outside the shell and isn't guaranteed to survive. `extension.js` has a 4-line `fmt()` helper instead. Keep passing whole sentences to `_()` (not concatenated fragments) so they stay translatable.
- **The usage host is behind Cloudflare and rejects unrecognized user agents** with `HTTP 403, error code: 1010` (this is what Python's default `urllib` UA gets). The `Soup.Session` is constructed with an explicit `user_agent`; don't drop it.
- `Soup.Session.send_and_read_async` and `Gio.File.load_contents_async` are not auto-promisified in this GJS environment — both are explicitly promisified with `Gio._promisify(...)` at module scope in `extension.js`. Without that, awaiting them throws `TypeError: ... At least N arguments required`.
- `Soup.Message.send_and_read_async` resolves even for error responses — check `message.get_status()` against `Soup.Status.OK` separately, or you'll parse a Cloudflare HTML error page as JSON.
- The bearer token is read out of `~/.local/share/opencode/auth.json` (`["opencode-go"].key`) on **every** refresh rather than cached, so re-logging in with `opencode auth login` is picked up without restarting the extension. Never log it.
- Syntax-check changes quickly outside GNOME Shell with `gjs -m extension.js` (it will fail on the `resource:///...` shell imports, which is expected — that failure means the module parsed and only external imports are missing).
- To exercise the fetch/format logic for real outside GNOME Shell, slice `extension.js` at `const Indicator =`, strip the `resource:///` imports, and `import()` the remainder — everything above that line (`fmt`, `formatResetIn`, `readApiKey`, `WINDOWS`) is plain GJS with no shell dependency, so it runs under bare `gjs -m` against the live endpoint.

## Architecture notes (GNOME Shell extensions)

- Extensions use GJS (GNOME JavaScript) with ES modules and `gi://` imports for GObject-introspected libraries (e.g. `gi://GObject`, `gi://St`).
- UI is built with `St` (Shell Toolkit) widgets; panel indicators subclass `PanelMenu.Button` and are registered via `GObject.registerClass`.
- `Extension.enable()` is called when the extension is loaded/enabled and should create and register any indicators/UI; `Extension.disable()` must fully tear down what `enable()` created (destroy actors, disconnect signals, clear timeouts) since GNOME Shell can disable/re-enable extensions without restarting.
- Any polling or periodic refresh logic (needed for real-time usage tracking) should use `GLib.timeout_add`/`GLib.timeout_add_seconds` and the returned source id must be removed in `disable()` to avoid leaking timers across enable/disable cycles.
- Network/API calls must use GJS-compatible APIs — here `Soup` via `gi://Soup?version=3.0` — not `fetch`/Node/browser APIs; this runs inside GNOME Shell's Mutter/GJS process. Always pin the Soup version in the import, since libsoup 2 and 3 cannot coexist in one process.
- Anything async must be guarded against completing after teardown: `destroy()` sets a `_destroyed` flag and calls `Soup.Session.abort()`, and `refresh()` re-checks that flag before touching actors, so an in-flight request can't resurrect a destroyed indicator.

## Development workflow

- After editing files, reload the extension to pick up changes:
  - On X11: restart GNOME Shell (Alt+F2, type `r`, Enter) or run `busctl --user call org.gnome.Shell /org/gnome/Shell org.gnome.Shell Eval s 'Meta.restart("Restarting…")'`.
  - On Wayland: log out and back in, or test in a nested session with `dbus-run-session -- gnome-shell --nested --wayland`.
- Enable/disable/check status with `gnome-extensions enable opencodeusage@duarte.roso`, `gnome-extensions disable opencodeusage@duarte.roso`, `gnome-extensions info opencodeusage@duarte.roso`.
- View extension logs/errors with `journalctl -f -o cat /usr/bin/gnome-shell` (or `journalctl --user -f` depending on session type) while reproducing the issue.
- Validate `metadata.json` and packaging with `gnome-extensions pack --podir=po --extra-source=icons .` before distributing — omitting `--extra-source=icons` produces a zip missing the panel icon (see the `icons/` entry above).
