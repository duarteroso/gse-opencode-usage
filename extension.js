/* extension.js
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Soup from 'gi://Soup?version=3.0';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');
Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');

// The account-wide Go plan usage meter — the exact numbers the console at
// https://opencode.ai/auth shows. Authenticated with the same bearer token the
// opencode CLI stores for the `opencode-go` provider.
const USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';
const CONSOLE_URL = 'https://opencode.ai/auth';
const AUTH_PATH = ['.local', 'share', 'opencode', 'auth.json'];
const PROVIDER_ID = 'opencode-go';

const RESET_ICON_NAME = 'alarm-symbolic';

// `_()` (gettext) can only be called once the extension is fully initialized —
// calling it at module-evaluation time throws "gettext can only be called from
// extensions" and silently aborts the whole module load, so these labels stay
// untranslated here and get wrapped in `_()` only at render time.
//
// `N_()` is a no-op identity marker (not a real translation call) that exists
// purely so `xgettext --keyword=N_` can still find and extract these literals
// into the .pot even though the real `_()` call on them happens elsewhere,
// on the variable rather than a literal — see po/POTFILES.
//
// The keys match the API response's `usage` object; the order here is the order
// the menu renders in.
function N_(s) {
    return s;
}

const WINDOWS = [
    {key: 'rolling', menuLabel: N_('Last 5 hours')},
    {key: 'weekly', menuLabel: N_('This week')},
    {key: 'monthly', menuLabel: N_('This month')},
];

// Remote call, and the API only reports whole percentages, so there's nothing
// to gain from polling faster than the default. User-selectable from the
// "Refresh Interval" submenu; not persisted across restarts.
const REFRESH_INTERVALS = [
    {seconds: 60, label: N_('1 minute')},
    {seconds: 120, label: N_('2 minutes')},
    {seconds: 300, label: N_('5 minutes')},
    {seconds: 600, label: N_('10 minutes')},
    {seconds: 900, label: N_('15 minutes')},
];
const DEFAULT_REFRESH_INTERVAL_SECONDS = 900;

// Minimal printf-style substitution. Deliberately not GJS's
// `String.prototype.format`: that's a deprecated GJS-only extension installed by
// GNOME Shell's environment, so it can't be exercised outside the shell and may
// not survive future releases. Keeping whole sentences as the format string is
// what makes them translatable, hence not just using template literals.
// `%d` truncates toward zero so percentages never render with a decimal, unlike
// `%s`; a non-finite `%d` argument falls back to '?' rather than '0' or 'NaN' —
// an unknown value must never be misread as "0% used".
function fmt(template, ...args) {
    let i = 0;
    return template.replace(/%%|%[sd]/g, m => {
        if (m === '%%')
            return '%';
        const arg = args[i++];
        return m === '%d' ? (Number.isFinite(arg) ? String(Math.trunc(arg)) : '?') : String(arg);
    });
}

// Reads the bearer token the opencode CLI saved for the Go provider. Re-read on
// every refresh rather than cached, so a re-login is picked up without the
// extension needing to be restarted.
async function readApiKey() {
    const file = Gio.File.new_for_path(
        GLib.build_filenamev([GLib.get_home_dir(), ...AUTH_PATH]));

    const [contents] = await file.load_contents_async(null);
    const auth = JSON.parse(new TextDecoder().decode(contents));

    return auth?.[PROVIDER_ID]?.key ?? null;
}

// "3d 1h", "2h 5m", "45m" — mirrors how the console phrases its reset timers.
function formatResetIn(resetsAt) {
    const ms = new Date(resetsAt).getTime() - Date.now();
    if (!Number.isFinite(ms) || ms <= 0)
        return null;

    const minutes = Math.floor(ms / 60000);
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);

    if (days > 0)
        return `${days}d ${hours}h`;
    if (hours > 0)
        return `${hours}h ${minutes % 60}m`;
    return `${minutes}m`;
}

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(extensionPath) {
        super._init(0.0, _('OpenCode Go Usage'));

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});

        const iconFile = Gio.File.new_for_path(
            GLib.build_filenamev([extensionPath, 'icons', 'opencode-symbolic.svg']));
        box.add_child(new St.Icon({
            gicon: new Gio.FileIcon({file: iconFile}),
            style_class: 'system-status-icon',
        }));

        this.add_child(box);

        this._destroyed = false;

        this._session = new Soup.Session({
            user_agent: 'opencode-usage-gnome-extension/1.0',
            timeout: 15,
        });

        this._windowsSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._windowsSection);
        this._setRows([{text: _('Loading…')}]);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._refreshItem = new PopupMenu.PopupMenuItem(_('Refresh Now'));
        this._refreshItem.connect('activate', () => this.refresh());
        this.menu.addMenuItem(this._refreshItem);

        this._intervalSeconds = DEFAULT_REFRESH_INTERVAL_SECONDS;
        this._intervalMenuItems = new Map();

        const intervalItem = new PopupMenu.PopupSubMenuMenuItem(_('Refresh Interval'));
        for (const opt of REFRESH_INTERVALS) {
            const item = new PopupMenu.PopupMenuItem(_(opt.label));
            item.connect('activate', () => this._setInterval(opt.seconds));
            intervalItem.menu.addMenuItem(item);
            this._intervalMenuItems.set(opt.seconds, item);
        }
        this._updateIntervalOrnaments();
        this.menu.addMenuItem(intervalItem);

        const consoleItem = new PopupMenu.PopupMenuItem(_('Open OpenCode Console'));
        consoleItem.connect('activate', () => {
            Gio.AppInfo.launch_default_for_uri(CONSOLE_URL, null);
        });
        this.menu.addMenuItem(consoleItem);
    }

    // Each row is {text, resetIn?}
    _setRows(rows) {
        this._windowsSection.removeAll();
        for (const {text, resetIn} of rows) {
            const item = new PopupMenu.PopupMenuItem(
                text, {reactive: false, can_focus: false});

            if (resetIn) {
                item.add_child(new St.Label({
                    text: ' ~ ',
                    y_align: Clutter.ActorAlign.CENTER,
                }));

                // The icon carries meaning that's nowhere in the text, so it
                // needs an accessible name of its own for screen readers.
                item.add_child(new St.Icon({
                    icon_name: RESET_ICON_NAME,
                    style_class: 'popup-menu-icon',
                    accessible_name: _('Resets in'),
                    y_align: Clutter.ActorAlign.CENTER,
                }));
                item.add_child(new St.Label({
                    text: resetIn,
                    y_align: Clutter.ActorAlign.CENTER,
                    style: 'margin-left: 0.4em;',
                }));
            }

            this._windowsSection.addMenuItem(item);
        }
    }

    async _fetchUsage() {
        const key = await readApiKey();
        if (!key)
            throw new Error(`no ${PROVIDER_ID} credential in auth.json`);

        const message = Soup.Message.new('GET', USAGE_URL);
        message.request_headers.append('Authorization', `Bearer ${key}`);

        const bytes = await this._session.send_and_read_async(
            message, GLib.PRIORITY_DEFAULT, null);

        const status = message.get_status();
        if (status !== Soup.Status.OK)
            throw new Error(`${USAGE_URL} returned HTTP ${status}`);

        return JSON.parse(new TextDecoder().decode(bytes.get_data())).usage;
    }

    async refresh() {
        if (this._refreshing)
            return;
        this._refreshing = true;
        this._refreshItem.setSensitive(false);

        try {
            const usage = await this._fetchUsage();
            if (!this._destroyed)
                this._render(usage);
        } catch (e) {
            logError(e, 'opencode-usage: failed to fetch Go plan usage');
            if (!this._destroyed)
                this._setRows([{text: _('Could not read usage')}]);
        } finally {
            this._refreshing = false;
            if (!this._destroyed)
                this._refreshItem.setSensitive(true);
        }
    }

    _render(usage) {
        const rows = [];

        for (const w of WINDOWS) {
            const data = usage?.[w.key];
            if (!data || !Number.isFinite(data.percent)) {
                rows.push({text: fmt(_('%s: unavailable'), _(w.menuLabel))});
                continue;
            }

            // The API reports percent *used*.
            const used = Math.max(0, Math.min(100, data.percent));
            const resetIn = data.resetsAt ? formatResetIn(data.resetsAt) : null;

            let text = fmt(_('%s: %d%% used'), _(w.menuLabel), used);
            if (data.status && data.status !== 'ok')
                text += ` · ${data.status}`;
            rows.push({text, resetIn});
        }

        this._setRows(rows);
    }

    _updateIntervalOrnaments() {
        for (const [seconds, item] of this._intervalMenuItems)
            item.setOrnament(seconds === this._intervalSeconds
                ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
    }

    _setInterval(seconds) {
        if (seconds === this._intervalSeconds)
            return;
        this._intervalSeconds = seconds;
        this._updateIntervalOrnaments();

        // Reschedule on the new period rather than waiting out whatever's
        // left of the old one, but don't re-fetch immediately — the data
        // just shown is still current.
        this.stopPolling();
        this._schedulePolling();
    }

    _schedulePolling() {
        this._timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, this._intervalSeconds, () => {
                this.refresh();
                return GLib.SOURCE_CONTINUE;
            });
    }

    startPolling() {
        this.refresh();
        this._schedulePolling();
    }

    stopPolling() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
    }

    destroy() {
        this._destroyed = true;
        this.stopPolling();
        this._session?.abort();
        this._session = null;
        super.destroy();
    }
});

export default class OpencodeUsageExtension extends Extension {
    enable() {
        this._indicator = new Indicator(this.path);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._indicator.startPolling();
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
