# Setting up sync (optional)

Bibliophile works fully without any of this. Personal mode is the default: no account, and your library stays on your device.

Sync is for when you want the same library on your phone and your computer. It uses your own free [Supabase](https://supabase.com) project, a hosted database that only you control. You set it up once, which takes about 15 minutes. The same project will later power book clubs with friends.

You'll need the address of your Bibliophile app, for example `https://sushmit2701.github.io/bibliophile/`. Below, this is called **your app address**.

## 1. Create the project (5 min)

1. Go to [supabase.com](https://supabase.com) and sign up. The free plan is enough.
2. Click **New project**.
   - **Name:** `bibliophile`
   - **Database password:** click *Generate* and save it in your password manager. The app doesn't need it.
   - **Region:** choose **London** (or another European region) so your data stays in the UK or EU.
3. Wait a minute or two while the project starts.

## 2. Create the sync table (1 min)

1. In the left sidebar, open **SQL Editor** and choose **New query**.
2. Open [`supabase/schema.sql`](supabase/schema.sql) from this repository, copy all of it, and paste it in.
3. Click **Run**. You should see *Success. No rows returned.*

This creates:
- the sync table, where each row belongs to one signed-in person, and *row-level security* makes sure each person can only ever read or change their own rows
- the book club tables, which can only be reached through functions that check you're a member first

**When the app is updated** with new features (for example, the next book club steps), run the latest `schema.sql` again the same way. It's safe to re-run, and it never deletes your data.

## 3. Tell Supabase where the app lives (2 min)

Open **Authentication → URL Configuration**:

- **Site URL:** your app address.
- **Redirect URLs:** add your app address followed by `**`, for example `https://sushmit2701.github.io/bibliophile/**`.
  - If you also run the app on your computer, add `http://localhost:8000/**` too.

## 4. Let the sign-in email include a code (2 min)

Signing in by email sends a link. On a phone, that link often opens in your email app's own browser rather than in the installed Bibliophile app, so a typed code is easier.

1. Open **Authentication → Emails** (it may be called *Email Templates*) and choose the **Magic link** template.
2. Add this line to the message body, for example just above the link:

   ```html
   <p>Your Bibliophile code: <strong>{{ .Token }}</strong></p>
   ```

3. Click **Save**.

> **Email limits.** Supabase's built-in email sender is for testing and only sends a few emails an hour. That's fine for you alone, especially once you're signed in on each device. Before inviting friends, connect a free email service such as [Resend](https://resend.com) under **Authentication → Emails → SMTP settings**. Google sign-in has no such limit.

## 5. Optional: "Continue with Google" (5–10 min)

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create a project called *Bibliophile*.
2. Open **APIs & Services → OAuth consent screen**, which Google may now call *Google Auth Platform → Branding*:
   - User type: **External**.
   - App name: *Bibliophile*.
   - Support email and developer contact: your own email.
   - Save. You can leave the app in *Testing* and add yourself (and later your friends) under **Test users**, or publish it. Publishing the basic email-and-profile sign-in doesn't need Google's review.
3. Open **Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**.
   - **Authorized JavaScript origins:** your app address without the path, for example `https://sushmit2701.github.io`.
   - **Authorized redirect URIs:** `https://YOUR-PROJECT-REF.supabase.co/auth/v1/callback`. Supabase shows this exact address on its Google provider page.
   - Copy the **Client ID** and **Client secret**.
4. Back in Supabase, open **Authentication → Sign In / Providers → Google**:
   - Turn it on.
   - Paste the Client ID and Client secret.
   - Save.

The **Continue with Google** button appears in the app automatically once Google is switched on.

## 6. Connect the app (1 min)

In Supabase, open **Project Settings → API Keys** (or **Data API**) and copy:

- the **Project URL**, for example `https://abcdefghijklmnop.supabase.co`
- the **anon public** key. Newer projects call it the **publishable** key, and it starts with `sb_publishable_`.

**Never** use the `service_role` or *secret* key in the app.

You can connect the app in either of two ways:

- **Quickest:** in Bibliophile, open **Settings → Account & sync → Set up sync…**, paste both values, and save. Do this once on each device.
- **Built in:** put both values in [`js/cloud-config.js`](js/cloud-config.js). Every device, and every friend, then gets sync without pasting anything.
  - The anon key is designed to be public. What protects your data is the row-level security from step 2, not secrecy.

Then sign in. The first time, the library on that device is combined with anything already in your account, and nothing is lost. Do the same on your other devices.

## How it behaves

- **Background sync:** changes sync a few seconds after you make them, when you open the app, and every minute while it's open. Offline changes wait and go up when you're back online.
- **Edits on two devices:** if the same book was edited on two devices, both changes are kept when they touched different things, for example a rating on one and a review on the other. If both devices changed the same thing, the more recent change wins.
- **Safety catch:** if a device suddenly seems to be missing a large part of your library, for example because its browser storage was cleared, sync pauses and asks first. You can then restore everything from your other devices.
- **What stays on the device:**
  - Your Gemini key and Spotify sign-in.
  - Cover photos you uploaded yourself. Covers found online appear everywhere.
- **Signing out:** everything stays on the device and you're back in personal mode. **Delete my data** in Settings removes your cloud copy, or your whole account.

## Book clubs

Once you're signed in, a **Book club** tab appears. Start a club, then send its invite link to friends. Clubs hold up to 10 people.

For friends to join, their copy of the app must be connected to **your** Supabase project. The easy way is to build your project details into `js/cloud-config.js` (step 6), so that everyone who opens your app address is ready to go. Friends sign in with their own Google account or email. They never see your library, only what you choose to share with the club.

## Good to know

- **Inactivity:** Supabase pauses free projects after about a week with no activity. Using the app on most days keeps it awake. If it does pause, open the Supabase dashboard and click **Restore project**. Your data is kept, and the app keeps working offline meanwhile.
- **Backups:** the free plan has no downloadable backups, so keep using **Settings → Download backup** now and then.
- **iPhone:** **Sign in with Apple** isn't needed for a personal web app. It's planned before Bibliophile goes into the App Store.
