# Bibliophile

A small personal app to track and document the books I read — a private, Readwise-style commonplace book.

No accounts, no server, no build step. It's plain HTML/CSS/JS. Your data stays in your browser, and you can install it on your phone as an app that works offline.

## What it does

**Books**
- Library with shelves: *Want to read · Reading · Finished · Paused · Did not finish*
- Search Open Library to auto-fill the title, author, pages, year, ISBN and cover
- **Real covers, saved in the app:** each cover is downloaded once and stored in your browser, so it shows offline, won't disappear if a website changes, and appears in your year image. If Open Library has no cover, the app checks Google Books (by ISBN, then by title and author). You can also upload a photo of your own copy. *Settings → Covers → Save all covers* fills in your whole library. Covers are downloaded through [wsrv.nl](https://wsrv.nl), a free image relay, because Google Books and Open Library don't let web pages save their images directly. Saved covers are included in your backup file.
- **Half-star ratings** (e.g. 3.5★), plus an optional **detailed rating**: score Writing, Story & ideas, Emotional pull and Staying power from 1 to 5, and get a suggested overall rating. Stats shows your averages for each.
- Tags, format (print / ebook / audiobook), start and finish dates
- **Reading log**: record the page you're on and the minutes you read. It tracks progress and marks the book finished when you reach the last page.
- **Reviews** for each book, with writing prompts. When you finish a book, the app asks you to write a few lines while it's fresh.

**Highlights & notes** (the "Notebook")
- Save more than highlights: **quotes, notes, ideas, questions and vocabulary words** (a word with its definition)
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

**Voice, AI and sharing**
- **Dictate** reviews, passages and notes using your browser's built-in speech recognition. It's free and needs no key.
- **✦ Tidy** turns a rambling voice note into a clean review and shows it next to your original before replacing anything. Without AI it does a basic clean-up (removes filler words and fixes capitals).
- **Create a post** turns a book's saved quotes, review and rating into an Instagram/Threads **caption** or a timed **reel script** (on-screen text, voiceover, music mood, hashtags). The templates are free and work offline; *Write with AI* makes richer drafts.
- **Share my year** (Stats page) makes a 1080×1920 story image: books, pages, hours, covers, favourite read and line of the year. It comes in three styles.

**Optional AI (free):** create a Gemini API key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey) and paste it in **Settings → AI assistant**. The key stays in your browser and is never included in backups. Text is sent to Google only when you press an AI button, and on the free tier Google may use it to improve its products. If a model is retired, the app switches to a current one automatically.

**Stats**
- Yearly reading goal, and whether you're ahead of or behind pace
- Activity heatmap, books per year, pages read, average rating, most-read authors and most-highlighted books

**Import / export**
- Import **Kindle** `My Clippings.txt`. Kindle notes attach to their matching highlight.
- Import a **Readwise** CSV export or a **Goodreads** library CSV
- Duplicates are skipped, so you can re-import an updated file safely
- Back up and restore as JSON, or export everything (or a single book) as **Markdown**, which works well with Obsidian or Notion

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

Everything is stored in your browser's `localStorage` on that device only. Data doesn't sync between your phone and laptop. To move it, use **Settings → Download backup** on one device and **Import** on the other. Download a backup now and then, because clearing your browser's site data deletes it.

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
sw.js, manifest.webmanifest, icons/   offline support and installable app
```
