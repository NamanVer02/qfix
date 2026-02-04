This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

## Environment variables

This app uses **Google sign-in (Firebase Auth)** and **Firebase Admin** for rate limiting. Configure before running or deploying:

- Copy `.env.example` to `.env.local` and fill in:
  - **Firebase (client):** `NEXT_PUBLIC_FIREBASE_*` from your Firebase project config
  - **Firebase Admin:** `FIREBASE_SERVICE_ACCOUNT` (full service account JSON string) for server-side rate limiting
  - **Gemini:** `GEMINI_API_KEY` or `GOOGLE_API_KEY` for the tailor API

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The project is set up for Vercel:

1. **Push to GitHub** and import the repo in [Vercel](https://vercel.com/new).
2. **Environment variables:** In the Vercel project, go to **Settings → Environment Variables** and add all variables from `.env.example` (see above). For `FIREBASE_SERVICE_ACCOUNT`, paste the full JSON in one line or use multiline.
3. **Plan:** The tailor API uses Chromium for PDF generation and can run up to 60 seconds. The **Hobby** plan limits functions to 10s—if you hit timeouts, either reduce `maxDuration` in `app/api/tailor/route.ts` to `10` or use a **Pro** plan for 60s.
4. **Build:** Vercel runs `next build` by default. No extra config needed.

The app uses `@sparticuz/chromium` with `puppeteer-core` on Vercel for serverless PDF generation; locally it uses the full `puppeteer` package.
