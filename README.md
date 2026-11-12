# Bibliophile

A small personal app to track and document the books I read — a private, Readwise-style commonplace book.

No account needed, no build step. It's plain HTML/CSS/JS. In **personal mode** (the default) your data stays in your browser, and you can install it on your phone as an app that works offline. If you want, you can turn on **sync** to use the same library on your phone and computer, through your own free Supabase project.

## What it does

**Books**
- Library arranged **by year read** by default: *Reading now*, then each year (2026, 2025…) with its count, pages, average rating and progress towards your yearly goal, then *Want to read*, *Paused* and *Did not finish*. Filter by status or **★ 4 and up**, or switch to Recent / Title / Author / Rating / Most highlights; your choice is remembered
- Search Open Library to auto-fill the title, author, pages, year, ISBN and cover
- **Real covers, saved in the app:** each cover is downloaded once and stored in your browser, so it shows offline, won't disappear if a website changes, and appears in your year image. If Open Library has no cover, the app checks Google Books (by ISBN, then by title and author). You can also upload a photo of your own copy. *Settings → Covers → Save all covers* fills in your whole library. Tap **Choose a cover** on any book to pick from every Open Library edition and Google Books result, search Google Images and paste the picture's address, or upload your own photo. Covers are downloaded through [wsrv.nl](https://wsrv.nl), a free image relay, because Google Books and Open Library don't let web pages save their images directly. Saved covers are included in your backup file.
- **Half-star ratings** (e.g. 3.5★), plus an optional **detailed rating**: score Writing, Story & ideas, Emotional pull and Staying power from 1 to 5, and get a suggested overall rating. Stats shows your averages for each.
- Tags, format (print / ebook / audiobook), start and finish dates
- **Reading log**: record the page you're on and the minutes you read. It tracks progress and marks the book finished when you reach the last page.
- **Reviews** for each book, with writing prompts. When you finish a book, the app asks you to write a few lines while it's fresh.

**Highlights & notes** (the "Notebook")
- Save more than highlights: **quotes, notes, ideas and questions**
- **Vocabulary:** save a word with its meaning (tap *Look up* for a free dictionary definition, English only) and the sentence you found it in. Select a word inside a saved passage and tap **+ Word** to save it with that sentence, book and page filled in. In daily review, words come back as flashcards: you see the word in its sentence and try to recall the meaning.
- Each one can have a page or location, chapter, tags, a personal note and a ♥ favourite mark
- Save quotes that aren't from a book (a person, a podcast, an article, a film)
- Full-text search and filters by type, book, tag and favourites
- "Save & add another" for entering several passages in a row while you read
- **Share as image**: makes a quote card PNG in a few styles

**Daily review** (the core Readwise idea)
- A few saved passages come back to you each day, with light spaced repetition: *Again soon / Good / Much later / Retire*
- Vocabulary words show as flashcards, so you see the word before its definition
- Tracks a daily streak and shows a "passage of the day" on the home screen

**Reading timer**
- Tap **Start reading** on a book. A full-screen reading room shows the clock, and a small bar follows you around the app.
- The timer is based on timestamps, so it keeps counting if you lock your phone or close the app. **Finish & log** fills in the minutes and asks which page you reached.

**Focus blocks (Pomodoro)**
- Switch on **Focus blocks** in the reading room: read for a set time (presets 25/5, 50/10, 90/15, or your own), then a soft "ting ting ting" bell starts a short break and any music fades out. Every few blocks the break is longer.
- The big clock becomes a break countdown with *Skip break* and *Finish & log*. When the break ends, a single ting rings and the next block starts by itself (or waits, if you prefer).
- Break time is never counted as reading. If your phone was locked past the bell, only the block itself counts. With notifications allowed, you're also alerted when the app is in the background.

**Reading room sound**
- A **Sound** panel under the reading timer, with music that fades out when you pause the timer and back in when you resume (you can turn this off).
- **Calming sounds:** rain, fireplace, ocean waves, wind and soft brown noise, with sliders and presets (*Rainy evening*, *By the fire*, *Seaside*, *Deep focus*). They're generated live on your device: free, offline and never on a loop.
- **Radio:** calm free stations (SomaFM: Groove Salad, Drone Zone, Fluid, Sonic Universe; Radio Swiss Classic and Jazz) plus a search of the free [Radio Browser](https://www.radio-browser.info) directory. Save stations you like.
- **Spotify:** paste any playlist link for a simple player. With **Spotify Premium**, connect your account (Settings → Spotify, one-time setup) to play your own playlists and search for reading playlists, with full songs. Music plays in the browser on a computer, or on your phone or any device running Spotify. Your Spotify sign-in stays in your browser and is never put in backups.

**Voice, AI and sharing**
- **Dictate** reviews, passages and notes using your browser's built-in speech recognition. It's free and needs no key. When you stop speaking, what you said is **tidied automatically**: notes and reviews become clear sentences (fillers and false starts removed, nothing added), and a passage read aloud from a book only gets punctuation, so its words stay exact. **Undo** brings back exactly what you said. The tidying uses AI if you've added a key, otherwise Chrome's built-in on-device AI where available, otherwise a basic offline clean-up that understands spoken "comma", "full stop", "question mark" and "new line". You can switch this off in Settings.
- **✦ Tidy** turns a rambling voice note into a clean review and shows it next to your original before replacing anything. Without AI it does a basic clean-up (removes filler words and fixes capitals).
- **Create a post** turns a book's saved quotes, review and rating into an Instagram/Threads **caption** or a timed **reel script** (on-screen text, voiceover, music mood, hashtags). The templates are free and work offline; *Write with AI* makes richer drafts.
- **Share my year** (Stats page) makes a 1080×1920 story image: books, pages, hours, covers, favourite read and line of the year. It comes in three styles.

**Optional AI (free):** create a Gemini API key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey) and paste it in **Settings → AI assistant**. The key stays in your browser and is never included in backups. Text is sent to Google only when you press an AI button, and on the free tier Google may use it to improve its products. If a model is retired, the app switches to a current one automatically.

**Recommendations (free, no AI, no key)**
- A **Recommendations** tab that learns your taste from your ratings (half stars included), what you finished or abandoned, how much you highlighted, your favourite authors, and the themes you keep writing about in reviews, notes and tags.
- It matches those against how other readers and librarians have tagged and described books on [Open Library](https://openlibrary.org) (subjects like *grief*, *country homes*, *time travel*, *dystopias*), and how many readers have it on their shelves.
- Sections: *Top picks*, *Because you loved [book]*, *Matches what you write about*, *From authors you rate highly* and *Something different*. Every pick says why it was chosen, and you can filter by fiction, non-fiction, or under 300 pages.
- **Want to read** adds it to your shelf, **Already read** adds it and asks for a rating, and **Not for me** asks what's off (not your kind of book, read enough like it, too long, not interested) and shows fewer like it.
- Children's and young-adult books are left out unless you read them. Everything is worked out on your device; the only thing sent anywhere is book searches to Open Library. It refreshes daily and whenever your library changes, and a few picks also appear on Home.

**Stats**
- **Today:** a ring showing minutes read against your daily goal (set it in Settings), plus pages read today.
- **This year:** a ring for books against your yearly goal, pages, total time read, and whether you're ahead of or behind pace.
- **Streak:** how many days in a row you've read, with this week's days marked, and your best run.
- **Charts:** minutes per day this week (compared with last week), books finished per month, time spent reading (today, week, month, year) and your reading pace in pages per hour.
- **Your library:** what you read by genre, how your ratings spread, your detailed-score averages, what you save, how you read (print, ebook, audio), a 12-month activity grid, top authors and most-highlighted books.
- Hover over or tab to any bar for its exact value, and every chart has a "See the numbers" table.
**Import / export**
- Import **Kindle** `My Clippings.txt`. Kindle notes attach to their matching highlight.
- Import a **Readwise** CSV export or a **Goodreads** library CSV
- Duplicates are skipped, so you can re-import an updated file safely
- Back up and restore as JSON, or export everything (or a single book) as **Markdown**, which works well with Obsidian or Notion

**Account & sync (optional)**
- Personal mode is the default: no account, nothing leaves your device, and the sync code isn't even loaded.
- Turn on sync in **Settings → Account & sync** to keep your phone and computer in step. Sign in with Google or with a code sent by email. Setup takes about 15 minutes, once: see [SYNC_SETUP.md](SYNC_SETUP.md).
- **How syncing behaves:**
  - Changes sync in the background, and offline changes go up later.
  - Edits to different parts of the same book on two devices are both kept. Otherwise, the most recent change wins.
  - A safety catch pauses sync if a device suddenly seems to be missing much of your library.
- **Leaving:** sign out at any time to return to personal mode with everything kept on the device, or delete your cloud copy or whole account from Settings.
- **What stays on the device:** your Gemini key, your Spotify sign-in, and cover photos you uploaded yourself.

**Keyboard shortcuts:** `n` new highlight · `b` new book · `/` search · `r` review · `t` timer · `1`–`3` answer during review

**Home-screen shortcuts:** once installed, long-press the app icon (Android, and desktop Chrome/Edge) for *Start reading timer*, *Save a passage* and *Daily review*.

## Running it

It must be served over HTTP, because ES modules don't load from `file://`:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

### Put it on your phone (free)
1. On GitHub: **Settings → Pages → Deploy from a branch**, choose the branch and `/ (root)`.
2. Open the Pages URL on your phone, then choose **Add to Home Screen** (iOS: Share menu; Android: ⋮ menu).
3. It now opens like an app and works offline.

## About your data

Everything is stored in your browser's `localStorage` on that device. In personal mode nothing syncs: to move your library, use **Settings → Download backup** on one device and **Import** on the other. If you turn on sync, a copy is also kept in your own Supabase project (UK/EU region if you choose it), where row-level security means only your signed-in account can read it. Either way, download a backup now and then, because clearing your browser's site data deletes the copy on that device.

## Files

```
index.html            app shell
css/style.css         styles (light and dark themes)
js/store.js           data model, persistence, spaced-repetition review
js/app.js             views, forms, routing, events
js/importers.js       Kindle / Readwise / Goodreads importers
js/share.js           quote-card images and Markdown export
js/yearcard.js        "my year in books" story image
js/covers.js          cover lookup (Open Library → Google Books), saved copies, backup
js/ai.js              Gemini calls, review tidying, caption / reel templates
js/cloud.js           optional sign-in and sync (loaded only when switched on)
js/cloud-config.js    your Supabase project URL and anon key, if built in
supabase/schema.sql   the database table and security rules for sync
sw.js, manifest.webmanifest, icons/   offline support and installable app
```
