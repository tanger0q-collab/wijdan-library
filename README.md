<!-- system v0.1.0 -->
# Wijdan Study Library

Private, tablet-first study web app. The four main destinations are Current Study, Library, Notes and Settings. The original reference supplies the charcoal, grey and yellow palette, layered paper and glass navigation. The two fonts are included from Creative OS.

## Run locally

1. Install the repository dependencies, then run `npm ci` in this directory.
2. Create this directory's ignored `.dev.vars` with `STUDENT_KEY_HASH` and `OWNER_KEY_HASH`. Each is the hex SHA-256 of a separate 32-byte random Base64URL access key. Keep production keys out of the development file.
3. Run `npm run db:local`, then `npm run dev`.
4. Open the worker at port 8788. Use `/owner` for administrative access. Run `npm test` with the two development access keys in `WIJDAN_TEST_KEY` and `WIJDAN_TEST_OWNER`. The browser suite also accepts `WIJDAN_CHROME` and `WIJDAN_TEST_ORIGIN`.

## Deploy

Use the isolated `wijdan-study` Cloudflare Worker and D1 database. Build using `npm run build`. Set the production database binding in the ignored `wrangler.production.jsonc`, using `wrangler.jsonc` as a template. Apply the migration with Wrangler using the production config, then deploy with the same config. The provision script supplies hashes to Wrangler through standard input and stores the generated private access material only in the ignored `.access` directory. Restrict that directory to the owner and share only the student key with Wijdan. Resetting the student key from the owner dashboard signs out prior student sessions.

Sessions use separate student and owner roles. Study files, notes and index records are served by authenticated routes. Browser-side OCR hosts its models on the same origin. The service worker caches the shell and vendor assets only. Use Make Available Offline to cache an original file on a device and use Lock or Sign Out to clear its local copies once changes sync.

## Storage and behavior

- Original PDFs are immutable. Annotation objects, inserted images, added pages, reading position and metadata are separate. A new PDF places the edits and added pages into a copy. An annotated rotated page is rasterized in the exported copy.
- The deployed Cloudflare account has D1 enabled. The deployment stores binary objects in private D1 chunks, including range-read support, and has caps of 96 MiB per file and 350 MiB of binary objects. Database and daily request limits still apply. The worker can also accept an R2 FILES binding when provisioned.
- Optional R2 setup is documented in `wrangler.r2.example.jsonc`. Copy only its `r2_buckets` entry into the intended environment after provisioning a private bucket. Without `FILES`, the existing private D1 chunk store remains the automatic fallback.
- Ask Library returns supporting excerpts from the library index with source and page. It does not send study content to a model provider.
- The library processes PDF/OCR jobs on the signed-in device. The student session must remain open while the queue processes. Owners can requeue failures.
- The owner can download metadata snapshots. Students can export metadata and binary assets together through Export Data. The Cloudflare database also has platform point-in-time recovery.
- Physical Huawei stylus/palm rejection, OS camera picker behavior and native printing require device checks. Browser tests cover a simulated stylus and screen dimensions.
