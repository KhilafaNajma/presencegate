# PresenceGate — Netlify shared attendance

A shared, multi-browser attendance system using Netlify Functions and Netlify Blobs.

## Deploy

1. Push this folder to a GitHub repository.
2. In Netlify, choose **Add new project → Import an existing project** and select the repository.
3. Netlify reads `netlify.toml`; no build command is needed. Publish directory is `public`.
4. In **Project configuration → Environment variables**, add:
   - `ADMIN_PIN`: the private administrator PIN.
   - `SESSION_SECRET`: a random string with at least 32 characters.
5. Ensure the variables are available to Functions, then trigger a fresh production deploy.
6. Open the HTTPS site, select **Admin**, sign in, configure the event, and save it.

## Local test

1. Copy `.env.example` to `.env` and set both values.
2. Run `npm install`.
3. Run `npx netlify dev`.
4. Open the localhost address shown by Netlify CLI.

## Notes

- Attendance entries are shared across browsers because they are stored server-side.
- The admin PIN is only read inside a Netlify Function; it is not shipped in the public frontend.
- The browser's GPS can still be spoofed by a sufficiently technical user. For higher assurance, combine this with a rotating in-room code, supervised entry, NFC, or BLE.
- The application stores participant names, IDs, timestamps, and locations. Establish a retention period and tell attendees what is collected.
