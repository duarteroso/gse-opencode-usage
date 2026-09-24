# Localization

Translatable strings live in `extension.js`, wrapped in `_()` (gettext) at
render time, or marked with `N_()` where the literal has to sit at module
scope (see the comment above `WINDOWS` in `extension.js` for why).

The gettext domain is the extension's uuid, `opencodeusage@duarte.roso`
(no `gettext-domain` override is set in `metadata.json`), so `.mo` files must
be named `opencodeusage@duarte.roso.mo`. GNOME Shell resolves them from the
extension's own `locale/<lang>/LC_MESSAGES/` directory automatically — no
`initTranslations()` call or other runtime wiring is needed.

English is the source language the strings are already written in, so there
is deliberately no `en.po` here — an untranslated string already renders as
correct English.

`fr.po`, `pt.po`, `es.po`, `de.po`, `it.po`, `nl.po`, `pt_BR.po`, `ru.po`,
`zh_CN.po`, `ja.po`, `ko.po`, `tr.po`, `pl.po`, `uk.po`, `ro.po`, `ar.po`,
`hi.po`, `th.po`, `vi.po`, `cs.po`, `sk.po`, and `eo.po` are all complete
(9/9 messages, checked with `msgfmt --check`), and their compiled `.mo`
files are checked into `locale/<lang>/LC_MESSAGES/` already, so all
twenty-two languages work for local testing (`gnome-extensions enable` +
switching `LANG`) without running the pack step below. `eo` is Esperanto —
a real ISO 639-1 / gettext language code with its own `Plural-Forms` rule,
same as any other supported locale here. `pt.po` is European Portuguese,
`pt_BR.po` is Brazilian; `ar.po` is Modern Standard Arabic (the shell
handles the RTL layout — the `.po` just holds the string, with
digits/placeholders left as plain ASCII per common practice in GNOME's own
Arabic translations); `hi.po` is Hindi, the language with the most native
speakers in India.

`fmt()` (in `extension.js`) fills `%s`/`%d`/`%%` placeholders strictly in the
order they appear in the *translated* string, not by a declared positional
index — there's no `%1$s`-style support. That's deliberate: it lets a
translation reorder the placeholders relative to the English source (e.g.
Turkish's `%81` puts the `%` before the number, done here by writing `%%`
before `%d` — see `tr.po`'s `"%s: %%%d kullanıldı"`), while still resolving
correctly, because reordering the *tokens* only changes which literal text
surrounds them, not which argument each one consumes. What it can't handle is
swapping which *argument* two placeholders of the same row bind to (e.g.
putting the percentage before the window name) — don't attempt that.

## Adding a new language

1. Regenerate the template if `extension.js` strings have changed since it
   was last extracted (see below), so the new `.po` starts from the current
   strings.
2. Create the translation, seeded from the template:
   ```sh
   msginit --input=po/opencodeusage@duarte.roso.pot --locale=<lang> \
       --output=po/<lang>.po
   ```
   (`<lang>` is a locale code such as `fr`, `pt_BR`, `de`.)
3. Fill in the `msgstr` entries in `po/<lang>.po`.
4. Compile and package in one step with `gnome-extensions pack`'s built-in
   podir support, which compiles every `.po` in the directory to
   `locale/<lang>/LC_MESSAGES/opencodeusage@duarte.roso.mo` inside the zip:
   ```sh
   gnome-extensions pack --podir=po .
   ```
   For local testing without repacking, compile a single file by hand:
   ```sh
   mkdir -p locale/<lang>/LC_MESSAGES
   msgfmt po/<lang>.po -o locale/<lang>/LC_MESSAGES/opencodeusage@duarte.roso.mo
   ```

## Regenerating the template

After adding, removing, or editing a translatable string in `extension.js`:

```sh
xgettext --from-code=UTF-8 --keyword=_ --keyword=N_ \
    --package-name=opencode-usage --copyright-holder="Duarte Roso" \
    --msgid-bugs-address=duarteroso@mpg.io \
    -f po/POTFILES -o po/opencodeusage@duarte.roso.pot -D .
```

Then update existing translations against the new template with
`msgmerge --update po/<lang>.po po/opencodeusage@duarte.roso.pot`, and
recompile that language's `.mo` (step 4 above) so the checked-in copy in
`locale/` stays in sync with `po/`.

## Strings not covered here

`metadata.json`'s `name` and `description` (shown in GNOME's Extensions app)
are not run through gettext by this setup and stay English-only.
